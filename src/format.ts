// Pure helpers for Cowitness screens. Kept out of any 'use client' file because the server
// render calls snapRow(), and a function exported from a client module cannot be called there.
import type { Member } from './types.js'
import type { Snap, SnapBatch, SnapKind } from './types.js'

export interface SnapRow {
  id: string; by: Member; caption: string; kind: SnapKind
  thumbUrl: string | null; durationSec: number | null
  createdAt: string; witnessedAt: string | null; hidden: boolean
  // Written only when present, so a row for an old record is exactly what it always was.
  justUs?: true; tags?: string[]; batch?: SnapBatch
  // A voice snap's words; empty while they are still to come.
  words?: string
}

// `thumbUrl` is passed in rather than read off a SnapView, so a caller signs only the one image
// a tile shows, and a row the page never draws (the streak's) signs nothing.
export function snapRow(s: Snap, thumbUrl: string | null = null): SnapRow {
  return {
    id: s.id, by: s.by, caption: s.caption, kind: s.kind,
    thumbUrl,
    durationSec: s.kind === 'video' && s.video ? s.video.durationSec : s.kind === 'voice' && s.voice ? s.voice.durationSec : null,
    createdAt: s.createdAt, witnessedAt: s.witnessedAt, hidden: s.hiddenAt !== null,
    ...(s.justUs ? { justUs: true as const } : {}), ...(s.tags?.length ? { tags: s.tags } : {}), ...(s.batch ? { batch: s.batch } : {}),
    ...(s.kind === 'voice' ? { words: s.voice?.text ?? '' } : {}),
  }
}
