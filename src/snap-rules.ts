import type { Member } from './types.js'
import type { Circle } from './features.js'
import type { Comment, CowitnessSummary, FiledMedia, Recording, Snap, SnapBatch, SnapPatch } from './types.js'
import { TAGS_MAX_DEFAULT, validateJustUs, validateTags } from './tag-rules.js'
import { RuleError, addComment, heartComment, lastMessageFromOther, validateClip, audioExtension, MESSAGE_MAX, NOTHING_HEARD } from './shared-rules.js'
import { DISCUSSION_EMOJIS, setEmojiReaction } from './discussion.js'

// Cowitness, as rules. Pure and synchronous so every one of them is tested without Firebase;
// snaps-store.ts only reads, calls one of these, and writes.

export const SNAP_CAPTION_MAX = 500

// Optional. Blank is fine and means no caption; it is never a reason to refuse the snap.
export function validateCaption(v: unknown): string {
  if (v === undefined || v === null) return ''
  if (typeof v !== 'string') throw new RuleError('caption must be text', 400)
  const t = v.trim()
  if (t.length > SNAP_CAPTION_MAX) throw new RuleError(`caption must be at most ${SNAP_CAPTION_MAX} characters`, 400)
  return t
}

// The `ctx` a rule is given says who shares and who witnesses. With none, every rule is exactly
// the rule from before options existed, for every record written before options existed.
// A "just us" snap is seen by the people who share and always by its author. With no circle to
// say who shares (the option was turned off after it was written) it stays its author's alone:
// the flag fails closed, never open.
export const canSeeSnap = (s: Pick<Snap, 'by' | 'hiddenAt' | 'justUs'>, m: Member, ctx?: Circle) =>
  (s.hiddenAt === null || s.by === m) && (s.justUs !== true || s.by === m || (ctx !== undefined && ctx.sharers.has(m)))

// Whether a host may tell `m` about this snap. Every announcement hands the host the snap, whose
// `justUs` is the signal; a host MUST check each recipient with this before telling them anything,
// passing the same circle the package builds (`circleOf(witnessing, people)`), and only when it
// builds one: the audience kind or "just us" on, from people() as it reads now. With neither on, no
// circle, never one kept from before an option was turned off. With no circle a "just us" snap may
// be announced to its author only.
export const mayHear = (s: Pick<Snap, 'by' | 'hiddenAt' | 'justUs'>, m: Member, ctx?: Circle): boolean => canSeeSnap(s, m, ctx)

// Whether `m` has seen this snap. In the audience kind a witness has their own seen; the person who
// shared it, and anyone who only shares, read the first one as the receipt.
export function seenBy(s: Snap, m: Member, ctx?: Circle): boolean {
  if (ctx?.witnessing === 'audience' && s.by !== m && ctx.witnesses.has(m)) return s.witnessedBy?.[m] !== undefined
  return s.witnessedAt !== null
}

export function assertCanShare(m: Member, ctx?: Circle): void {
  if (ctx?.witnessing === 'audience' && !ctx.sharers.has(m)) throw new RuleError('you cannot share here', 403)
}

export function newSnap(m: Member, media: FiledMedia, caption: string, now: string, extra: { justUs?: true; tags?: string[]; batch?: SnapBatch } = {}): Omit<Snap, 'id'> {
  return {
    by: m, caption, kind: media.kind, takenAt: media.takenAt, width: media.width, height: media.height,
    paths: media.paths, ...(media.video ? { video: media.video } : {}),
    witnessedAt: null, hiddenAt: null, createdAt: now,
    ...(extra.justUs ? { justUs: true as const } : {}), ...(extra.tags?.length ? { tags: extra.tags } : {}),
    ...(extra.batch ? { batch: extra.batch } : {}),
  }
}

