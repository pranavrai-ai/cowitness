import 'server-only'
import type { DocumentSnapshot } from 'firebase-admin/firestore'
import { RuleError, isRuleError } from '../errors.js'
import { CLIP_CONTENT_TYPES, CLIP_MAX_BYTES, validateClip } from '../shared-rules.js'
import {
  addVoiceReaction, applySnapPatch, archiveOf, assertCanShare, canAutoTranscribe, canRetranscribe, canSeeSnap, coverOf, cowitnessTile,
  failReactionTranscript, markTranscribing, newSnap, openOf, todayOf, earlierOf, queueOf, reactionAudioPath, reactionTicket,
  setReactionTranscript, thumbPathOf, validateCaption, validateCommentId, validateReactionClip, witnessedOf, type ReactionTicket,
} from '../snap-rules.js'
import { snapRow, type SnapRow } from '../format.js'
import { spokenLanguage } from '../language.js'
import { parsePromptPatch, promptsDue, validPromptTimes } from '../prompts.js'
import { zoned } from '../zoned.js'
import { circleOf, resolveFeatures, type Circle, type CowitnessFeatures } from '../features.js'
import { validateBatch, TAGS_MAX_DEFAULT, validateJustUs, validateTags } from '../tag-rules.js'
import {
  VOICE_UPLOADER_KEY, assertMayRetranscribeVoice, failVoiceTranscript, isVoiceRun, markVoiceTranscribing, newVoiceSnap, setVoiceTranscript,
  validateClientId, voiceSnapPath, voiceSnapPaths,
} from '../voice-rules.js'
import type { CowitnessSummary, MediaSnap, PromptSettings, Recording, Snap, SnapPatch, SnapView, TagChoice, VoiceInfo } from '../types.js'
import type { CowitnessHost } from './host.js'

// Cowitness at the edge: read, call one rule, write. Every decision is in ../snap-rules.ts.
// Moved from the app it was built in; what was that app's own (the database, the bucket, the
// media pipeline, the transcriber) is now asked of the host.
const REACTION_UPLOAD_WINDOW_MS = 15 * 60 * 1000
const nowIso = () => new Date().toISOString()

// An option the app turned on without the part it needs would fail on a person's first tap; it
// fails here instead, when the app starts, naming what is missing.
// A part that is there but the wrong shape (a host written without types) is refused the same way.
export function assertHostFits<M extends string>(host: CowitnessHost<M>, f: CowitnessFeatures): void {
  const missing: string[] = []
  const isFn = (v: unknown) => typeof v === 'function'
  const isText = (v: unknown) => typeof v === 'string' && v.length > 0
  if ((f.witnessing === 'audience' || f.justUs) && !isFn(host.people)) missing.push('people() (for the audience kind or "just us")')
  if (f.tags) {
    if (!isFn(host.tags?.list)) missing.push('tags.list() (for tags)')
    const max = host.tags?.max
    if (max !== undefined && !(Number.isInteger(max) && max > 0)) missing.push('tags.max as a whole number above 0 (for tags)')
  }
  if (f.prompts) {
    const p = host.prompts as Partial<NonNullable<CowitnessHost<M>['prompts']>> | undefined
    if (!p || typeof p !== 'object') missing.push('prompts (for capture reminders)')
    else {
      if (!isText(p.collection)) missing.push('prompts.collection (for capture reminders)')
      if (!isText(p.timeZone)) missing.push('prompts.timeZone (for capture reminders)')
      for (const fn of ['people', 'save', 'nudge'] as const) if (!isFn(p[fn])) missing.push(`prompts.${fn}() (for capture reminders)`)
    }
  }
  if (missing.length) throw new Error(`cowitness: the host turned on options without ${missing.join(', ')}`)
}

