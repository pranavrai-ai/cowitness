import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react'

const refresh = vi.fn()
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh }) }))
vi.mock('./snap-upload.js', () => ({ postSnap: vi.fn() }))
vi.mock('./voice-snap.js', () => ({ sendVoiceSnap: vi.fn() }))
vi.mock('./voice-note.js', () => ({
  VoiceNote: ({ onRecorded }: { onRecorded(r: { blob: Blob; durationSec: number; id: string }): void }) => (
    <button type="button" onClick={() => onRecorded({ blob: new Blob(['ab'], { type: 'audio/mp4' }), durationSec: 7, id: 'r-heldheld' })}>Done recording</button>
  ),
}))
vi.mock('./recording-vault.js', async (orig) => ({
  ...(await orig<typeof import('./recording-vault.js')>()),
  indexedDbVault: () => null, forget: vi.fn(async () => {}), keepMeta: vi.fn(async () => {}),
}))
vi.mock('./dual-camera.js', () => ({ openStream: vi.fn(async () => ({}) as MediaStream) }))
vi.mock('./snap-camera.js', () => ({
  SnapCamera: ({ onCapture, onPickInstead }: { onCapture(f: File): void; onPickInstead(): void }) => (
    <div>
      <button type="button" onClick={() => onCapture(new File(['c'], 'snap.jpg', { type: 'image/jpeg' }))}>Use it</button>
      <button type="button" onClick={onPickInstead}>Choose a photo instead</button>
    </div>
  ),
}))

import { AddSnap } from './add-snap.js'
import { postSnap } from './snap-upload.js'
import { openStream } from './dual-camera.js'
import { clientConfig, configure } from './config.js'
import { sendVoiceSnap } from './voice-snap.js'
import { forget } from './recording-vault.js'

const pick = (file: File) => fireEvent.change(screen.getByLabelText('Choose a photo'), { target: { files: [file] } })
const jpg = (name: string) => new File([name], name, { type: 'image/jpeg' })
const pickMany = (...files: File[]) => fireEvent.change(screen.getByLabelText('Choose a photo'), { target: { files } })
const send = () => act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Send' })) })

beforeEach(() => {
  URL.createObjectURL = vi.fn(() => 'blob:preview')
  URL.revokeObjectURL = vi.fn()
})

