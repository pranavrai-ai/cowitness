// Cowitness's records. Every field is exactly as the app it was built in stores it, so an app moving onto this package reads and writes its existing records unchanged.
// `M` is the app's member key, stored in `by` and in hearts, and never renamed.
export type Member = string
export type MemberNames = Record<string, string>

// A recording on a message: a spoken reaction. The message's text is its transcript.
// `status` absent: the text is the transcript (or the app has no transcriber).
export interface Recording {
  path: string; contentType: string; durationSec: number; language?: string
  status?: 'transcribing' | 'failed'
  reason?: string
  // Stamped every time the recording moves to 'transcribing'; Try again measures staleness from here.
  startedAt?: string
}
export interface CommentImage { id: string; width: number; height: number }
// One message under a snap. Sent, never edited. `hearts` maps a member to when they hearted it.
export interface Comment<M extends string = string> {
  id: string; by: M; text: string; at: string
  /** A wordless recording its author chose to remove from the conversation. Bytes are retained. */
  discardedAt?: string
  hearts?: Partial<Record<M, string>>; recording?: Recording; quote?: string; images?: CommentImage[]
}
export interface EmojiReaction<M extends string = string> { by: M; emoji: string; at: string }
export type MediaKind = 'photo' | 'video'
// A voice snap is a recording with no picture; its words arrive later, like a spoken reaction's.
export type SnapKind = MediaKind | 'voice'
export interface VoiceInfo extends Recording { text: string }
export type VideoContentType = 'video/mp4' | 'video/quicktime'
export interface Chapter { startSec: number; at: string; thumbPath: string | null }
export interface VideoStream { dir: string; master: 'master.m3u8'; chapters: Chapter[] }
export interface VideoInfo {
  path: string; posterPath: string | null; durationSec: number; contentType: VideoContentType
  stream?: VideoStream
}
// What the app's upload pipeline produced, before it is a snap.
export interface FiledMedia {
  kind: MediaKind; takenAt: string; width: number; height: number
  paths: { original: string; display: string; thumb: string }
  video?: VideoInfo
}
// One photo, video or voice note one person shared to be witnessed. `witnessedAt` is the queue, the
// tile count and the receipt in one field. Nothing is ever deleted: whoever shared it can hide it.
// The optional fields are written only by an app that turned their option on: `justUs` (always
// true when present), `tags` (never empty), `witnessedBy` (the audience kind's per-person seen),
// `voice` (a voice snap's recording and words).
export interface SnapBatch { id: string; index: number; size: number }
export interface Snap<M extends string = string> {
  id: string; by: M; caption: string
  kind: SnapKind; takenAt: string; width: number; height: number
  paths: { original: string; display: string; thumb: string }
  video?: VideoInfo
  voice?: VoiceInfo
  witnessedAt: string | null
  witnessedBy?: Partial<Record<M, string>>
  hiddenAt: string | null
  justUs?: true
  tags?: string[]
  /** Set when several photos were sent together: the send's id, this photo's place in it (from 0) and how many were sent. */
  batch?: SnapBatch
  comments?: Comment<M>[]
  reactions?: EmojiReaction<M>[]
  createdAt: string
}
// A snap the app's media pipeline made, which is the only kind its media.urls is ever handed.
export type MediaSnap<M extends string = string> = Snap<M> & { kind: MediaKind }
export interface ChapterUrl { startSec: number; at: string; thumbUrl: string | null }
export interface MediaUrls {
  thumbUrl: string | null; displayUrl: string | null
  posterUrl?: string | null; videoUrl?: string
  streamUrl?: string; chapters?: ChapterUrl[]
  audioUrl?: string
}
export type SnapView<M extends string = string> = Snap<M> & MediaUrls
export type SnapPatch =
  | { kind: 'comment'; text: string; images?: CommentImage[] }
  | { kind: 'comment-heart'; commentId: string; value: boolean }
  | { kind: 'reaction'; emoji: string; value: boolean }
  | { kind: 'discard-reaction'; commentId: string }
  | { kind: 'hide' }
  | { kind: 'unhide' }
  | { kind: 'witness'; text?: string }
  | { kind: 'tag'; ids: string[] }
  | { kind: 'just-us'; value: boolean }
export interface CowitnessSummary { count: number; coverUrl: string | null; hasNew: boolean; waiting: number }
export interface PromptSettings { times: string[]; snoozedUntil: string | null }
export interface PromptPerson<M extends string = string> extends PromptSettings { key: M }
export interface TagChoice { id: string; label: string }
