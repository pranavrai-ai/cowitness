import { describe, expect, it } from 'vitest'
import { DEFAULT_FEATURES, circleOf, resolveFeatures } from './features.js'

describe('resolveFeatures', () => {
  it('turns nothing on by default: each other, the double camera, the per-person streak', () => {
    expect(resolveFeatures()).toEqual({
      witnessing: 'each-other', voiceSnaps: false, justUs: false, tags: false, doubleCamera: true, prompts: false, multiPhoto: false,
      streak: { kind: 'each-and-together' }, home: 'open',
    })
    expect(resolveFeatures({})).toEqual(DEFAULT_FEATURES)
  })
  it('the home is open snaps by default, or the last day when the app asks, and nothing else', () => {
    expect(resolveFeatures({ home: 'today' }).home).toBe('today')
    expect(() => resolveFeatures({ home: 'week' as never })).toThrow(/home must be open or today/)
  })
  it('keeps what a host turned on and ignores what it left undefined', () => {
    expect(resolveFeatures({ voiceSnaps: true, justUs: undefined })).toMatchObject({ voiceSnaps: true, justUs: false })
  })
  it('refuses a household streak with a zone, a start or a skip count it cannot use', () => {
    const household = { kind: 'household' as const, timeZone: 'America/Los_Angeles', since: '2026-09-01', freeSkipsPerWeek: 1 as const }
    expect(resolveFeatures({ streak: household }).streak).toEqual(household)
    expect(() => resolveFeatures({ streak: { ...household, timeZone: 'Nowhere/Else' } })).toThrow(/time zone/)
    expect(() => resolveFeatures({ streak: { ...household, since: '9/1/2026' } })).toThrow(/since/)
    expect(() => resolveFeatures({ streak: { ...household, freeSkipsPerWeek: 2 as never } })).toThrow(/freeSkipsPerWeek/)
  })
  it('refuses an option name it does not know, naming it and listing the ones it does', () => {
    expect(() => resolveFeatures({ justus: true } as never)).toThrow(/justus/)
    expect(() => resolveFeatures({ justus: true } as never)).toThrow(/witnessing, voiceSnaps, justUs, tags, doubleCamera, prompts, streak/)
  })
  it('refuses a witnessing kind it does not know', () => {
    expect(() => resolveFeatures({ witnessing: 'everyone' as never })).toThrow(/witnessing/)
  })
})

describe('circleOf', () => {
  it('sorts people into who shares and who witnesses; both is in each', () => {
    const c = circleOf('audience', [{ key: 'ana', role: 'shares' }, { key: 'ben', role: 'both' }, { key: 'cy', role: 'witnesses' }])
    expect([...c.sharers].sort()).toEqual(['ana', 'ben'])
    expect([...c.witnesses].sort()).toEqual(['ben', 'cy'])
    expect(c.witnessing).toBe('audience')
  })
})
