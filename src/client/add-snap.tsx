'use client'

import { useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { SNAP_CAPTION_MAX } from '../snap-rules.js'
import { BottomSheet } from './bottom-sheet.js'
import { PhotoInput } from './photo-input.js'
import { SnapCamera } from './snap-camera.js'
import { openStream } from './dual-camera.js'
import { askForMotion } from './upright.js'
import { PickedPreview } from './picked-preview.js'
import { postSnap, type SentSnap } from './snap-upload.js'
import type { TagChoice } from '../types.js'
import { clientFeatures } from './config.js'
import { VoiceNote } from './voice-note.js'
import { sendVoiceSnap, voiceSnapKey } from './voice-snap.js'
import { formatClock } from './recorder.js'
import { forget, indexedDbVault, keepMeta, keepNoteId, memoryVault } from './recording-vault.js'
import { DANGER, HAIRLINE, INK, MUTED, ON_INK, PLACEHOLDER, SERIF } from './theme.js'

// Photos can be picked several at a time, up to this many, and go out as separate snaps under one
// caption. Video, the two-shot camera and a voice note stay one snap at a time.
export const MAX_PHOTOS_PER_SEND = 10

// Two ways to a snap and one way to send it. Take a snap opens the camera and Choose a photo
// opens the library; both happen inside the tap, or iOS refuses them. Either one ends as a file,
// and the sheet rises on the file, for an optional caption and Send. Each option the app turned on
// adds its own piece (a voice note, "just us", a tag) and with every option off nothing is added.
// "Just us" is offered only to a person the app says shares (`shares`), because the server refuses it
// from anyone else.
export function AddSnap({ tagChoices = [], languages, shares = false }: { tagChoices?: TagChoice[]; languages?: readonly string[]; shares?: boolean } = {}) {
  const router = useRouter()
  const f = clientFeatures()
  const [justUs, setJustUs] = useState(false)
  const [tag, setTag] = useState('')
  const [voice, setVoice] = useState<{ blob: Blob; durationSec: number; id: string } | null>(null)
  const [recording, setRecording] = useState(false)
  const [language, setLanguage] = useState('auto')
  // A voice note whose send failed is held for the next visit, with what was typed for it. One that
  // was never sent is not: closing the sheet throws it away.
  const heldForResend = useRef(false)
  const photos = useRef<HTMLInputElement>(null)
  const videos = useRef<HTMLInputElement>(null)
  const [files, setFiles] = useState<File[]>([])
  const [note, setNote] = useState('')
  // How many of this pick are filed, and how many there were: kept across a failed Send so the
  // retry carries on from where it stopped.
  const [filed, setFiled] = useState(0)
  const batch = useRef(0)
  const [caption, setCaption] = useState('')
  const [state, setState] = useState<'idle' | 'sending' | 'failed'>('idle')
  // The back camera, asked for in the tap that opens the capture layer. Null: the layer is shut.
  const [camera, setCamera] = useState<Promise<MediaStream> | null>(null)
  const [progress, setProgress] = useState(0)
  // What an earlier Send of this same pick already stored, so trying again files it rather than
  // uploading it twice. A new pick, or closing the sheet, forgets it.
  const sent = useRef(new Map<File, SentSnap>())
  // Bytes the capture layer drew are already a normalized jpeg; running them through the upload
  // path's re-encode would be a second lossy generation on pixels that have been through one.
  const drawn = useRef(false)

  // Everything the camera needs a gesture for happens here, the way the microphone is asked for
  // in the Witness tap: the permission and the stream both belong to this tap, not to an effect.
  // The FRONT camera opens first, because the selfie is the first of the two shots.
  // The motion sensor is asked for in the same tap: it is how a landscape snap comes out landscape.
  const openCamera = () => {
    void askForMotion()
    const opening = openStream('user')
    opening.catch(() => {})
    setCamera(opening)
  }

  // A snap the camera composed goes to the same sheet a picked photo goes to, with nothing
  // stored yet to reuse.
  const start = (next: File[], composed: boolean) => {
    sent.current = new Map(); drawn.current = composed; batch.current = next.length; setFiled(0); setFiles(next)
  }
  const captured = (taken: File) => { setCamera(null); setNote(''); start([taken], true) }

  const picked = (list: File[]) => { setNote(''); start(list.slice(0, 1), false) }
  const pickedPhotos = (list: File[]) => {
    const room = f.multiPhoto ? MAX_PHOTOS_PER_SEND : 1
    setNote(list.length > room && f.multiPhoto ? `Up to ${MAX_PHOTOS_PER_SEND} at a time` : '')
    start(list.slice(0, room), false)
  }
  const take = (out: File) => {
    sent.current.delete(out)
    setFiles((prev) => prev.filter((x) => x !== out))
    batch.current = Math.max(batch.current - 1, 0)
  }

  const pickInstead = () => { setCamera(null); photos.current?.click() }

  const close = () => {
    setFiles([]); setNote(''); setFiled(0); batch.current = 0; setCaption(''); setState('idle'); setProgress(0); sent.current = new Map(); drawn.current = false
    if (voice && !heldForResend.current) void forget(indexedDbVault() ?? memoryVault(), voice.id).catch(() => {})
    heldForResend.current = false
    setVoice(null); setJustUs(false); setTag('')
  }

  // A voice note is already held in the phone's vault; what was typed for it is kept beside it
  // before the send, so a send that fails is resent later as it was meant. Let go once filed.
  const sendVoice = async (v: { blob: Blob; durationSec: number; id: string }, extra: { justUs?: boolean; tags?: string[] }) => {
    const store = indexedDbVault() ?? memoryVault()
    const meta = { caption, language, ...extra }
    await keepMeta(store, v.id, meta)
    await sendVoiceSnap(v.blob, v.durationSec, v.id, meta, { onNewId: (fresh) => keepNoteId(store, v.id, voiceSnapKey(fresh)) })
    await forget(store, v.id)
  }

  const send = async () => {
    if ((files.length === 0 && !voice) || state === 'sending') return
    setState('sending')
    const extra = { ...(justUs ? { justUs: true } : {}), ...(tag ? { tags: [tag] } : {}) }
    let landed = 0
    try {
      if (voice) await sendVoice(voice, extra)
      else {
        // One at a time, in the order picked: a weak connection fails one photo, not all of them.
        // A photo that is filed leaves the sheet, so a failure leaves exactly what is still to send.
        for (const file of files) {
          setProgress(0)
          await postSnap(file, caption, {
            onProgress: setProgress, composed: drawn.current,
            ...(sent.current.has(file) ? { sent: sent.current.get(file)! } : {}),
            onSent: (s) => { sent.current.set(file, s) },
            ...(Object.keys(extra).length ? { extra } : {}),
          })
          landed += 1
          setFiled((n) => n + 1)
          setFiles((prev) => prev.filter((x) => x !== file))
        }
      }
      close()
      router.refresh()
    } catch {
      if (voice) heldForResend.current = true
      if (landed > 0) router.refresh()
      setState('failed')
    }
  }

  const many = batch.current > 1
  const failedText = filed > 0 ? `${filed} of ${batch.current} sent. Try again.` : 'Not sent. Try again.'
  const sendingText = many ? `Sending ${filed + 1} of ${batch.current}` : progress > 0 ? `Sending ${Math.round(progress * 100)}%` : ''

  return (
    <>
      <div className="mx-4 flex flex-col gap-3">
        {f.doubleCamera && <button
          type="button"
          onClick={openCamera}
          className="flex h-14 items-center justify-center rounded-2xl text-[17px] font-medium transition-transform duration-150 ease-out active:scale-[0.98] motion-reduce:transition-none"
          style={{ backgroundColor: INK, color: ON_INK }}
        >
          Double camera photo
        </button>}
        <div className="flex gap-3">
          <button
            type="button"
            onClick={() => photos.current?.click()}
            className="flex h-12 flex-1 items-center justify-center rounded-2xl text-[15px] transition-transform duration-150 ease-out active:scale-[0.98] motion-reduce:transition-none"
            style={{ color: INK, border: `1px solid ${HAIRLINE}` }}
          >
            Photo
          </button>
          <button
            type="button"
            onClick={() => videos.current?.click()}
            className="flex h-12 flex-1 items-center justify-center rounded-2xl text-[15px] transition-transform duration-150 ease-out active:scale-[0.98] motion-reduce:transition-none"
            style={{ color: INK, border: `1px solid ${HAIRLINE}` }}
          >
            Video
          </button>
          {f.voiceSnaps && (
            <button
              type="button"
              onClick={() => setRecording(true)}
              className="flex h-12 flex-1 items-center justify-center rounded-2xl text-[15px] transition-transform duration-150 ease-out active:scale-[0.98] motion-reduce:transition-none"
              style={{ color: INK, border: `1px solid ${HAIRLINE}` }}
            >
              Voice note
            </button>
          )}
        </div>
      </div>
      {camera && (
        <SnapCamera stream={camera} onCapture={captured} onClose={() => setCamera(null)} onPickInstead={pickInstead} />
      )}
      <PhotoInput ref={photos} label="Choose a photo" accept="image/*" multiple={f.multiPhoto} onFiles={pickedPhotos} />
      <PhotoInput ref={videos} label="Choose a video" accept="video/*" multiple={false} onFiles={picked} />
      {recording && (
        <BottomSheet title="Voice note" onClose={() => setRecording(false)}>
          <VoiceNote onCancel={() => setRecording(false)} onRecorded={(r) => { setRecording(false); sent.current = new Map(); heldForResend.current = false; setVoice(r) }} />
        </BottomSheet>
      )}
      {(files.length > 0 || voice) && (
        <BottomSheet title={files.length > 1 ? `${files.length} photos` : 'New snap'} onClose={close} locked={state === 'sending'}>
          {files.length > 1 ? (
            <ul className="mt-3 flex gap-2 overflow-x-auto pb-1">
              {files.map((file, i) => (
                <li key={`${i}-${file.name}-${file.lastModified}`} className="relative aspect-square w-20 shrink-0 overflow-hidden rounded-xl" style={{ backgroundColor: HAIRLINE }}>
                  <PickedPreview photo={{ id: `snap-${i}`, file }} />
                  <button
                    type="button" aria-label={`Remove ${file.name}`} disabled={state === 'sending'} onClick={() => take(file)}
                    className="absolute right-1 top-1 flex h-7 w-7 items-center justify-center rounded-full bg-black/55 text-sm text-white disabled:opacity-40"
                  >
                    ×
                  </button>
                </li>
              ))}
            </ul>
          ) : (
          <div className="relative mx-auto mt-3 aspect-square w-40 overflow-hidden rounded-xl" style={{ backgroundColor: HAIRLINE }}>
            {files[0] ? <PickedPreview photo={{ id: 'snap', file: files[0] }} /> : voice && (
              <span className="flex h-full w-full items-center justify-center text-[28px]" style={{ color: INK, fontFamily: SERIF }}>{formatClock(voice.durationSec)}</span>
            )}
          </div>
          )}
          {voice && languages?.length ? (
            <select
              aria-label="Language" value={language} onChange={(e) => setLanguage(e.target.value)}
              className="mx-auto mt-3 block h-11 rounded-2xl px-3 text-base" style={{ color: INK, border: `1px solid ${HAIRLINE}` }}
            >
              <option value="auto">Any language</option>
              {languages.map((l) => <option key={l} value={l}>{l}</option>)}
            </select>
          ) : null}
          <label htmlFor="snap-caption" className="sr-only">Caption</label>
          <textarea
            id="snap-caption"
            value={caption}
            maxLength={SNAP_CAPTION_MAX}
            onChange={(e) => { setCaption(e.target.value); if (state === 'failed') setState('idle') }}
            placeholder="Add a caption, if you want"
            rows={2}
            className="mt-4 w-full resize-none rounded-2xl bg-white/70 px-4 py-3 text-[17px] leading-relaxed outline-none placeholder:text-[color:var(--cowitness-placeholder)] focus:bg-white"
            style={{ color: INK, fontFamily: SERIF, border: `1px solid ${HAIRLINE}`, ['--cowitness-placeholder' as string]: PLACEHOLDER }}
          />
          {f.justUs && shares && (
            <button
              type="button" role="switch" aria-checked={justUs} aria-label="Just us" onClick={() => setJustUs(!justUs)}
              className="mt-3 flex h-11 w-full items-center justify-between text-sm" style={{ color: INK }}
            >
              <span>Just us</span><span style={{ color: MUTED }}>{justUs ? 'Only the people who share see this' : 'Off'}</span>
            </button>
          )}
          {f.tags && tagChoices.length > 0 && (
            <label className="mt-3 block text-sm" style={{ color: INK }}>
              Tag
              <select
                aria-label="Tag" value={tag} onChange={(e) => setTag(e.target.value)}
                className="mt-1 h-11 w-full rounded-2xl px-3 text-base" style={{ border: `1px solid ${HAIRLINE}` }}
              >
                <option value="">None</option>
                {tagChoices.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}
              </select>
            </label>
          )}
          <div className="mt-3 flex items-center justify-between">
            <span aria-live="polite" className="text-sm" style={{ color: state === 'failed' ? DANGER : MUTED }}>
              {state === 'failed' ? failedText : state === 'sending' ? sendingText : note}
            </span>
            <button
              type="button"
              onClick={send}
              disabled={state === 'sending'}
              className="h-11 rounded-full px-6 text-sm font-medium transition-opacity disabled:opacity-40"
              style={{ backgroundColor: INK, color: ON_INK }}
            >
              {state === 'sending' ? 'Sending' : 'Send'}
            </button>
          </div>
        </BottomSheet>
      )}
    </>
  )
}