describe('AddSnap', () => {
  it('opens the picker for one photo or video, then a sheet with a caption and Send', async () => {
    render(<AddSnap />)
    const input = screen.getByLabelText('Choose a photo') as HTMLInputElement
    expect(input.multiple).toBe(false)
    expect(input.accept).toBe('image/*')
    expect((screen.getByLabelText('Choose a video') as HTMLInputElement).accept).toBe('video/*')
    pick(new File(['x'], 'a.jpg', { type: 'image/jpeg' }))
    expect(screen.getByRole('dialog', { name: 'New snap' })).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText('Caption'), { target: { value: 'the view' } })
    vi.mocked(postSnap).mockResolvedValue()
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Send' })) })
    expect(postSnap).toHaveBeenCalledWith(expect.any(File), 'the view', expect.objectContaining({ composed: false }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(refresh).toHaveBeenCalled()
  })

  it('keeps the sheet and the caption when a send fails, and says so', async () => {
    render(<AddSnap />)
    pick(new File(['x'], 'a.jpg', { type: 'image/jpeg' }))
    fireEvent.change(screen.getByLabelText('Caption'), { target: { value: 'keep me' } })
    vi.mocked(postSnap).mockRejectedValue(new Error('upload failed'))
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Send' })) })
    expect(screen.getByText('Not sent. Try again.')).toBeInTheDocument()
    expect(screen.getByLabelText('Caption')).toHaveValue('keep me')
  })

  it('Send again after a failed filing files what was already stored, instead of uploading it twice', async () => {
    render(<AddSnap />)
    pick(new File(['x'], 'a.jpg', { type: 'image/jpeg' }))
    vi.mocked(postSnap).mockReset()
    vi.mocked(postSnap).mockImplementationOnce(async (_f, _c, opts) => { opts?.onSent?.({ kind: 'photo', photoId: 'p1' }); throw new Error('filing lost') })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Send' })) })
    vi.mocked(postSnap).mockResolvedValueOnce()
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Send' })) })
    expect(vi.mocked(postSnap).mock.calls[1][2]).toMatchObject({ sent: { kind: 'photo', photoId: 'p1' } })
  })

  it('a different pick starts clean, with nothing stored to reuse', async () => {
    render(<AddSnap />)
    pick(new File(['x'], 'a.jpg', { type: 'image/jpeg' }))
    vi.mocked(postSnap).mockReset()
    vi.mocked(postSnap).mockImplementationOnce(async (_f, _c, opts) => { opts?.onSent?.({ kind: 'photo', photoId: 'p1' }); throw new Error('filing lost') })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Send' })) })
    pick(new File(['y'], 'b.jpg', { type: 'image/jpeg' }))
    vi.mocked(postSnap).mockResolvedValueOnce()
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Send' })) })
    expect(vi.mocked(postSnap).mock.calls[1][2]?.sent).toBeUndefined()
  })

  it('asks for the back camera inside the tap, and sends what the camera composed', async () => {
    render(<AddSnap />)
    expect(screen.queryByRole('button', { name: 'Use it' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Double camera photo' }))
    expect(openStream).toHaveBeenCalledWith('user')
    fireEvent.click(screen.getByRole('button', { name: 'Use it' }))
    expect(screen.getByRole('dialog', { name: 'New snap' })).toBeInTheDocument()
    vi.mocked(postSnap).mockResolvedValue()
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Send' })) })
    expect(postSnap).toHaveBeenCalledWith(expect.any(File), '', expect.objectContaining({ composed: true }))
  })

  it('falls back to the library when there is no camera to open', () => {
    const click = vi.spyOn(HTMLInputElement.prototype, 'click').mockImplementation(() => {})
    render(<AddSnap />)
    fireEvent.click(screen.getByRole('button', { name: 'Double camera photo' }))
    fireEvent.click(screen.getByRole('button', { name: 'Choose a photo instead' }))
    expect(click).toHaveBeenCalled()
    expect(screen.queryByRole('button', { name: 'Choose a photo instead' })).toBeNull()
    click.mockRestore()
  })
})

describe('AddSnap with options', () => {
  // The configuration every test starts from, restored after each so the options never leak.
  const base = clientConfig()
  const withOptions = (features: Parameters<typeof configure>[0]['features']) => configure({ ...base, features })
  afterEach(() => configure(base))

  it('offers exactly what 0.1.3 offered with the options off', () => {
    configure(base)
    render(<AddSnap />)
    expect(screen.getByRole('button', { name: 'Double camera photo' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Voice note' })).toBeNull()
    pick(new File(['x'], 'a.jpg', { type: 'image/jpeg' }))
    expect(screen.queryByRole('switch', { name: 'Just us' })).toBeNull()
    expect(screen.queryByLabelText('Tag')).toBeNull()
  })
  it('drops the double camera, offers a voice note, and shows "just us" and the tag picker on the sheet', () => {
    withOptions({ doubleCamera: false, voiceSnaps: true, justUs: true, tags: true })
    render(<AddSnap shares tagChoices={[{ id: 't-first', label: 'First' }]} />)
    expect(screen.queryByRole('button', { name: 'Double camera photo' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Voice note' })).toBeInTheDocument()
    pick(new File(['x'], 'a.jpg', { type: 'image/jpeg' }))
    expect(screen.getByRole('switch', { name: 'Just us' })).toHaveAttribute('aria-checked', 'false')
    expect(screen.getByLabelText('Tag')).toBeInTheDocument()
  })
  it('shows each switch only when its own option is on', () => {
    withOptions({ justUs: true })
    const { unmount } = render(<AddSnap shares tagChoices={[{ id: 't-first', label: 'First' }]} />)
    pick(new File(['x'], 'a.jpg', { type: 'image/jpeg' }))
    expect(screen.getByRole('switch', { name: 'Just us' })).toBeInTheDocument()
    expect(screen.queryByLabelText('Tag')).toBeNull()
    unmount()
    withOptions({ tags: true })
    render(<AddSnap tagChoices={[{ id: 't-first', label: 'First' }]} />)
    pick(new File(['x'], 'a.jpg', { type: 'image/jpeg' }))
    expect(screen.queryByRole('switch', { name: 'Just us' })).toBeNull()
    expect(screen.getByLabelText('Tag')).toBeInTheDocument()
  })
  it('files a photo with "just us" and its tag when they are chosen', async () => {
    withOptions({ justUs: true, tags: true })
    render(<AddSnap shares tagChoices={[{ id: 't-first', label: 'First' }]} />)
    pick(new File(['x'], 'a.jpg', { type: 'image/jpeg' }))
    fireEvent.click(screen.getByRole('switch', { name: 'Just us' }))
    fireEvent.change(screen.getByLabelText('Tag'), { target: { value: 't-first' } })
    vi.mocked(postSnap).mockResolvedValue()
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Send' })) })
    expect(postSnap).toHaveBeenCalledWith(expect.any(File), '', expect.objectContaining({ extra: { justUs: true, tags: ['t-first'] } }))
  })
  it('records a voice note, shows its length, and sends it as a snap with what was chosen', async () => {
    withOptions({ voiceSnaps: true, justUs: true })
    render(<AddSnap shares languages={['en', 'fr']} />)
    fireEvent.click(screen.getByRole('button', { name: 'Voice note' }))
    fireEvent.click(screen.getByRole('button', { name: 'Done recording' }))
    expect(screen.getByRole('dialog', { name: 'New snap' })).toBeInTheDocument()
    expect(screen.getByText('0:07')).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText('Language'), { target: { value: 'fr' } })
    fireEvent.click(screen.getByRole('switch', { name: 'Just us' }))
    vi.mocked(sendVoiceSnap).mockResolvedValue({} as never)
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Send' })) })
    expect(sendVoiceSnap).toHaveBeenCalledWith(expect.any(Blob), 7, 'r-heldheld', { caption: '', language: 'fr', justUs: true }, expect.objectContaining({ onNewId: expect.any(Function) }))
    expect(screen.queryByRole('dialog', { name: 'New snap' })).toBeNull()
  })
  it('keeps the sheet and says so when a voice note does not send', async () => {
    withOptions({ voiceSnaps: true })
    render(<AddSnap />)
    fireEvent.click(screen.getByRole('button', { name: 'Voice note' }))
    fireEvent.click(screen.getByRole('button', { name: 'Done recording' }))
    vi.mocked(sendVoiceSnap).mockRejectedValue(new Error('offline'))
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Send' })) })
    expect(screen.getByText('Not sent. Try again.')).toBeInTheDocument()
  })
  it('offers "just us" only to a person who shares, since anyone else would be refused it', () => {
    withOptions({ justUs: true })
    render(<AddSnap />)
    pick(new File(['x'], 'a.jpg', { type: 'image/jpeg' }))
    expect(screen.queryByRole('switch', { name: 'Just us' })).toBeNull()
  })
  it('forgets a recorded voice note the person closes without sending, so nothing publishes it later', async () => {
    withOptions({ voiceSnaps: true })
    render(<AddSnap />)
    fireEvent.click(screen.getByRole('button', { name: 'Voice note' }))
    fireEvent.click(screen.getByRole('button', { name: 'Done recording' }))
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Close' })) })
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'New snap' })).toBeNull())
    expect(forget).toHaveBeenCalledWith(expect.anything(), 'r-heldheld')
  })
  it('keeps a voice note whose send failed when the sheet is closed, so it is sent on the next visit', async () => {
    withOptions({ voiceSnaps: true })
    render(<AddSnap />)
    fireEvent.click(screen.getByRole('button', { name: 'Voice note' }))
    fireEvent.click(screen.getByRole('button', { name: 'Done recording' }))
    vi.mocked(sendVoiceSnap).mockRejectedValue(new Error('offline'))
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Send' })) })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Close' })) })
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'New snap' })).toBeNull())
    expect(forget).not.toHaveBeenCalled()
  })
})


