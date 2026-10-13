import { RuleError, parseCommentHeart, parseCommentBody, validateVideoDims, localTakenAt } from '../shared-rules.js'
import type { SnapPatch } from '../types.js'

const id = (v: unknown, name: string): string => {
  if (typeof v !== 'string' || !v) throw new RuleError(`${name} is required`, 400)
  return v
}

// The caption is passed through untouched; validateCaption in the store is its one judge.
export function parseSnapPhotoBody(body: unknown): { photoId: string; caption?: unknown; clientTakenAt?: string; justUs?: unknown; tags?: unknown; batch?: unknown } {
  const b = (body ?? {}) as Record<string, unknown>
  return {
    photoId: id(b.photoId, 'photoId'),
    caption: b.caption,
    clientTakenAt: typeof b.clientTakenAt === 'string' ? b.clientTakenAt : undefined,
    ...('justUs' in b ? { justUs: b.justUs } : {}), ...('tags' in b ? { tags: b.tags } : {}), ...('batch' in b ? { batch: b.batch } : {}),
  }
}

export function parseSnapVideoBody(body: unknown): {
  photoId: string; caption?: unknown; meta: { durationSec: number; width: number; height: number; takenAt?: string }
  justUs?: unknown; tags?: unknown
} {
  const b = (body ?? {}) as Record<string, unknown>
  const photoId = id(b.photoId, 'photoId')
  const dims = validateVideoDims({ durationSec: b.durationSec, width: b.width, height: b.height })
  return { photoId, caption: b.caption, meta: { ...dims, takenAt: localTakenAt(b.takenAt) }, ...('justUs' in b ? { justUs: b.justUs } : {}), ...('tags' in b ? { tags: b.tags } : {}) }
}

export function parseSnapPatch(body: unknown, allow: { tags?: boolean; justUs?: boolean } = {}): SnapPatch {
  const b = (body ?? {}) as { kind?: unknown; text?: unknown; commentId?: unknown; value?: unknown; images?: unknown; ids?: unknown; emoji?: unknown }
  switch (b.kind) {
    case 'comment':
      return parseCommentBody(b)
    case 'comment-heart':
      return parseCommentHeart(b)
    case 'reaction':
      if (typeof b.emoji !== 'string' || typeof b.value !== 'boolean') throw new RuleError('emoji and boolean value are required', 400)
      return { kind: 'reaction', emoji: b.emoji, value: b.value }
    case 'discard-reaction':
      return { kind: 'discard-reaction', commentId: id(b.commentId, 'commentId') }
    case 'hide':
      return { kind: 'hide' }
    case 'unhide':
      return { kind: 'unhide' }
    case 'witness':
      if (b.text !== undefined && typeof b.text !== 'string') throw new RuleError('text must be a string', 400)
      return typeof b.text === 'string' ? { kind: 'witness', text: b.text } : { kind: 'witness' }
    // With its option off, each new kind is refused exactly as before options existed, before anything is read.
    case 'tag': {
      if (!allow.tags) throw new RuleError('unknown patch kind', 400)
      if (!Array.isArray(b.ids)) throw new RuleError('ids must be a list', 400)
      return { kind: 'tag', ids: b.ids as string[] }
    }
    case 'just-us':
      if (!allow.justUs) throw new RuleError('unknown patch kind', 400)
      if (typeof b.value !== 'boolean') throw new RuleError('value must be a boolean', 400)
      return { kind: 'just-us', value: b.value }
    default:
      throw new RuleError('unknown patch kind', 400)
  }
}