// A page drawn from several store calls (what this person may do, the home, the tile) would ask the
// app who its people are once per call. Make the request's store from this host instead and it asks
// once for the whole request; make a new one for the next request, so a change in who is who shows.
// A host with no people() is handed back as it is.
// Call it per request, NEVER at module scope: a store made from it once per process keeps the people
// it first read until a redeploy, so a person moved from sharing to only witnessing would go on seeing
// "just us" snaps, and a failed first read would fail every request after it.
export function askPeopleOnce<M extends string>(host: CowitnessHost<M>): CowitnessHost<M> {
  if (typeof host.people !== 'function') return host
  const ask = host.people.bind(host)
  let asked: ReturnType<typeof ask> | undefined
  return { ...host, people: () => (asked ??= ask()) }
}

export function createCowitnessStore<M extends string>(host: CowitnessHost<M>) {
  const features = resolveFeatures(host.features)
  assertHostFits(host, features)
  const snaps = () => host.db().collection(host.collection)
  const snapFrom = (doc: DocumentSnapshot): Snap<M> => ({ id: doc.id, ...(doc.data() as Omit<Snap<M>, 'id'>) })
  // A voice snap has no picture, so it never goes near the app's media pipeline: its one URL is
  // its recording's, signed behind the same visibility check as every other snap's media.
  const withUrls = async (s: Snap<M>): Promise<SnapView<M>> => (s.kind === 'voice'
    ? { ...s, thumbUrl: null, displayUrl: null, ...(s.voice ? { audioUrl: await host.media.signedUrl(s.voice.path) } : {}) }
    : { ...s, ...(await host.media.urls(s as MediaSnap<M>)) })
  // The one image a tile shows, signed alone; a row the page never draws (the streak's) signs nothing.
  const tileRow = async (s: Snap<M>): Promise<SnapRow> => {
    const path = thumbPathOf(s)
    return snapRow(s, path ? await host.media.signedUrl(path) : null)
  }
  const audioFile = (snapId: string, commentId: string, contentType: string) =>
    host.storage.bucket().file(reactionAudioPath(host.storage.prefix, snapId, commentId, contentType))

  const needsCircle = features.witnessing === 'audience' || features.justUs
  // Built only when an option needs it, so an app with none on reads exactly what it read before.
  const circle = async (): Promise<Circle<M> | undefined> => (needsCircle ? circleOf(features.witnessing, await host.people!()) : undefined)
  const tagSet = async (): Promise<ReadonlySet<string> | undefined> =>
    (features.tags ? new Set((await host.tags!.list()).map((t) => t.id)) : undefined)
  const maxTags = host.tags?.max ?? TAGS_MAX_DEFAULT
  // What a filing carries beyond its media, checked before the app's pipeline is touched.
  async function filingExtras(m: M, input: { justUs?: unknown; tags?: unknown }): Promise<{ justUs?: true; tags?: string[] }> {
    const ctx = await circle()
    assertCanShare(m, ctx)
    const justUs = validateJustUs(input.justUs, features.justUs)
    // Someone who does not share would file a snap even they could not be counted among; refused instead.
    if (justUs && ctx && !ctx.sharers.has(m)) throw new RuleError('only someone who shares can mark a snap "just us"', 400)
    const tags = input.tags === undefined ? undefined : validateTags(input.tags, await tagSet(), maxTags)
    return { ...(justUs ? { justUs } : {}), ...(tags ? { tags } : {}) }
  }

  // The photo went up on the app's own upload ticket, exactly as an album photo does; this files it
  // as a snap. The caption is checked first, so a bad one never costs the ticket.
  async function finalizeSnapPhoto(
    m: M, photoId: string, input: { caption?: unknown; clientTakenAt?: string; justUs?: unknown; tags?: unknown; batch?: unknown },
  ): Promise<Snap<M>> {
    const caption = validateCaption(input.caption)
    const extra = await filingExtras(m, input)
    // Only a photo can be one of several sent together, and only when the app turned that on.
    const batch = validateBatch(input.batch, features.multiPhoto)
    const ref = snaps().doc(photoId)
    const data = await host.media.filePhoto(m, photoId, input.clientTakenAt, { ref, record: (media) => newSnap(m, media, caption, nowIso(), { ...extra, ...(batch ? { batch } : {}) }) as Omit<Snap<M>, 'id'> })
    return { id: photoId, ...data }
  }

  async function finalizeSnapVideo(
    m: M, photoId: string,
    input: { caption?: unknown; meta: { durationSec: number; width: number; height: number; takenAt?: string }; justUs?: unknown; tags?: unknown },
  ): Promise<Snap<M>> {
    const caption = validateCaption(input.caption)
    const extra = await filingExtras(m, input)
    const ref = snaps().doc(photoId)
    const data = await host.media.fileVideo(m, photoId, input.meta, { ref, record: (media) => newSnap(m, media, caption, nowIso(), extra) as Omit<Snap<M>, 'id'> })
    return { id: photoId, ...data }
  }

  // A few snaps a day between a few people: one read, filtered here, no composite index.
  async function readSnaps(): Promise<Snap<M>[]> {
    const q = await snaps().get()
    return q.docs.map(snapFrom)
  }

  async function listSnaps(m: M): Promise<SnapView<M>[]> {
    const ctx = await circle()
    return Promise.all(archiveOf(await readSnaps(), m, ctx).map(withUrls))
  }

  // Everything the Cowitness home draws, from ONE read of the list.
  async function listCowitness(m: M): Promise<{ rows: SnapRow[]; streak: SnapRow[]; witnessed: number; queue: SnapView<M>[] }> {
    const ctx = await circle()
    const all = await readSnaps()
    const now = new Date()
    const home = features.home === 'today' ? todayOf(all, m, now, ctx) : openOf(all, m, ctx)
    const shelf = features.home === 'today' ? earlierOf(all, m, now, ctx) : witnessedOf(all, m, ctx)
    const [rows, queue] = await Promise.all([Promise.all(home.map(tileRow)), Promise.all(queueOf(all, m, ctx).map(withUrls))])
    // A person who only witnesses has no streak, so no rows for one are sent at all.
    const streak = ctx?.witnessing === 'audience' && !ctx.sharers.has(m) ? [] : archiveOf(all, m, ctx).map((s) => snapRow(s))
    return { rows, queue, streak, witnessed: shelf.length }
  }

  async function listWitnessed(m: M): Promise<SnapRow[]> {
    const ctx = await circle()
    const all = await readSnaps()
    // The shelf is whatever the home is not: witnessed snaps, or with the home as the last day, older ones.
    return Promise.all((features.home === 'today' ? earlierOf(all, m, new Date(), ctx) : witnessedOf(all, m, ctx)).map(tileRow))
  }

  async function getSnapView(m: M, id: string): Promise<SnapView<M> | null> {
    const ctx = await circle()
    const doc = await snaps().doc(id).get()
    if (!doc.exists) return null
    const s = snapFrom(doc)
    return canSeeSnap(s, m, ctx) ? withUrls(s) : null
  }

  // Read-apply-write, shared by every mutation. `update` throws to refuse, or returns null to leave
  // the snap exactly as read, unwritten.
  async function rewrite(id: string, update: (s: Snap<M>) => Snap<M> | null): Promise<Snap<M>> {
    const ref = snaps().doc(id)
    return host.db().runTransaction(async (tx) => {
      const doc = await tx.get(ref)
      if (!doc.exists) throw new RuleError('snap not found', 404)
      const current = snapFrom(doc)
      const updated = update(current)
      if (updated === null) return current
      const { id: _id, ...data } = updated
      tx.set(ref, data)
      return updated
    })
  }

  // `before` is handed the snap as it was read, so a route can tell a change from a repeat.
  async function patchSnap(m: M, id: string, patch: SnapPatch, opts: { now?: string; before?: (s: Snap<M>) => void } = {}): Promise<Snap<M>> {
    const ctx = await circle()
    const tags = patch.kind === 'tag' ? await tagSet() : undefined
    return rewrite(id, (s) => {
      // A hidden snap the caller cannot see answers exactly like one that does not exist.
      if (!canSeeSnap(s, m, ctx)) throw new RuleError('snap not found', 404)
      opts.before?.(s)
      return applySnapPatch(s, m, patch, { now: opts.now, ctx, tags, maxTags, justUs: features.justUs }) as Snap<M>
    })
  }

  async function listQueue(m: M): Promise<SnapView<M>[]> {
    const ctx = await circle()
    return Promise.all(queueOf(await readSnaps(), m, ctx).map(withUrls))
  }

  async function cowitnessSummary(m: M, lastSeenAt: string): Promise<CowitnessSummary> {
    const ctx = await circle()
    const all = await readSnaps()
    const cover = coverOf(all, m, ctx)
    const coverUrl = cover ? await host.media.signedUrl(cover.paths.thumb) : null
    return cowitnessTile(all, m, lastSeenAt, coverUrl, ctx)
  }

  async function visibleSnap(m: M, id: string): Promise<Snap<M>> {
    const ctx = await circle()
    const doc = await snaps().doc(id).get()
    if (!doc.exists) throw new RuleError('snap not found', 404)
    const s = snapFrom(doc)
    if (!canSeeSnap(s, m, ctx)) throw new RuleError('snap not found', 404)
    return s
  }

  // The signed PUT a reaction goes up with, straight to storage (a request body over 4.5 MB never
  // reaches a route). The id comes from the phone's own vault record, so a resend reuses it, and if
  // the bytes are already there nothing is signed at all: a second create-once PUT would only 412.
  async function reactionUploadUrl(
    m: M, snapId: string, input: { contentType: unknown; size: unknown; durationSec: unknown; commentId: unknown },
  ): Promise<ReactionTicket> {
    const { contentType } = validateReactionClip(input)
    const commentId = validateCommentId(input.commentId)
    await visibleSnap(m, snapId)
    const file = audioFile(snapId, commentId, contentType)
    const [exists] = await file.exists()
    if (exists) return reactionTicket(commentId, true, '', {})
    const extensionHeaders = { 'x-goog-content-length-range': `0,${CLIP_MAX_BYTES}`, 'x-goog-if-generation-match': '0' }
    const [url] = await file.getSignedUrl({
      version: 'v4', action: 'write', expires: Date.now() + REACTION_UPLOAD_WINDOW_MS, contentType, extensionHeaders,
    })
    return reactionTicket(commentId, false, url, { 'Content-Type': contentType, ...extensionHeaders })
  }

  // The recording is in storage; file it under the snap as a message. Idempotent by id, and
  // `created` tells the route whether to schedule a transcription at all.
  async function attachReaction(
    m: M, snapId: string, input: { commentId: unknown; contentType: unknown; durationSec: unknown },
  ): Promise<{ snap: Snap<M>; created: boolean }> {
    const commentId = validateCommentId(input.commentId)
    const ct = typeof input.contentType === 'string' ? input.contentType.split(';')[0].trim() : ''
    const file = audioFile(snapId, commentId, ct)
    const [exists] = await file.exists()
    if (!exists) throw new RuleError('that recording did not finish uploading', 404)
    const [md] = await file.getMetadata()
    const { contentType, durationSec } = validateReactionClip({ contentType: ct, size: Number(md.size), durationSec: input.durationSec })
    // With no transcriber the recording is filed settled: playable, with no words to wait for.
    const rec: Recording = { path: file.name, contentType, durationSec, ...(host.transcription ? { status: 'transcribing' as const } : {}) }
    const ctx = await circle()
    let created = false
    const snap = await rewrite(snapId, (s) => {
      // A snap kept from this person answers like one that does not exist; one hidden from them keeps its old answer.
      if ((s.hiddenAt === null || s.by === m) && !canSeeSnap(s, m, ctx)) throw new RuleError('snap not found', 404)
      created = !(s.comments ?? []).some((c) => c.id === commentId)
      return addVoiceReaction(s, m, commentId, rec, { now: nowIso(), ctx }) as Snap<M>
    })
    return { snap, created }
  }

  async function reactionAudioUrl(m: M, snapId: string, commentId: string): Promise<string> {
    const s = await visibleSnap(m, snapId)
    const rec = s.comments?.find((c) => c.id === commentId && !c.discardedAt)?.recording
    if (!rec) throw new RuleError('recording not found', 404)
    return host.media.signedUrl(rec.path)
  }

  const transcriber = () => {
    if (!host.transcription) throw new RuleError('transcription is not available', 404)
    return host.transcription
  }

  async function transcriptSettled(result: Promise<Snap<M>>): Promise<Snap<M>> {
    const snap = await result
    try { await host.transcription?.settled?.(snap) }
    catch (err) { try { host.log?.('transcription.settled failed', err) } catch { /* committed words remain saved */ } }
    return snap
  }

  // The model call and the write of what came back, shared by the auto path and Try again. Both
  // callers marked the recording 'transcribing' in their own transaction first.
  async function finishTranscription(snapId: string, commentId: string, marked: Snap<M>, language: string): Promise<Snap<M>> {
    const t = transcriber()
    const c = (marked.comments ?? []).find((x) => x.id === commentId)!
    const rec = c.recording!
    // A run overtaken by a newer one (Try again after it stalled) writes nothing: not its words over
    // the newer ones, and not a cleared status while the newer run is still going.
    const stillThisRun = (s: Snap<M>) => {
      const now = (s.comments ?? []).find((x) => x.id === commentId)?.recording
      return now?.status === 'transcribing' && rec.startedAt !== undefined && now.startedAt === rec.startedAt
    }
    let words: string
    try {
      const file = host.storage.bucket().file(rec.path)
      const [exists] = await file.exists()
      if (!exists) throw new RuleError('that recording is no longer in storage', 404)
      const [audio] = await file.download()
      words = await t.transcribe(audio, rec.contentType, { language, speaker: c.by })
    } catch (err) {
      console.error(`transcribeReaction: ${rec.path}`, err)
      // A refusal written for a reader (ours or the transcriber's own) keeps its words.
      const reason = (isRuleError(err) || host.isRefusal?.(err) === true) ? (err as Error).message : 'the recording could not be made out'
      return transcriptSettled(rewrite(snapId, (s) => (stillThisRun(s) ? failReactionTranscript(s, commentId, reason) as Snap<M> : null)))
    }
    return transcriptSettled(rewrite(snapId, (s) => (stillThisRun(s) ? setReactionTranscript(s, commentId, words) as Snap<M> : null)))
  }

  // The AUTO path, scheduled by the attach route right after it creates a reaction. A no-op unless
  // the recording is still exactly as attachReaction left it, so it can never run twice over one.
  async function transcribeReaction(snapId: string, commentId: string, language?: unknown): Promise<Snap<M>> {
    const lang = spokenLanguage(language, transcriber().languages)
    let ran = true
    const marked = await rewrite(snapId, (s) => {
      const c = (s.comments ?? []).find((x) => x.id === commentId)
      if (!c?.recording || c.discardedAt) throw new RuleError('reaction not found', 404)
      if (!canAutoTranscribe(c.recording)) { ran = false; return s }
      return markTranscribing(s, commentId, lang === 'auto' ? undefined : lang, { now: nowIso() }) as Snap<M>
    })
    if (!ran) return marked
    return finishTranscription(snapId, commentId, marked, lang)
  }

  // Try again, from anyone who can see the snap. Refused with a conflict while a genuine
  // transcription is still live; recovers one the platform killed mid-run.
  async function retranscribeReaction(m: M, snapId: string, commentId: string, language?: unknown): Promise<Snap<M>> {
    const lang = spokenLanguage(language, transcriber().languages)
    const ctx = await circle()
    const marked = await rewrite(snapId, (s) => {
      if (!canSeeSnap(s, m, ctx)) throw new RuleError('snap not found', 404)
      const c = (s.comments ?? []).find((x) => x.id === commentId)
      if (!c?.recording || c.discardedAt) throw new RuleError('reaction not found', 404)
      if (!canRetranscribe(c.recording, c.at, nowIso())) throw new RuleError('this reaction is still being transcribed', 409)
      return markTranscribing(s, commentId, lang === 'auto' ? undefined : lang, { now: nowIso() }) as Snap<M>
    })
    return finishTranscription(snapId, commentId, marked, lang)
  }

  const voiceOn = () => { if (!features.voiceSnaps) throw new RuleError('voice notes are not on here', 404) }
  const voiceFile = (snapId: string, contentType: string) => host.storage.bucket().file(voiceSnapPath(host.storage.prefix, snapId, contentType))
  const audioType = (v: unknown) => {
    const ct = typeof v === 'string' ? v.split(';')[0].trim() : ''
    if (!(CLIP_CONTENT_TYPES as readonly string[]).includes(ct)) throw new RuleError('unsupported audio type', 400)
    return ct
  }
  // One id is one recording: the type its first upload went up as is the only one it ever has.
  async function assertOneType(snapId: string, contentType: string): Promise<void> {
    const mine = voiceSnapPath(host.storage.prefix, snapId, contentType)
    for (const path of voiceSnapPaths(host.storage.prefix, snapId)) {
      if (path === mine) continue
      const [there] = await host.storage.bucket().file(path).exists()
      if (there) throw new RuleError('that id is already a recording of another type', 409)
    }
  }
  // The bytes at a voice path are someone's only if the signed PUT that put them there was issued
  // to them: that PUT had to send the uploader header, so storage keeps who it was. Bytes nobody
  // signed for, or that someone else uploaded, are a ticket that is not this person's.
  async function ownUpload(m: M, file: ReturnType<typeof voiceFile>): Promise<{ size: number; contentType?: string }> {
    const [md] = await file.getMetadata()
    const meta = (md as { metadata?: Record<string, unknown> }).metadata
    if (meta?.[VOICE_UPLOADER_KEY] !== m) throw new RuleError('that recording is not yours to file', 403)
    return { size: Number(md.size), contentType: typeof md.contentType === 'string' ? md.contentType : undefined }
  }

  // The signed PUT a voice note goes up with, straight to storage. The id is the phone's own held
  // recording's, so a resend reuses it; if the bytes are already there nothing is signed, and a
  // second PUT to the same id is refused by storage itself (create-once).
  async function voiceUploadUrl(
    m: M, input: { snapId: unknown; contentType: unknown; size: unknown; durationSec: unknown },
  ): Promise<{ snapId: string; uploaded: true } | { snapId: string; url: string; requiredHeaders: Record<string, string> }> {
    voiceOn()
    assertCanShare(m, await circle())
    const snapId = validateClientId(input.snapId, 'snapId')
    const { contentType } = validateClip(input)
    if ((await snaps().doc(snapId).get()).exists) throw new RuleError('that snap already exists', 409)
    await assertOneType(snapId, contentType)
    const file = voiceFile(snapId, contentType)
    const [exists] = await file.exists()
    if (exists) {
      await ownUpload(m, file)
      return { snapId, uploaded: true as const }
    }
    const extensionHeaders = {
      'x-goog-content-length-range': `0,${CLIP_MAX_BYTES}`, 'x-goog-if-generation-match': '0', [`x-goog-meta-${VOICE_UPLOADER_KEY}`]: m as string,
    }
    const [url] = await file.getSignedUrl({ version: 'v4', action: 'write', expires: Date.now() + REACTION_UPLOAD_WINDOW_MS, contentType, extensionHeaders })
    return { snapId, url, requiredHeaders: { 'Content-Type': contentType, ...extensionHeaders } }
  }

  // Filed once per id: the same person filing the same id again gets the snap back (a resend after
  // a lost answer); anyone else is refused, so an id can never be taken over. Everything the phone
  // says is checked before storage is read, and the size is the bytes that actually arrived.
  async function fileVoiceSnap(
    m: M, input: { snapId: unknown; contentType: unknown; durationSec: unknown; caption?: unknown; language?: unknown; justUs?: unknown; tags?: unknown },
  ): Promise<{ snap: Snap<M>; created: boolean }> {
    voiceOn()
    const snapId = validateClientId(input.snapId, 'snapId')
    const caption = validateCaption(input.caption)
    const extra = await filingExtras(m, input)
    const ct = audioType(input.contentType)
    const ref = snaps().doc(snapId)
    const existing = (s: Snap<M>) => {
      if (s.by !== m || s.kind !== 'voice') throw new RuleError('that snap already exists', 409)
      return { snap: s, created: false }
    }
    const prior = await ref.get()
    if (prior.exists) return existing(snapFrom(prior))
    await assertOneType(snapId, ct)
    const file = voiceFile(snapId, ct)
    const [exists] = await file.exists()
    if (!exists) throw new RuleError('that recording did not finish uploading', 404)
    const stored = await ownUpload(m, file)
    if (stored.contentType && stored.contentType.split(';')[0].trim() !== ct) throw new RuleError('that recording is not the type it was sent as', 400)
    const { contentType, durationSec } = validateClip({ contentType: ct, size: stored.size, durationSec: input.durationSec })
    const language = host.transcription ? spokenLanguage(input.language, host.transcription.languages) : undefined
    // With no transcriber the recording is filed settled: playable, with no words to wait for.
    const voice: VoiceInfo = {
      path: file.name, contentType, durationSec, text: '',
      ...(language && language !== 'auto' ? { language } : {}), ...(host.transcription ? { status: 'transcribing' as const } : {}),
    }
    return host.db().runTransaction(async (tx) => {
      const doc = await tx.get(ref)
      if (doc.exists) return existing(snapFrom(doc))
      const data = newVoiceSnap(m, voice, caption, nowIso(), extra) as Omit<Snap<M>, 'id'>
      tx.set(ref, data)
      return { snap: { id: snapId, ...data }, created: true }
    })
  }

  // The model call and the write of what came back, shared by the auto path and Try again.
  async function finishVoiceTranscription(snapId: string, marked: Snap<M>, language: string): Promise<Snap<M>> {
    const t = transcriber()
    const v = marked.voice!
    let words: string
    try {
      const f = host.storage.bucket().file(v.path)
      const [exists] = await f.exists()
      if (!exists) throw new RuleError('that recording is no longer in storage', 404)
      const [audio] = await f.download()
      words = await t.transcribe(audio, v.contentType, { language, speaker: marked.by })
    } catch (err) {
      console.error(`transcribeVoiceSnap: ${v.path}`, err)
      const reason = (isRuleError(err) || host.isRefusal?.(err) === true) ? (err as Error).message : 'the recording could not be made out'
      return transcriptSettled(rewrite(snapId, (s) => (isVoiceRun(s, v.startedAt) ? failVoiceTranscript(s, reason) as Snap<M> : null)))
    }
    return transcriptSettled(rewrite(snapId, (s) => (isVoiceRun(s, v.startedAt) ? setVoiceTranscript(s, words) as Snap<M> : null)))
  }

  // The AUTO path, scheduled by the voice route right after it files a snap. A no-op unless the
  // recording is still exactly as filed, so it can never run twice over one.
  async function transcribeVoiceSnap(snapId: string, language?: unknown): Promise<Snap<M>> {
    const lang = spokenLanguage(language, transcriber().languages)
    let ran = true
    const marked = await rewrite(snapId, (s) => {
      if (!s.voice || !canAutoTranscribe(s.voice)) { ran = false; return s }
      return markVoiceTranscribing(s, lang === 'auto' ? s.voice.language : lang, { now: nowIso() }) as Snap<M>
    })
    return ran ? finishVoiceTranscription(snapId, marked, marked.voice?.language ?? lang) : marked
  }

  // Try again: its author at any time but a live run, anyone else who can see it only a failed or
  // stalled run (assertMayRetranscribeVoice).
  async function retranscribeVoiceSnap(m: M, snapId: string, language?: unknown): Promise<Snap<M>> {
    voiceOn()
    const lang = spokenLanguage(language, transcriber().languages)
    const ctx = await circle()
    const marked = await rewrite(snapId, (s) => {
      if (!canSeeSnap(s, m, ctx)) throw new RuleError('snap not found', 404)
      assertMayRetranscribeVoice(s, m, nowIso())
      return markVoiceTranscribing(s, lang === 'auto' ? undefined : lang, { now: nowIso() }) as Snap<M>
    })
    return finishVoiceTranscription(snapId, marked, lang)
  }

  const promptsOn = () => {
    if (!features.prompts || !host.prompts) throw new RuleError('reminders are not on here', 404)
    return host.prompts
  }
  const report = (what: string, err: unknown) => { try { host.log?.(what, err) } catch { /* a log that throws is dropped too */ } }

  // Each reminder is claimed with create() BEFORE it is sent, so two overlapping runs, a late run
  // and a repeated run can never send the same slot on the same day twice (the claim's id is the
  // slot's key). A nudge that fails keeps its claim: a reminder sent twice is worse than one missed.
  async function sendDuePrompts(now: Date): Promise<string[]> {
    const p = promptsOn()
    const today = zoned(now, p.timeZone).dayKey
    const claims = host.db().collection(p.collection)
    const sent = new Set((await claims.where('dayKey', '==', today).get()).docs.map((d) => d.id))
    const done: string[] = []
    const people = (await p.people()).filter((x) => {
      if (validPromptTimes(x.times)) return true
      report('prompts.times invalid', { person: x.key })
      return false
    })
    for (const due of promptsDue(now, p.timeZone, people, sent)) {
      try { await claims.doc(due.slotKey).create({ dayKey: today, person: due.key, sentAt: now.toISOString() }) } catch (err) {
        // Already claimed (gRPC 6) is the normal "someone sent it"; anything else is reported.
        if ((err as { code?: unknown }).code !== 6) report('prompts.claim failed', err)
        continue
      }
      try { await p.nudge(due.key, due.slotKey) } catch (err) { report('prompts.nudge failed', err) }
      done.push(due.slotKey)
    }
    return done
  }

  async function promptPerson(m: M) {
    const p = promptsOn()
    const me = (await p.people()).find((x) => x.key === m)
    if (!me) throw new RuleError('you have no reminders here', 403)
    return { p, me }
  }

  async function promptSettings(m: M): Promise<PromptSettings & { today: string }> {
    const { p, me } = await promptPerson(m)
    return { times: me.times, snoozedUntil: me.snoozedUntil, today: zoned(new Date(), p.timeZone).dayKey }
  }

  async function savePromptSettings(m: M, body: unknown): Promise<PromptSettings> {
    const { p, me } = await promptPerson(m)
    const next = parsePromptPatch(body, { times: me.times, snoozedUntil: me.snoozedUntil }, zoned(new Date(), p.timeZone).dayKey)
    await p.save(m, next)
    return next
  }

  // What this person may do here. In the each-other kind everyone does both.
  async function whoAmI(m: M): Promise<{ share: boolean; witness: boolean }> {
    const ctx = await circle()
    if (ctx?.witnessing !== 'audience') return { share: true, witness: true }
    return { share: ctx.sharers.has(m), witness: ctx.witnesses.has(m) }
  }
  const tagChoices = async (): Promise<TagChoice[]> => (features.tags ? host.tags!.list() : [])

  return {
    features, whoAmI, tagChoices,
    finalizeSnapPhoto, finalizeSnapVideo, readSnaps, listSnaps, listCowitness, listWitnessed, getSnapView, patchSnap,
    listQueue, cowitnessSummary, reactionUploadUrl, attachReaction, reactionAudioUrl, transcribeReaction, retranscribeReaction,
    sendDuePrompts, promptSettings, savePromptSettings,
    voiceUploadUrl, fileVoiceSnap, transcribeVoiceSnap, retranscribeVoiceSnap,
  }
}

export type CowitnessStore<M extends string> = ReturnType<typeof createCowitnessStore<M>>
