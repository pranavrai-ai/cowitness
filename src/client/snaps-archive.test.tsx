import { describe, expect, it, vi, afterEach } from 'vitest'
import type { ReactNode } from 'react'

// The real Link keeps `prefetch` to itself; this one puts it on the anchor so a test can read it.
vi.mock('next/link', () => ({
  default: ({ href, prefetch, children, ...rest }: { href: string; prefetch?: boolean | null; children: ReactNode }) =>
    <a href={href} data-prefetch={String(prefetch)} {...rest}>{children}</a>,
}))
import { render, screen, within } from '@testing-library/react'
import { SnapsArchive } from './snaps-archive.js'
import type { SnapRow } from '../format.js'
import { clientConfig, configure } from './config.js'

const NAMES = { ana: 'Ana', ben: 'Ben' }
const today = new Date()
const row = (o: Partial<SnapRow> = {}): SnapRow => ({
  id: 's1', by: 'ben', caption: 'lunch', kind: 'photo', thumbUrl: 'https://img/t1', durationSec: null,
  createdAt: today.toISOString(), witnessedAt: null, hidden: false, ...o,
})

describe('SnapsArchive', () => {
  it('shows every snap as a link, grouped under its day, with who shared it', () => {
    const yesterday = new Date(today); yesterday.setDate(today.getDate() - 1)
    render(<SnapsArchive me="ana" names={NAMES} rows={[row(), row({ id: 's2', by: 'ana', createdAt: yesterday.toISOString(), caption: '' })]} />)
    const today_ = screen.getByRole('region', { name: 'Today' })
    expect(within(today_).getByRole('link')).toHaveAttribute('href', '/cowitness/s1')
    expect(within(today_).getByText('Ben')).toBeInTheDocument()
    expect(within(screen.getByRole('region', { name: 'Yesterday' })).getByRole('link')).toHaveAttribute('href', '/cowitness/s2')
  })

  it('does not prefetch every tile\'s page in the background', () => {
    render(<SnapsArchive me="ana" names={NAMES} rows={[row(), row({ id: 's2' })]} />)
    for (const l of screen.getAllByRole('link')) expect(l).toHaveAttribute('data-prefetch', 'false')
  })

  it('says what it was told to when empty', () => {
    render(<SnapsArchive me="ana" names={NAMES} rows={[]} empty="All caught up." />)
    expect(screen.getByText('All caught up.')).toBeInTheDocument()
  })

  it('says so when there is nothing yet', () => {
    render(<SnapsArchive me="ana" names={NAMES} rows={[]} />)
    expect(screen.getByText('Nothing shared yet. Add a snap from your day.')).toBeInTheDocument()
  })

  it('marks a hidden snap for the member who hid it', () => {
    render(<SnapsArchive me="ben" names={NAMES} rows={[row({ hidden: true })]} />)
    expect(screen.getByText('Hidden')).toBeInTheDocument()
  })

  it('my own snap says when it has been witnessed', () => {
    render(<SnapsArchive me="ana" names={NAMES} rows={[row({ by: 'ana', witnessedAt: '2026-09-27T21:00:00.000Z' }), row({ id: 's2', by: 'ana' })]} />)
    expect(screen.getAllByText('Witnessed')).toHaveLength(1)
  })
})