export function applySnapPatch(
  s: Snap, actor: Member, patch: SnapPatch,
  opts: { now?: string; id?: string; ctx?: Circle; tags?: ReadonlySet<string>; maxTags?: number; justUs?: boolean } = {},
): Snap {
  const now = opts.now ?? new Date().toISOString()
  // A hidden snap belongs to the member who hid it until they bring it back.
  if (!canSeeSnap(s, actor, opts.ctx)) throw new RuleError('this snap is hidden', 403)
  switch (patch.kind) {
    case 'comment':
      return addComment(s, actor, patch.text, { now, id: opts.id, images: patch.images })
    case 'comment-heart':
      return heartComment(s, actor, patch.commentId, patch.value, { now })
    case 'reaction': {
      if (!(DISCUSSION_EMOJIS as readonly string[]).includes(patch.emoji) || typeof patch.value !== 'boolean') throw new RuleError('unsupported emoji reaction', 400)
      const result = setEmojiReaction(s.reactions ?? [], { by: actor, emoji: patch.emoji, at: now }, patch.value)
      return result.changed ? { ...s, reactions: result.reactions } : s
    }
    case 'discard-reaction': {
      const c = s.comments?.find((c) => c.id === patch.commentId)
      if (!c) throw new RuleError('reaction not found', 404)
      if (c.by !== actor) throw new RuleError('only your own reaction can be discarded', 403)
      if (c.discardedAt) return s
      if (!canDiscardReaction(c, actor)) throw new RuleError('only a wordless recording can be discarded after transcription', 400)
      return { ...s, comments: s.comments!.map((c) => c.id === patch.commentId ? { ...c, discardedAt: now } : c) }
    }
    case 'hide':
      if (s.by !== actor) throw new RuleError('only the member who shared it can hide it', 403)
      return s.hiddenAt ? s : { ...s, hiddenAt: now }
    case 'unhide':
      if (s.by !== actor) throw new RuleError('only the member who shared it can bring it back', 403)
      return { ...s, hiddenAt: null }
    // Nothing can be skipped, but silence is allowed: Next always marks it witnessed, and a typed
    // reaction rides in the same write so the receipt and the words can never disagree.
    case 'witness': {
      if (s.by === actor) throw new RuleError('you cannot witness your own snap', 400)
      let seen: Snap
      if (opts.ctx?.witnessing === 'audience') {
        if (!opts.ctx.witnesses.has(actor)) throw new RuleError('only someone who witnesses can witness', 403)
        seen = s.witnessedBy?.[actor]
          ? s
          : { ...s, witnessedBy: { ...(s.witnessedBy ?? {}), [actor]: now }, witnessedAt: s.witnessedAt ?? now }
      } else {
        seen = s.witnessedAt ? s : { ...s, witnessedAt: now }
      }
      const text = patch.text?.trim()
      return text ? addComment(seen, actor, text, { now, id: opts.id }) : seen
    }
    case 'tag': {
      const may = opts.ctx?.witnessing === 'audience' ? opts.ctx.sharers.has(actor) : s.by === actor
      if (!may) throw new RuleError('only someone who shares can tag a snap', 403)
      const ids = validateTags(patch.ids, opts.tags, opts.maxTags ?? TAGS_MAX_DEFAULT)
      const { tags: _tags, ...rest } = s
      return ids ? { ...rest, tags: ids } : rest
    }
    case 'just-us': {
      if (s.by !== actor) throw new RuleError('only the person who shared it can change who sees it', 403)
      validateJustUs(true, opts.justUs === true)
      const { justUs: _justUs, ...rest } = s
      return patch.value ? { ...rest, justUs: true } : rest
    }
    // A kind this rule does not apply (an option's patch, or one from a newer client) is refused,
    // never answered with nothing.
    default:
      throw new RuleError('unknown patch kind', 400)
  }
}

const newestFirst = (a: Snap, b: Snap) => b.createdAt.localeCompare(a.createdAt)
const oldestFirst = (a: Snap, b: Snap) => a.createdAt.localeCompare(b.createdAt)

// Everything, forever, both members in one stream, newest first.
export function archiveOf<T extends Snap>(snaps: T[], m: Member, ctx?: Circle): T[] {
  return snaps.filter((s) => canSeeSnap(s, m, ctx)).sort(newestFirst)
}

// The Cowitness home keeps only what is still open: nothing witnessed yet, from either side.
// Everything witnessed moves to its own shelf, so the home stays small however long this runs.
export function openOf<T extends Snap>(snaps: T[], m: Member, ctx?: Circle): T[] {
  return archiveOf(snaps, m, ctx).filter((s) => !seenBy(s, m, ctx))
}

export function witnessedOf<T extends Snap>(snaps: T[], m: Member, ctx?: Circle): T[] {
  return archiveOf(snaps, m, ctx).filter((s) => seenBy(s, m, ctx))
}

// With the home as the last day: the last 24 hours on the home, witnessed or not, and everything
// older on the shelf. A rolling window, not a calendar day, so nothing leaves the home at midnight
// a minute after it was shared. The shelf keeps it; nothing here deletes anything.
export const HOME_WINDOW_MS = 24 * 60 * 60 * 1000
const sinceOf = (now: Date) => new Date(now.getTime() - HOME_WINDOW_MS).toISOString()

