// Which of Cowitness's options an app turned on. Every option is off unless the host says
// otherwise, and the defaults are exactly how the package behaved before options existed.
export type Witnessing = 'each-other' | 'audience'
export type HomeWindow = 'open' | 'today'
export type HouseholdStreakRule = { kind: 'household'; timeZone: string; since: string; freeSkipsPerWeek: 0 | 1 }
export type StreakRule = { kind: 'each-and-together' } | HouseholdStreakRule

export interface CowitnessFeatures {
  /** each-other: everyone shares and witnesses everyone else. audience: people() says who shares and who witnesses, and each witness has their own seen. */
  witnessing: Witnessing
  /** A voice note can be shared as a snap. */
  voiceSnaps: boolean
  /** A snap can be marked visible to the people who share only. */
  justUs: boolean
  /** A snap can be tagged from a list the app supplies. */
  tags: boolean
  /** The share sheet offers the double camera. */
  doubleCamera: boolean
  /** Capture reminders at each person's own times, one person per reminder. */
  prompts: boolean
  /** each-and-together: a streak per person and one together, in the phone's own day. household: one count for everyone who shares, in one time zone, from a start date. */
  streak: StreakRule
  /** open: the home holds what nobody has witnessed yet, and the shelf what has been. today: the home holds the last 24 hours, witnessed or not, and the shelf everything older. Nothing is ever deleted either way. */
  home: HomeWindow
  /** The photo picker takes several photos at once (up to 10), each filed as its own snap under one caption. */
  multiPhoto: boolean
}

export const DEFAULT_FEATURES: Readonly<CowitnessFeatures> = Object.freeze({
  witnessing: 'each-other', voiceSnaps: false, justUs: false, tags: false, doubleCamera: true, prompts: false,
  streak: Object.freeze({ kind: 'each-and-together' }) as StreakRule, home: 'open', multiPhoto: false,
})

const DAY_KEY = /^\d{4}-\d{2}-\d{2}$/

function knownZone(tz: string): boolean {
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true } catch { return false }
}

// A wrong setting is the app's mistake, found when the app starts rather than when a person taps.
// A misspelt option name would leave the option silently off, so it is refused like a wrong value.
const OPTION_NAMES = Object.keys(DEFAULT_FEATURES) as (keyof CowitnessFeatures)[]

export function resolveFeatures(f: Partial<CowitnessFeatures> = {}): CowitnessFeatures {
  const unknown = Object.keys(f).filter((k) => !(OPTION_NAMES as string[]).includes(k))
  if (unknown.length) throw new Error(`cowitness: unknown option ${unknown.join(', ')}; the options are ${OPTION_NAMES.join(', ')}`)
  const set = Object.fromEntries(Object.entries(f).filter(([, v]) => v !== undefined)) as Partial<CowitnessFeatures>
  const out: CowitnessFeatures = { ...DEFAULT_FEATURES, ...set }
  if (out.witnessing !== 'each-other' && out.witnessing !== 'audience') throw new Error(`cowitness: witnessing must be each-other or audience, not ${String(out.witnessing)}`)
  if (out.home !== 'open' && out.home !== 'today') throw new Error(`cowitness: home must be open or today, not ${String(out.home)}`)
  if (out.streak.kind === 'household') {
    if (!knownZone(out.streak.timeZone)) throw new Error(`cowitness: the household streak's time zone ${out.streak.timeZone} is not one this runtime knows`)
    if (!DAY_KEY.test(out.streak.since)) throw new Error('cowitness: the household streak needs since as YYYY-MM-DD')
    if (out.streak.freeSkipsPerWeek !== 0 && out.streak.freeSkipsPerWeek !== 1) throw new Error('cowitness: freeSkipsPerWeek must be 0 or 1')
  } else if (out.streak.kind !== 'each-and-together') {
    throw new Error('cowitness: streak.kind must be each-and-together or household')
  }
  return out
}

export type Role = 'shares' | 'witnesses' | 'both'
export interface Person<M extends string = string> { key: M; role: Role }

// Who may share and who may witness, read from the app's people. Every rule that takes a Circle
// behaves exactly as it did before options existed when it is given none.
export interface Circle<M extends string = string> { witnessing: Witnessing; sharers: ReadonlySet<M>; witnesses: ReadonlySet<M> }

export function circleOf<M extends string>(witnessing: Witnessing, people: Person<M>[]): Circle<M> {
  return {
    witnessing,
    sharers: new Set(people.filter((p) => p.role !== 'witnesses').map((p) => p.key)),
    witnesses: new Set(people.filter((p) => p.role !== 'shares').map((p) => p.key)),
  }
}