describe('SnapsArchive with options', () => {
  it('draws a voice snap as its first words, marks "just us", and names a tag', () => {
    render(<SnapsArchive me="ana" names={{ ana: 'Ana', ben: 'Ben' }} tagLabels={{ 't-first': 'First' }} rows={[
      { id: 'v1', by: 'ana', caption: '', kind: 'voice', thumbUrl: null, durationSec: 9, createdAt: '2026-09-30T09:00:00.000Z', witnessedAt: null, hidden: false, words: 'tavo merin solut', justUs: true, tags: ['t-first'] },
    ]} />)
    expect(screen.getByText('tavo merin solut')).toBeInTheDocument()
    expect(screen.getByLabelText('Just us')).toBeInTheDocument()
    expect(screen.getByText('First')).toBeInTheDocument()
  })
  it('a voice snap whose words have not come yet says it is a voice note', () => {
    render(<SnapsArchive me="ana" names={NAMES} rows={[row({ kind: 'voice', thumbUrl: null, words: '' })]} />)
    expect(screen.getByText('Voice note')).toBeInTheDocument()
  })
  it('an old row, and tags with no labels given, draw nothing new', () => {
    const { container } = render(<SnapsArchive me="ana" names={NAMES} rows={[row({ tags: ['t-first'] })]} />)
    expect(screen.queryByText('t-first')).toBeNull()
    expect(screen.queryByLabelText('Just us')).toBeNull()
    expect(container.querySelectorAll('p')).toHaveLength(1)
  })

  const b = (index: number, size = 3, id = 'batch-0001') => ({ id, index, size })

  it('shows photos sent together as one folder: the first of them, with a count, opening that first one', () => {
    render(<SnapsArchive me="ana" names={NAMES} rows={[
      row({ id: 'c', batch: b(2) }), row({ id: 'b', batch: b(1) }), row({ id: 'a', batch: b(0) }), row({ id: 'solo', caption: 'alone' }),
    ]} />)
    const links = screen.getAllByRole('link')
    expect(links).toHaveLength(2)
    expect(links.map((l) => l.getAttribute('href'))).toEqual(['/cowitness/a', '/cowitness/solo'])
    expect(screen.getByLabelText('3 photos')).toHaveTextContent('3')
  })

  it('peeks one photo behind a pair and two behind three or more, and none behind a single photo', () => {
    const { container, rerender } = render(<SnapsArchive me="ana" names={NAMES} rows={[row({ id: 'a', batch: b(0, 2) }), row({ id: 'b', batch: b(1, 2) })]} />)
    expect(container.querySelectorAll('[data-stack-layer]')).toHaveLength(1)
    rerender(<SnapsArchive me="ana" names={NAMES} rows={[row({ id: 'a', batch: b(0, 4) }), row({ id: 'b', batch: b(1, 4) }), row({ id: 'c', batch: b(2, 4) })]} />)
    expect(container.querySelectorAll('[data-stack-layer]')).toHaveLength(2)
    rerender(<SnapsArchive me="ana" names={NAMES} rows={[row({ id: 'solo' })]} />)
    expect(container.querySelectorAll('[data-stack-layer]')).toHaveLength(0)
  })

  it('counts only the photos that are there: a hidden or missing one does not count', () => {
    render(<SnapsArchive me="ana" names={NAMES} rows={[row({ id: 'b', batch: b(1, 4) }), row({ id: 'd', batch: b(3, 4) })]} />)
    expect(screen.getAllByRole('link').map((l) => l.getAttribute('href'))).toEqual(['/cowitness/b'])
    expect(screen.getByLabelText('2 photos')).toHaveTextContent('2')
  })

  it('does not join the photos of different batches, or of one batch on different days', () => {
    const yesterday = new Date(today); yesterday.setDate(today.getDate() - 1)
    render(<SnapsArchive me="ana" names={NAMES} rows={[
      row({ id: 'x0', batch: b(0, 2, 'batch-aaaa') }), row({ id: 'y0', batch: b(0, 2, 'batch-bbbb') }),
      row({ id: 'x1', batch: b(1, 2, 'batch-aaaa'), createdAt: yesterday.toISOString() }),
    ]} />)
    expect(screen.getAllByRole('link')).toHaveLength(3)
    expect(screen.queryByLabelText(/photos$/)).toBeNull()
  })
})

describe('SnapsArchive captions with several photos at once on', () => {
  const base = clientConfig()
  afterEach(() => configure(base))

  it('says what each snap says, once, under its tile', () => {
    configure({ ...base, features: { multiPhoto: true } })
    render(<SnapsArchive me="ana" names={NAMES} rows={[row({ caption: 'at the park' })]} />)
    expect(screen.getByText('at the park')).toBeInTheDocument()
  })
  it('draws no caption line when the option is off, so every screen is as it was', () => {
    configure(base)
    render(<SnapsArchive me="ana" names={NAMES} rows={[row({ caption: 'at the park' })]} />)
    expect(screen.queryByText('at the park')).toBeNull()
  })
})