export function todayOf<T extends Snap>(snaps: T[], m: Member, now: Date, ctx?: Circle): T[] {
  const since = sinceOf(now)
  return archiveOf(snaps, m, ctx).filter((s) => s.createdAt > since)
}

export function earlierOf<T extends Snap>(snaps: T[], m: Member, now: Date, ctx?: Circle): T[] {
  const since = sinceOf(now)
  return archiveOf(snaps, m, ctx).filter((s) => s.createdAt <= since)
}

// The one image a grid tile shows: the thumbnail, or a video's poster. A tile never needs the
// display size or the video itself, so nothing else is signed for it.
export function thumbPathOf(s: Snap): string | null {
  if (s.kind === 'video') return s.video?.posterPath || null
  return s.paths.thumb || null
}

export function snapHasNew(s: Snap, m: Member, lastSeenAt: string, ctx?: Circle): boolean {
  if (!canSeeSnap(s, m, ctx)) return false
  const otherAt = lastMessageFromOther(s, m)
  return (s.by !== m && s.createdAt > lastSeenAt) || (otherAt !== undefined && otherAt > lastSeenAt)
}

// The newest visible snap with an image to show. A video with no poster has none.
export function coverOf(snaps: Snap[], m: Member, ctx?: Circle): Snap | null {
  return archiveOf(snaps, m, ctx).find((s) => !!s.paths.thumb) ?? null
}

// What is waiting for `m`, oldest first, because a session walks through the day in the order it
// happened. In the audience kind only a witness has a queue, and it is what they have not seen.
export function queueOf<T extends Snap>(snaps: T[], m: Member, ctx?: Circle): T[] {
  if (ctx?.witnessing === 'audience') {
    if (!ctx.witnesses.has(m)) return []
    return snaps.filter((s) => s.by !== m && s.hiddenAt === null && canSeeSnap(s, m, ctx) && s.witnessedBy?.[m] === undefined).sort(oldestFirst)
  }
  return snaps.filter((s) => s.by !== m && s.hiddenAt === null && s.witnessedAt === null && canSeeSnap(s, m, ctx)).sort(oldestFirst)
}

export function cowitnessTile(snaps: Snap[], m: Member, lastSeenAt: string, coverUrl: string | null, ctx?: Circle): CowitnessSummary {
  const visible = archiveOf(snaps, m, ctx)
  return {
    count: visible.length, coverUrl, hasNew: visible.some((s) => snapHasNew(s, m, lastSeenAt, ctx)),
    waiting: queueOf(snaps, m, ctx).length,
  }
}

// A reaction to a snap is not a journal entry.
export const REACTION_MAX_SEC = 180

// `prefix` is the app's storage prefix, so a reaction lands beside the app's own files.
export function reactionAudioPath(prefix: string, snapId: string, commentId: string, contentType: string): string {
  return `${prefix}snaps-audio/${snapId}/${commentId}.${audioExtension(contentType)}`
}

// The client mints this id (from its own vault record, stable across a retry) rather than the
// server, so a resend after a lost response reuses the same id and the server's own idempotency
// in addVoiceReaction is what stops it becoming a second comment. Shape-checked before it ever
// touches a storage path or a signed URL.
const COMMENT_ID_RE = /^[A-Za-z0-9_-]{8,64}$/

export function validateCommentId(v: unknown): string {
  if (typeof v !== 'string' || !COMMENT_ID_RE.test(v)) throw new RuleError('commentId must be 8 to 64 letters, numbers, - or _', 400)
  return v
}

export type ReactionTicket = { commentId: string; uploaded: true } | { commentId: string; url: string; requiredHeaders: Record<string, string> }

// The bytes might already be sitting at this id's object path: a resend of a held recording
// whose PUT actually landed last time, just before the response that would have told the phone
// so was lost. A second signed URL for the same id would 412 on GCS's create-once guard the
// moment the phone tried it (create-once is still enforced on the PUT itself, unchanged); the
// caller does not need a second PUT at all when the bytes are already there, so this hands back
// nothing to PUT to and lets the client skip straight to filing it.
export function reactionTicket(commentId: string, alreadyUploaded: boolean, url: string, requiredHeaders: Record<string, string>): ReactionTicket {
  return alreadyUploaded ? { commentId, uploaded: true } : { commentId, url, requiredHeaders }
}

