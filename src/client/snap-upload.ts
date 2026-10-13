import { clientConfig } from './config.js'
import type { SnapBatch } from '../types.js'
import { toJpeg } from './reencode.js'
import { postJson, takenAt } from './upload.js'
import { sendVideoBytes } from './upload.js'
import { isVideoFile, localWallClock, type VideoMeta } from './video-meta.js'

/** A snap whose bytes are in storage under this id but whose filing was never confirmed. */
export type SentSnap = { kind: 'photo'; photoId: string } | { kind: 'video'; photoId: string; meta: VideoMeta }

export interface SnapOptions {
  onProgress?(fraction: number): void
  /**
   * These bytes were drawn by the capture layer and are already a normalized jpeg: no EXIF to
   * strip or rotate by, and already inside the long-edge cap. Re-encoding them would be a second
   * lossy generation on pixels that have only been through one.
   */
  composed?: boolean
  /** An earlier attempt already stored these bytes: file them again under the same id. */
  sent?: SentSnap | null
  /** Told once the bytes are stored, before the filing, so a failed filing can be retried alone. */
  onSent?(sent: SentSnap): void
  /** The share sheet's switches, when their options are on. Absent: the filing is as it always was. */
  extra?: SnapExtra
}

export interface SnapExtra { justUs?: boolean; tags?: string[]; batch?: SnapBatch }
const extraBody = (extra?: SnapExtra) => ({ ...(extra?.justUs ? { justUs: true } : {}), ...(extra?.tags?.length ? { tags: extra.tags } : {}) })
// Only a photo's filing carries the batch it was sent in.
const photoBody = (extra?: SnapExtra) => ({ ...extraBody(extra), ...(extra?.batch ? { batch: extra.batch } : {}) })

// A second filing of the same id is refused when the first one landed (the ticket is claimed and
// gone) or when the stored copy can never be filed. Each app's pipeline words that refusal its own
// way, so the phone keys on the status alone: on a retry, any 400, 403 or 409 is settled by asking
// for the snap itself. A refusal that has nothing to do with the id (a caption too long) comes back
// the same way after the fresh start, so it still reaches the sheet in the server's words.
const ASK_WHETHER_FILED = new Set([400, 403, 409])

// One snap, start to finish. The bytes travel exactly as an album photo's or video's do (the
// same tickets, the same keys); only the filing call differs, because a snap is in no moment.
//
// A retried Send whose earlier filing never answered files the same id again, the way an album
// video's finalize-only retry does, rather than uploading the bytes twice and filing a second
// snap. The server files an id once: if the first filing landed, the retry is refused and the
// snap is found under that id, which is success. Only a stored copy that is truly gone starts
// over from a fresh ticket.
export async function postSnap(file: File, caption: string, opts: SnapOptions = {}): Promise<void> {
  if (opts.sent && (await fileSnap(file, caption, opts.sent, true, opts.extra)) === 'filed') return
  const sent = await sendBytes(file, opts.onProgress, opts.composed === true)
  opts.onSent?.(sent)
  await fileSnap(file, caption, sent, false, opts.extra)
}

async function sendBytes(file: File, onProgress?: (fraction: number) => void, composed = false): Promise<SentSnap> {
  if (isVideoFile(file)) {
    const { photoId, meta } = await sendVideoBytes(file, { onProgress })
    return { kind: 'video', photoId, meta }
  }
  const jpeg = composed ? file : await toJpeg(file)
  const issued = await postJson(clientConfig().uploadUrls.photo, {})
  if (!issued.ok) throw new Error('no upload url')
  const { photoId, url } = (await issued.json()) as { photoId: string; url: string }
  const put = await fetch(url, { method: 'PUT', headers: { 'Content-Type': 'image/jpeg' }, body: jpeg })
  if (!put.ok) throw new Error('upload failed')
  return { kind: 'photo', photoId }
}

async function fileSnap(file: File, caption: string, sent: SentSnap, retry: boolean, extra?: SnapExtra): Promise<'filed' | 'gone'> {
  const stamp = Number.isFinite(file.lastModified) && file.lastModified > 0 ? file.lastModified : null
  const shotAt = sent.kind === 'photo' ? await takenAt(file) : undefined
  const done = sent.kind === 'video'
    ? await postJson(`${clientConfig().apiBase}/video`, {
      photoId: sent.photoId, caption, durationSec: sent.meta.durationSec, width: sent.meta.width, height: sent.meta.height,
      ...(stamp ? { takenAt: localWallClock(stamp) } : {}), ...extraBody(extra),
    })
    : await postJson(`${clientConfig().apiBase}/photo`, {
      photoId: sent.photoId, caption, ...(shotAt ? { clientTakenAt: shotAt } : {}), ...photoBody(extra),
    })
  if (done.ok) return 'filed'
  const reason = await refusal(done)
  if (retry && ASK_WHETHER_FILED.has(done.status)) {
    const found = await fetch(`${clientConfig().apiBase}/${sent.photoId}`).catch(() => null)
    if (found?.ok) return 'filed'
    if (found?.status === 404) return 'gone'
  }
  throw new Error(reason)
}

// The server's own words when it refused, which are written for a reader; else the status.
async function refusal(res: Response): Promise<string> {
  const body = (await res.json().catch(() => null)) as { error?: unknown } | null
  return typeof body?.error === 'string' ? body.error : `not sent (${res.status})`
}