describe('AddSnap with several photos', () => {
  const base = clientConfig()
  beforeEach(() => { vi.mocked(postSnap).mockReset(); refresh.mockClear(); configure({ ...base, features: { multiPhoto: true } }) })
  afterEach(() => configure(base))

  it('is off unless the app turns it on: one photo, whatever the picker reports', () => {
    configure(base)
    render(<AddSnap />)
    expect((screen.getByLabelText('Choose a photo') as HTMLInputElement).multiple).toBe(false)
    pickMany(jpg('a.jpg'), jpg('b.jpg'))
    expect(screen.getByRole('dialog', { name: 'New snap' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^Remove / })).toBeNull()
  })

  it('lets the photo picker take several, and the video picker only one', () => {
    render(<AddSnap />)
    expect((screen.getByLabelText('Choose a photo') as HTMLInputElement).multiple).toBe(true)
    expect((screen.getByLabelText('Choose a video') as HTMLInputElement).multiple).toBe(false)
  })

  it('shows every picked photo with a way to take one out, under one caption', () => {
    render(<AddSnap />)
    pickMany(jpg('a.jpg'), jpg('b.jpg'), jpg('c.jpg'))
    expect(screen.getByRole('dialog', { name: '3 photos' })).toBeInTheDocument()
    expect(screen.getAllByRole('button', { name: /^Remove / })).toHaveLength(3)
    expect(screen.getAllByLabelText('Caption')).toHaveLength(1)
    fireEvent.click(screen.getByRole('button', { name: 'Remove b.jpg' }))
    expect(screen.getAllByRole('button', { name: /^Remove / })).toHaveLength(2)
    expect(screen.getByRole('dialog', { name: '2 photos' })).toBeInTheDocument()
  })

  it('files each photo as its own snap, in the order picked, with the same caption and choices', async () => {
    render(<AddSnap tagChoices={[{ id: 'first-smile', label: 'First smile' }]} shares />)
    pickMany(jpg('a.jpg'), jpg('b.jpg'), jpg('c.jpg'))
    fireEvent.change(screen.getByLabelText('Caption'), { target: { value: 'at the park' } })
    vi.mocked(postSnap).mockResolvedValue()
    await send()
    const calls = vi.mocked(postSnap).mock.calls
    expect(calls.map((c) => (c[0] as File).name)).toEqual(['a.jpg', 'b.jpg', 'c.jpg'])
    expect(calls.every((c) => c[1] === 'at the park')).toBe(true)
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(refresh).toHaveBeenCalledTimes(1)
  })

  it('sends one photo at a time', async () => {
    render(<AddSnap />)
    pickMany(jpg('a.jpg'), jpg('b.jpg'))
    let release: () => void = () => {}
    vi.mocked(postSnap).mockImplementation(() => new Promise<void>((r) => { release = r }))
    await send()
    expect(postSnap).toHaveBeenCalledTimes(1)
    expect(screen.getByText('Sending 1 of 2')).toBeInTheDocument()
    await act(async () => { release() })
    expect(postSnap).toHaveBeenCalledTimes(2)
    expect(screen.getByText('Sending 2 of 2')).toBeInTheDocument()
    await act(async () => { release() })
  })

  it('when one fails, keeps it and the rest, drops the ones already sent, and retries only those', async () => {
    render(<AddSnap />)
    pickMany(jpg('a.jpg'), jpg('b.jpg'), jpg('c.jpg'))
    vi.mocked(postSnap)
      .mockResolvedValueOnce()
      .mockImplementationOnce(async (_f, _c, opts) => { opts?.onSent?.({ kind: 'photo', photoId: 'p2' }); throw new Error('filing lost') })
    await send()
    expect(screen.getByText('1 of 3 sent. Try again.')).toBeInTheDocument()
    expect(screen.getAllByRole('button', { name: /^Remove / })).toHaveLength(2)
    expect(screen.queryByRole('button', { name: 'Remove a.jpg' })).toBeNull()
    expect(refresh).toHaveBeenCalledTimes(1)
    vi.mocked(postSnap).mockResolvedValue()
    await send()
    const calls = vi.mocked(postSnap).mock.calls
    expect(calls).toHaveLength(4)
    expect((calls[2][0] as File).name).toBe('b.jpg')
    expect(calls[2][2]).toMatchObject({ sent: { kind: 'photo', photoId: 'p2' } })
    expect((calls[3][0] as File).name).toBe('c.jpg')
    expect(calls[3][2]?.sent).toBeUndefined()
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  })

  it('keeps the first ten of a bigger pick and says so', () => {
    render(<AddSnap />)
    pickMany(...Array.from({ length: 12 }, (_, i) => jpg(`p${i}.jpg`)))
    expect(screen.getAllByRole('button', { name: /^Remove / })).toHaveLength(10)
    expect(screen.getByText('Up to 10 at a time')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Remove p10.jpg' })).toBeNull()
  })

  it('a single photo still reads as a new snap, with no strip of its own to manage', () => {
    render(<AddSnap />)
    pickMany(jpg('only.jpg'))
    expect(screen.getByRole('dialog', { name: 'New snap' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^Remove / })).toBeNull()
  })

  it('a video pick is still one at a time and replaces any photos', () => {
    render(<AddSnap />)
    pickMany(jpg('a.jpg'), jpg('b.jpg'))
    fireEvent.change(screen.getByLabelText('Choose a video'), { target: { files: [new File(['v'], 'v.mp4', { type: 'video/mp4' })] } })
    expect(screen.getByRole('dialog', { name: 'New snap' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^Remove / })).toBeNull()
  })
})
