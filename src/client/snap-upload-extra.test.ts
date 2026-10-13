import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'

vi.mock('./reencode.js', async (orig) => ({ ...(await orig<typeof import('./reencode.js')>()), toJpeg: vi.fn(async () => new Blob(['jpeg'], { type: 'image/jpeg' })) }))
vi.mock('./video-meta.js', async (orig) => ({
  ...(await orig<typeof import('./video-meta.js')>()),
  readVideoMeta: vi.fn(async () => ({ durationSec: 8.2, width: 1080, height: 1920 })),
  capturePoster: vi.fn(async () => null),
}))

import { postSnap } from './snap-upload.js'

const filings: { url: string; body: Record<string, unknown> }[] = []
class FakeXHR {
  upload = { onprogress: null }
  onload: (() => void) | null = null
  status = 200
  open() {}
  setRequestHeader() {}
  send() { setTimeout(() => this.onload?.(), 0) }
}
beforeEach(() => {
  filings.length = 0
  vi.stubGlobal('XMLHttpRequest', FakeXHR)
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
    if (url.endsWith('/photos/upload-url')) return new Response(JSON.stringify({ photoId: 'p1', url: 'https://put/p1' }))
    if (url.endsWith('/videos/upload-url')) return new Response(JSON.stringify({ photoId: 'v1', videoUrl: 'https://put/v1', posterUrl: 'https://put/poster', requiredHeaders: { video: {}, poster: {} } }))
    if (typeof init.body === 'string') filings.push({ url, body: JSON.parse(init.body) })
    return new Response(JSON.stringify({ id: 'x' }))
  }))
})
afterEach(() => vi.unstubAllGlobals())

describe('postSnap with the share sheet\'s switches', () => {
  it('files a photo and a video with "just us" and their tags', async () => {
    await postSnap(new File(['raw'], 'a.jpg', { type: 'image/jpeg' }), 'x', { extra: { justUs: true, tags: ['t-first'] } })
    await postSnap(new File(['moov'], 'b.mov', { type: 'video/quicktime' }), 'y', { extra: { justUs: true, tags: ['t-second'] } })
    expect(filings.map((f) => [f.url.split('/').pop(), f.body.justUs, f.body.tags])).toEqual([['photo', true, ['t-first']], ['video', true, ['t-second']]])
  })
  it('writes neither key when nothing was chosen, so the body is what it always was', async () => {
    await postSnap(new File(['raw'], 'a.jpg', { type: 'image/jpeg' }), 'x', { extra: { tags: [] } })
    await postSnap(new File(['raw'], 'a.jpg', { type: 'image/jpeg' }), 'x', {})
    for (const f of filings) {
      expect(f.body).not.toHaveProperty('justUs')
      expect(f.body).not.toHaveProperty('tags')
    }
  })
  it('files a photo with the batch it was sent in', async () => {
    await postSnap(new File(['raw'], 'a.jpg', { type: 'image/jpeg' }), 'x', { extra: { batch: { id: 'batch-0001', index: 1, size: 3 } } })
    expect(filings[0].body.batch).toEqual({ id: 'batch-0001', index: 1, size: 3 })
  })
  it('writes no batch key when there is none', async () => {
    await postSnap(new File(['raw'], 'a.jpg', { type: 'image/jpeg' }), 'x', { extra: { justUs: true } })
    expect(filings[0].body).not.toHaveProperty('batch')
  })
})