// Same types and byte ceiling as a Notes clip, with the shorter cap. A recorder stopped at the
// cap reports a second or two over it, so the refusal leaves five seconds of grace.
export function validateReactionClip(input: { contentType: unknown; size: unknown; durationSec: unknown }): { contentType: string; size: number; durationSec: number } {
  const clip = validateClip(input)
  if (clip.durationSec > REACTION_MAX_SEC + 5) throw new RuleError('a reaction is at most three minutes', 400)
  return clip
}

// A spoken reaction is a message whose words arrive later. Filed once per id: a retried attach
// after a dropped connection must never put the same voice under the snap twice.
export function addVoiceReaction(s: Snap, actor: Member, commentId: string, rec: Recording, opts: { now?: string; ctx?: Circle } = {}): Snap {
  if (!canSeeSnap(s, actor, opts.ctx)) throw new RuleError('this snap is hidden', 403)
  if ((s.comments ?? []).some((c) => c.id === commentId)) return s
  const comment = { id: commentId, by: actor, text: '', at: opts.now ?? new Date().toISOString(), recording: rec }
  return { ...s, comments: [...(s.comments ?? []), comment] }
}

type Spoken = Comment & { recording: Recording }

export const canDiscardReaction = (c: Comment, actor: Member): boolean =>
  c.by === actor && !!c.recording && !c.text.trim() && !c.images?.length && c.recording.status !== 'transcribing' && !c.discardedAt

function onRecording(s: Snap, commentId: string, change: (c: Spoken) => Comment): Snap {
  const target = (s.comments ?? []).find((c) => c.id === commentId)
  if (!target?.recording || target.discardedAt) throw new RuleError('reaction not found', 404)
  return { ...s, comments: (s.comments ?? []).map((c) => (c.id === commentId ? change(c as Spoken) : c)) }
}

// The recording without any transcript state: the keys are dropped, never set to undefined,
// because Firestore refuses an undefined value.
function settled(r: Recording): Recording {
  const { status: _status, reason: _reason, startedAt: _startedAt, ...rest } = r
  return rest
}

// Stamps startedAt every time a recording moves to 'transcribing', auto or Try again alike, so
// canRetranscribe can measure how long THIS attempt has actually been running rather than how
// old the reaction is.
export function markTranscribing(s: Snap, commentId: string, language?: string, opts: { now?: string } = {}): Snap {
  const startedAt = opts.now ?? new Date().toISOString()
  return onRecording(s, commentId, (c) => ({
    ...c, recording: { ...settled(c.recording), ...(language ? { language } : {}), status: 'transcribing', startedAt },
  }))
}

export function setReactionTranscript(s: Snap, commentId: string, text: string): Snap {
  const words = text.trim().slice(0, MESSAGE_MAX)
  if (!words) return failReactionTranscript(s, commentId, NOTHING_HEARD)
  return onRecording(s, commentId, (c) => ({ ...c, text: words, recording: settled(c.recording) }))
}

export function failReactionTranscript(s: Snap, commentId: string, reason: string): Snap {
  return onRecording(s, commentId, (c) => ({ ...c, recording: { ...settled(c.recording), status: 'failed', reason } }))
}

// The auto transcription an attach schedules for itself is only ever allowed to run against a
// recording still exactly as attachReaction left it. An idempotent re-attach of the same
// commentId (a phone resending a clip whose first response never arrived) must never schedule a
// second job that clobbers a transcript already written, or races the first job's write with a
// second one: this is the gate that makes a stray extra schedule harmless if one ever occurs.
export function canAutoTranscribe(rec: Recording): boolean {
  return rec.status === 'transcribing'
}

// Longer than any function invocation can run: a 'transcribing' recording still in that state
// past this age was killed mid-run rather than genuinely in flight, and Try again may recover it.
const RETRANSCRIBE_STALE_MS = 5 * 60 * 1000

// Try again is allowed from a failure, from a finished transcript (a re-listen, e.g. a different
// language), or from a transcribing job old enough that nothing could still be running it. It is
// refused, with a conflict, while a genuinely live transcription is still within that window.
//
// Staleness is measured from the recording's OWN startedAt, not the comment's `at`: a reaction
// filed hours ago whose transcription only just began is still a live job and must stay
// protected, however old the comment is. `commentAt` is only a fallback for a recording filed
// before this field existed.
export function canRetranscribe(rec: Recording, commentAt: string, now: string): boolean {
  if (rec.status !== 'transcribing') return true
  const startedAt = rec.startedAt ?? commentAt
  return new Date(now).getTime() - new Date(startedAt).getTime() > RETRANSCRIBE_STALE_MS
}
