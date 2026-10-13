import { RuleError } from './errors.js'
import type { Snap, SnapBatch } from './types.js'

// Tags come from a list the app supplies (for example, the firsts a household is waiting for).
// A snap carries at most `max` of them, default one.
export const TAGS_MAX_DEFAULT = 1

export function validateTags(v: unknown, valid: ReadonlySet<string> | undefined, max: number): string[] | undefined {
  if (v === undefined || v === null) return undefined
  if (!valid) throw new RuleError('tags are not on here', 400)
  if (!Array.isArray(v) || v.some((t) => typeof t !== 'string')) throw new RuleError('tags must be a list of ids', 400)
  const ids = [...new Set(v as string[])]
  if (ids.length > max) throw new RuleError(`at most ${max} tag${max === 1 ? '' : 's'}`, 400)
  if (ids.some((t) => !valid.has(t))) throw new RuleError('unknown tag', 400)
  return ids.length ? ids : undefined
}

// "Just us" is stored only as true; off is the key's absence, so an old record and an unmarked one
// read the same.
export function validateJustUs(v: unknown, on: boolean): true | undefined {
  if (v === undefined || v === null || v === false) return undefined
  if (v !== true) throw new RuleError('justUs must be true or false', 400)
  if (!on) throw new RuleError('"just us" is not on here', 400)
  return true
}

// Photos sent together carry one mark each: the send's id, the photo's place in it and how many were
// sent. Stored as exactly those three, so nothing else a phone sends rides along; off is the key's
// absence, so an old record and a single photo read the same.
export const BATCH_MAX = 10
export function validateBatch(v: unknown, on: boolean): SnapBatch | undefined {
  if (v === undefined || v === null) return undefined
  if (!on) throw new RuleError('several photos at once is not on here', 400)
  if (typeof v !== 'object' || Array.isArray(v)) throw new RuleError('batch must be an object', 400)
  const { id, index, size } = v as Record<string, unknown>
  if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{8,40}$/.test(id)) throw new RuleError('batch id is not valid', 400)
  if (!Number.isInteger(size) || (size as number) < 2 || (size as number) > BATCH_MAX) throw new RuleError(`a batch holds 2 to ${BATCH_MAX} photos`, 400)
  if (!Number.isInteger(index) || (index as number) < 0 || (index as number) >= (size as number)) throw new RuleError('batch place is not valid', 400)
  return { id, index: index as number, size: size as number }
}

// The tags a tag patch should announce: the new set, only when it differs from the old one and is
// not empty. Re-tagging with the same tags, or clearing them, announces nothing.
export function tagsToAnnounce(before: Pick<Snap, 'tags'>, after: Pick<Snap, 'tags'>): string[] | undefined {
  const next = after.tags ?? []
  if (!next.length) return undefined
  const prev = before.tags ?? []
  const same = prev.length === next.length && next.every((t) => prev.includes(t))
  return same ? undefined : next
}
