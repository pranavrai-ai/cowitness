// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
const { scheduled } = vi.hoisted(() => ({ scheduled: [] as Promise<unknown>[] }))
vi.mock('next/server', async (orig) => ({ ...(await orig<typeof import('next/server')>()), after: (fn: () => Promise<unknown>) => { scheduled.push(fn()) } }))
import { askPeopleOnce, createCowitnessStore } from './store.js'
import { createCowitnessHandlers } from './handlers.js'
import { fakeHost, PHOTO, type M } from '../../test/support/fake-host.js'
import type { CowitnessHost } from './host.js'
import { circleOf, type Person } from '../features.js'
import { mayHear } from '../snap-rules.js'
import type { Snap } from '../types.js'

const SHARERS_AND_A_WITNESS: Person<M>[] = [{ key: 'ana', role: 'shares' }, { key: 'ben', role: 'shares' }, { key: 'cy', role: 'witnesses' }]

// ana and ben share; cy witnesses. Tags come from a two-item list.
function setup(features: CowitnessHost<M>['features'] = { witnessing: 'audience', justUs: true, tags: true }, who: Person<M>[] = SHARERS_AND_A_WITNESS) {
  const { host, f, b } = fakeHost({ features })
  const people = vi.fn(async () => who)
  const tagged = vi.fn()
  const spoken = vi.fn()
  const h: CowitnessHost<M> = {
    ...host, people, tags: { list: async () => [{ id: 't-first', label: 'First' }, { id: 't-second', label: 'Second' }] },
    announce: { ...host.announce, tagged, spoken },
  }
  const store = createCowitnessStore(h)
  return { host: h, store, f, b, tagged, spoken, people, routes: createCowitnessHandlers(h, store) }
}
const as = (host: CowitnessHost<M>, m: M) => vi.mocked(host.member).mockResolvedValue(m)
const post = (body: unknown) => new Request('https://x', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
const patch = (body: unknown) => new Request('https://x', { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
const get = () => new Request('https://x')
const id = (x: string) => ({ params: Promise.resolve({ id: x }) })
const rid = (x: string, c: string) => ({ params: Promise.resolve({ id: x, commentId: c }) })
const video = (photoId: string, extra: object = {}) => post({ photoId, durationSec: 3, width: 720, height: 1280, ...extra })

describe('the audience kind through the routes', () => {
  it('announces one fresh emoji even if a retry has the exact same clock stamp', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-10-12T18:00:00Z'))
    try {
      const { host, f } = setup()
      const reacted = vi.fn()
      const h = { ...host, announce: { ...host.announce, reacted } }
      const routes = createCowitnessHandlers(h)
      f.seed(h.collection, { p1: { ...PHOTO, by: 'ben', caption: '', createdAt: 'x', witnessedAt: null, hiddenAt: null } })
      for (const value of [true, true, false]) expect((await routes.snap.PATCH(patch({ kind: 'reaction', emoji: '🥹', value }), id('p1'))).status).toBe(200)
      expect(reacted).toHaveBeenCalledOnce()
    } finally { vi.useRealTimers() }
  })

  it('rejects a reaction recorded by a different signed-in person before upload or filing', async () => {
    const { routes } = setup()
    const body = { expectedBy: 'ben', commentId: 'r-abcdefgh', contentType: 'audio/mp4', durationSec: 4, size: 10 }
    expect((await routes.reactionUploadUrl.POST(post(body), id('p1'))).status).toBe(403)
    expect((await routes.reactions.POST(post(body), id('p1'))).status).toBe(403)
  })
  it('lets the people who share file, refuses a witness, and stores "just us" and tags', async () => {
    const { host, routes, f } = setup()
    as(host, 'cy')
    expect((await routes.photo.POST(post({ photoId: 'p0' }))).status).toBe(403)
    as(host, 'ana')
    expect((await routes.photo.POST(post({ photoId: 'p1', justUs: true, tags: ['t-first'] }))).status).toBe(200)
    expect(f.raw('snaps', 'p1')).toMatchObject({ justUs: true, tags: ['t-first'] })
    expect((await routes.photo.POST(post({ photoId: 'p2', tags: ['nope'] }))).status).toBe(400)
  })
  it('hides "just us" from a witness, and gives the witness their own queue and seen', async () => {
    const { host, routes, store, f } = setup()
    as(host, 'ana')
    await routes.photo.POST(post({ photoId: 'p1', justUs: true }))
    await routes.photo.POST(post({ photoId: 'p2' }))
    expect((await store.listQueue('cy')).map((s) => s.id)).toEqual(['p2'])
    expect(await store.getSnapView('cy', 'p1')).toBeNull()
    as(host, 'cy')
    expect((await routes.snap.PATCH(patch({ kind: 'witness', text: 'lovely' }), id('p2'))).status).toBe(200)
    expect(f.raw('snaps', 'p2')).toMatchObject({ witnessedBy: { cy: expect.any(String) } })
    expect(host.announce.witnessed).toHaveBeenCalledWith('cy', expect.objectContaining({ id: 'p2' }), 'lovely')
    expect(await store.whoAmI('cy')).toEqual({ share: false, witness: true })
  })
  it('tags and untags by patch, tells the app, and offers the app\'s list', async () => {
    const { host, routes, f, tagged, store } = setup()
    as(host, 'ana')
    await routes.photo.POST(post({ photoId: 'p1' }))
    as(host, 'ben')
    expect((await routes.snap.PATCH(patch({ kind: 'tag', ids: ['t-second'] }), id('p1'))).status).toBe(200)
    expect(tagged).toHaveBeenCalledWith('ben', expect.objectContaining({ id: 'p1' }), ['t-second'])
    expect(f.raw('snaps', 'p1')?.tags).toEqual(['t-second'])
    expect(await store.tagChoices()).toHaveLength(2)
  })
  it('announces a spoken reaction when the app asked to hear about one', async () => {
    const { host, routes, b, spoken } = setup()
    as(host, 'ana')
    await routes.photo.POST(post({ photoId: 'p1' }))
    as(host, 'cy')
    b.put('p/snaps-audio/p1/r-options01.m4a', Buffer.from('abcd'), 'audio/mp4')
    await routes.reactions.POST(post({ commentId: 'r-options01', contentType: 'audio/mp4', durationSec: 2 }), id('p1'))
    await Promise.all(scheduled)
    expect(spoken).toHaveBeenCalledWith('cy', expect.objectContaining({ id: 'p1' }), expect.objectContaining({ id: 'r-options01' }))
  })
})

describe('a snap filed with tags', () => {
  it('is announced as tagged after it is announced as shared, for a photo and for a video', async () => {
    const { host, routes, tagged } = setup()
    as(host, 'ana')
    await routes.photo.POST(post({ photoId: 'p1', tags: ['t-first'] }))
    expect(tagged).toHaveBeenCalledWith('ana', expect.objectContaining({ id: 'p1' }), ['t-first'])
    expect(vi.mocked(host.announce.shared).mock.invocationCallOrder[0]).toBeLessThan(tagged.mock.invocationCallOrder[0])
    await routes.video.POST(video('v1', { tags: ['t-second'] }))
    expect(tagged).toHaveBeenLastCalledWith('ana', expect.objectContaining({ id: 'v1' }), ['t-second'])
    expect(tagged).toHaveBeenCalledTimes(2)
  })
  it('is not announced as tagged when it carries none, or an empty list', async () => {
    const { host, routes, tagged } = setup()
    as(host, 'ana')
    await routes.photo.POST(post({ photoId: 'p1' }))
    await routes.photo.POST(post({ photoId: 'p2', tags: [] }))
    await routes.video.POST(video('v1'))
    expect(host.announce.shared).toHaveBeenCalledTimes(3)
    expect(tagged).not.toHaveBeenCalled()
  })
  it('is checked before the app\'s pipeline is touched: unknown tags, too many, and a "just us" that is not true or false', async () => {
    const { host, routes } = setup()
    as(host, 'ana')
    expect((await routes.photo.POST(post({ photoId: 'p1', tags: ['nope'] }))).status).toBe(400)
    expect((await routes.photo.POST(post({ photoId: 'p2', tags: ['t-first', 't-second'] }))).status).toBe(400)
    expect((await routes.photo.POST(post({ photoId: 'p3', justUs: 'yes' }))).status).toBe(400)
    expect((await routes.video.POST(video('v1', { tags: 't-first' }))).status).toBe(400)
    expect(host.media.filePhoto).not.toHaveBeenCalled()
    expect(host.media.fileVideo).not.toHaveBeenCalled()
  })
})

describe('a tag patch', () => {
  it('announces only a change to a non-empty set: the same tags again, or clearing them, is not news', async () => {
    const { host, routes, f, tagged } = setup()
    as(host, 'ana')
    await routes.photo.POST(post({ photoId: 'p1' }))
    expect((await routes.snap.PATCH(patch({ kind: 'tag', ids: ['t-first'] }), id('p1'))).status).toBe(200)
    expect(tagged).toHaveBeenCalledTimes(1)
    expect((await routes.snap.PATCH(patch({ kind: 'tag', ids: ['t-first'] }), id('p1'))).status).toBe(200)
    expect(tagged).toHaveBeenCalledTimes(1)
    expect((await routes.snap.PATCH(patch({ kind: 'tag', ids: [] }), id('p1'))).status).toBe(200)
    expect(f.raw('snaps', 'p1')).not.toHaveProperty('tags')
    expect(tagged).toHaveBeenCalledTimes(1)
    expect((await routes.snap.PATCH(patch({ kind: 'tag', ids: ['t-second'] }), id('p1'))).status).toBe(200)
    expect(tagged).toHaveBeenLastCalledWith('ana', expect.objectContaining({ id: 'p1' }), ['t-second'])
    expect(tagged).toHaveBeenCalledTimes(2)
  })
  it('refuses an unknown tag, and a tag from a witness', async () => {
    const { host, routes, tagged } = setup()
    as(host, 'ana')
    await routes.photo.POST(post({ photoId: 'p1' }))
    expect((await routes.snap.PATCH(patch({ kind: 'tag', ids: ['nope'] }), id('p1'))).status).toBe(400)
    as(host, 'cy')
    expect((await routes.snap.PATCH(patch({ kind: 'tag', ids: ['t-first'] }), id('p1'))).status).toBe(403)
    expect(tagged).not.toHaveBeenCalled()
  })
})

describe('the options the routes read are the store\'s', () => {
  it('accepts a tag or "just us" patch when the STORE has them on, whatever the host object handed to the routes says', async () => {
    const { host, store, f } = setup({ justUs: true, tags: true })
    const { features: _f, ...bare } = host
    const routes = createCowitnessHandlers(bare as CowitnessHost<M>, store)
    as(host, 'ana')
    await routes.photo.POST(post({ photoId: 'p1' }))
    expect((await routes.snap.PATCH(patch({ kind: 'tag', ids: ['t-first'] }), id('p1'))).status).toBe(200)
    expect((await routes.snap.PATCH(patch({ kind: 'just-us', value: true }), id('p1'))).status).toBe(200)
    expect(f.raw('snaps', 'p1')).toMatchObject({ tags: ['t-first'], justUs: true })
  })
  it('refuses them with the words it always used when the store has them off, whatever the host object says', async () => {
    const { host: plain } = fakeHost()
    const store = createCowitnessStore(plain)
    const routes = createCowitnessHandlers({ ...plain, features: { tags: true, justUs: true } } as CowitnessHost<M>, store)
    await routes.photo.POST(post({ photoId: 'p1' }))
    for (const body of [{ kind: 'tag', ids: ['t-first'] }, { kind: 'just-us', value: true }]) {
      const res = await routes.snap.PATCH(patch(body), id('p1'))
      expect([res.status, await res.json()]).toEqual([400, { error: 'unknown patch kind' }])
    }
  })
  it('refuses the patch of an option that is off while the other is on', async () => {
    const { host, routes } = setup({ justUs: true })
    as(host, 'ana')
    await routes.photo.POST(post({ photoId: 'p1' }))
    const res = await routes.snap.PATCH(patch({ kind: 'tag', ids: ['t-first'] }), id('p1'))
    expect([res.status, await res.json()]).toEqual([400, { error: 'unknown patch kind' }])
  })
})

describe('witnessing per person', () => {
  it('announces every witness in the audience kind, not only the first', async () => {
    const both: Person<M>[] = [{ key: 'ana', role: 'shares' }, { key: 'ben', role: 'both' }, { key: 'cy', role: 'witnesses' }]
    const { host, routes, f } = setup({ witnessing: 'audience' }, both)
    as(host, 'ana')
    await routes.photo.POST(post({ photoId: 'p1' }))
    as(host, 'cy')
    await routes.snap.PATCH(patch({ kind: 'witness' }), id('p1'))
    await new Promise((r) => setTimeout(r, 5))
    as(host, 'ben')
    expect((await routes.snap.PATCH(patch({ kind: 'witness', text: 'again' }), id('p1'))).status).toBe(200)
    expect(Object.keys(f.raw('snaps', 'p1')?.witnessedBy as object).sort()).toEqual(['ben', 'cy'])
    expect(host.announce.witnessed).toHaveBeenCalledTimes(2)
    expect(host.announce.witnessed).toHaveBeenLastCalledWith('ben', expect.objectContaining({ id: 'p1' }), 'again')
    // A witness's second tap is not news.
    await new Promise((r) => setTimeout(r, 5))
    as(host, 'cy')
    expect((await routes.snap.PATCH(patch({ kind: 'witness' }), id('p1'))).status).toBe(200)
    expect(host.announce.witnessed).toHaveBeenCalledTimes(2)
  })
  it('shelves a co-sharer\'s moment for a person who only shares once a witness has seen it', async () => {
    const { host, routes, store } = setup({ witnessing: 'audience' })
    as(host, 'ana')
    await routes.photo.POST(post({ photoId: 'p1' }))
    await routes.photo.POST(post({ photoId: 'p2' }))
    const open = async (m: M) => (await store.listCowitness(m)).rows.map((r) => r.id).sort()
    expect(await open('ben')).toEqual(['p1', 'p2'])
    as(host, 'cy')
    await routes.snap.PATCH(patch({ kind: 'witness' }), id('p1'))
    expect(await open('ben')).toEqual(['p2'])
    expect((await store.listCowitness('ben')).witnessed).toBe(1)
    expect((await store.listWitnessed('ben')).map((r) => r.id)).toEqual(['p1'])
    expect(await open('cy')).toEqual(['p2'])
    expect(await store.whoAmI('ben')).toEqual({ share: true, witness: false })
  })
  it('keeps a witness\'s own seen apart from another witness\'s', async () => {
    const both: Person<M>[] = [{ key: 'ana', role: 'shares' }, { key: 'ben', role: 'both' }, { key: 'cy', role: 'witnesses' }]
    const { host, routes, store } = setup({ witnessing: 'audience' }, both)
    as(host, 'ana')
    await routes.photo.POST(post({ photoId: 'p1' }))
    as(host, 'cy')
    await routes.snap.PATCH(patch({ kind: 'witness' }), id('p1'))
    expect((await store.listQueue('ben')).map((s) => s.id)).toEqual(['p1'])
    expect((await store.listCowitness('ben')).rows.map((r) => r.id)).toEqual(['p1'])
    expect(await store.listQueue('cy')).toEqual([])
  })
})

// Every way a list, a cover, a count or a single snap can reach a person, for a person who only witnesses.
async function nothingReaches(s: Pick<ReturnType<typeof setup>, 'host' | 'store' | 'routes'>) {
  const { host, store, routes } = s
  const home = await store.listCowitness('cy')
  expect(home.rows).toEqual([])
  expect(home.queue).toEqual([])
  expect(home.streak).toEqual([])
  expect(home.witnessed).toBe(0)
  expect(await store.listSnaps('cy')).toEqual([])
  expect(await store.listWitnessed('cy')).toEqual([])
  expect(await store.listQueue('cy')).toEqual([])
  expect(await store.getSnapView('cy', 'p1')).toBeNull()
  expect(await store.cowitnessSummary('cy', '2000-01-01T00:00:00.000Z')).toEqual({ count: 0, coverUrl: null, hasNew: false, waiting: 0 })
  as(host, 'cy')
  expect((await routes.snaps.GET(get())).status).toBe(200)
  expect(await (await routes.snaps.GET(get())).json()).toEqual([])
  expect((await routes.snap.GET(get(), id('p1'))).status).toBe(404)
  for (const body of [{ kind: 'witness' }, { kind: 'comment', text: 'hi' }, { kind: 'comment-heart', commentId: 'c-anything', value: true }]) {
    expect((await routes.snap.PATCH(patch(body), id('p1'))).status).toBe(404)
  }
  expect((await routes.reactionUploadUrl.POST(post({ commentId: 'r-leak0001', contentType: 'audio/mp4', size: 4, durationSec: 2 }), id('p1'))).status).toBe(404)
  expect((await routes.reactions.POST(post({ commentId: 'r-leak0001', contentType: 'audio/mp4', durationSec: 2 }), id('p1'))).status).toBe(404)
  expect((await routes.reactionAudio.GET(get(), rid('p1', 'r-ana00001'))).status).toBe(404)
  expect((await routes.reactionTranscribe.POST(post({}), rid('p1', 'r-ana00001'))).status).toBe(404)
  expect(host.announce.witnessed).not.toHaveBeenCalled()
  expect(host.announce.message).not.toHaveBeenCalled()
}

describe('"just us" never reaches a person who only witnesses', () => {
  for (const [kind, features] of [['the audience kind', { witnessing: 'audience', justUs: true }], ['the each-other kind with a circle', { justUs: true }]] as const) {
    it(`in ${kind}: not through a list, the shelf, the cover, the new mark, the count, a single snap, or a reaction`, async () => {
      // ben shares and witnesses, so the snap is witnessed and would sit on a shelf if it leaked.
      const s = setup(features, [{ key: 'ana', role: 'shares' }, { key: 'ben', role: 'both' }, { key: 'cy', role: 'witnesses' }])
      as(s.host, 'ana')
      expect((await s.routes.photo.POST(post({ photoId: 'p1', justUs: true }))).status).toBe(200)
      as(s.host, 'ben')
      expect((await s.routes.snap.PATCH(patch({ kind: 'witness', text: 'ours' }), id('p1'))).status).toBe(200)
      vi.mocked(s.host.announce.witnessed).mockClear()
      vi.mocked(s.host.announce.message).mockClear()
      as(s.host, 'ana')
      // ana's own spoken reaction is on it, so a listen or a Try again would have something to find.
      s.b.put('p/snaps-audio/p1/r-ana00001.m4a', Buffer.from('abcd'), 'audio/mp4')
      await s.routes.reactions.POST(post({ commentId: 'r-ana00001', contentType: 'audio/mp4', durationSec: 2 }), id('p1'))
      await Promise.all(scheduled)
      s.b.put('p/snaps-audio/p1/r-leak0001.m4a', Buffer.from('abcd'), 'audio/mp4')
      await nothingReaches(s)
      // ben shares, so he sees it, its cover, and its new mark.
      expect(await s.store.cowitnessSummary('ben', '2000-01-01T00:00:00.000Z')).toMatchObject({ count: 1, coverUrl: 'signed:p/thumb/x.jpg', hasNew: true })
    })
  }
  it('and the moment it is marked "just us" by patch, it leaves the witness\'s queue and tile', async () => {
    const s = setup({ witnessing: 'audience', justUs: true })
    as(s.host, 'ana')
    await s.routes.photo.POST(post({ photoId: 'p1' }))
    expect(await s.store.cowitnessSummary('cy', '2000-01-01T00:00:00.000Z')).toMatchObject({ count: 1, waiting: 1, hasNew: true })
    expect((await s.routes.snap.PATCH(patch({ kind: 'just-us', value: true }), id('p1'))).status).toBe(200)
    s.b.put('p/snaps-audio/p1/r-leak0001.m4a', Buffer.from('abcd'), 'audio/mp4')
    s.b.put('p/snaps-audio/p1/r-ana00001.m4a', Buffer.from('abcd'), 'audio/mp4')
    await nothingReaches(s)
  })
})

describe('every announcement of a "just us" snap carries what the host filters by', () => {
  it('shared, tagged, witnessed, message, heart and spoken are each handed the snap with justUs, and mayHear says no to a witness', async () => {
    const { host, routes, b, tagged, spoken } = setup(undefined, [{ key: 'ana', role: 'shares' }, { key: 'ben', role: 'both' }, { key: 'cy', role: 'witnesses' }])
    const circle = circleOf('audience', [{ key: 'ana', role: 'shares' }, { key: 'ben', role: 'both' }, { key: 'cy', role: 'witnesses' }])
    as(host, 'ana')
    await routes.photo.POST(post({ photoId: 'p1', justUs: true, tags: ['t-first'] }))
    await routes.snap.PATCH(patch({ kind: 'tag', ids: ['t-second'] }), id('p1'))
    as(host, 'ben')
    await routes.snap.PATCH(patch({ kind: 'witness' }), id('p1'))
    await routes.snap.PATCH(patch({ kind: 'comment', text: 'ours' }), id('p1'))
    b.put('p/snaps-audio/p1/r-ben00001.m4a', Buffer.from('abcd'), 'audio/mp4')
    await routes.reactions.POST(post({ commentId: 'r-ben00001', contentType: 'audio/mp4', durationSec: 2 }), id('p1'))
    await Promise.all(scheduled)
    as(host, 'ana')
    const commentId = (await (await routes.snap.GET(get(), id('p1'))).json()).comments[0].id
    await routes.snap.PATCH(patch({ kind: 'comment-heart', commentId, value: true }), id('p1'))
    const snapsHanded = [
      vi.mocked(host.announce.shared).mock.calls, tagged.mock.calls, vi.mocked(host.announce.witnessed).mock.calls,
      vi.mocked(host.announce.message).mock.calls, vi.mocked(host.announce.heart).mock.calls, spoken.mock.calls,
    ].map((calls) => calls.map((c) => c[1] as Snap<M>))
    expect(snapsHanded.map((x) => x.length)).toEqual([1, 2, 1, 1, 1, 1])
    for (const snap of snapsHanded.flat()) {
      expect(snap.justUs).toBe(true)
      expect((['ana', 'ben', 'cy'] as M[]).map((m) => mayHear(snap, m, circle))).toEqual([true, true, false])
    }
  })
})

describe('"just us" after the option is turned off', () => {
  // The records stay as they were written; only the app's options changed.
  it('stays private to its author: no list, shelf, cover, count, new mark, single snap, reaction or announcement reaches anyone else', async () => {
    const { host, f, b } = fakeHost()
    f.seed('snaps', {
      p1: { by: 'ana', caption: '', kind: 'photo', takenAt: 'x', width: 1, height: 1, paths: PHOTO.paths, witnessedAt: '2026-09-30T10:00:00.000Z', hiddenAt: null, createdAt: '2026-09-30T09:00:00.000Z', justUs: true },
    })
    b.put('p/snaps-audio/p1/r-leak0001.m4a', Buffer.from('abcd'), 'audio/mp4')
    const store = createCowitnessStore(host)
    const routes = createCowitnessHandlers(host, store)
    await nothingReaches({ host, store, routes })
    for (const m of ['ben'] as M[]) {
      expect(await store.listSnaps(m)).toEqual([])
      expect(await store.cowitnessSummary(m, '2000-01-01T00:00:00.000Z')).toEqual({ count: 0, coverUrl: null, hasNew: false, waiting: 0 })
    }
    expect((await store.listSnaps('ana')).map((x) => x.id)).toEqual(['p1'])
    // The author's own comment is announced with the flag, and with no circle mayHear names only the author.
    as(host, 'ana')
    expect((await routes.snap.PATCH(patch({ kind: 'comment', text: 'still ours' }), id('p1'))).status).toBe(200)
    const snap = vi.mocked(host.announce.message).mock.calls[0][1]
    expect(snap.justUs).toBe(true)
    expect((['ana', 'ben', 'cy'] as M[]).map((m) => mayHear(snap, m))).toEqual([true, false, false])
  })
})

describe('the author of a "just us" snap', () => {
  it('can file one only when they share: someone who does not is refused, not handed a snap they cannot see', async () => {
    const { host, routes, f } = setup({ justUs: true })
    as(host, 'cy')
    const res = await routes.photo.POST(post({ photoId: 'p1', justUs: true }))
    expect(res.status).toBe(400)
    expect(f.raw('snaps', 'p1')).toBeUndefined()
    expect(host.media.filePhoto).not.toHaveBeenCalled()
    expect((await routes.photo.POST(post({ photoId: 'p2' }))).status).toBe(200)
  })
  it('always sees it and can turn the flag off, even after the circle stops counting them as sharing', async () => {
    const { host, routes, store, f } = setup({ justUs: true })
    f.seed('snaps', {
      p1: { by: 'cy', caption: '', kind: 'photo', takenAt: 'x', width: 1, height: 1, paths: PHOTO.paths, witnessedAt: null, hiddenAt: null, createdAt: '2026-09-30T09:00:00.000Z', justUs: true },
    })
    expect((await store.getSnapView('cy', 'p1'))?.id).toBe('p1')
    expect((await store.listSnaps('cy')).map((x) => x.id)).toEqual(['p1'])
    as(host, 'cy')
    expect((await routes.snap.PATCH(patch({ kind: 'just-us', value: false }), id('p1'))).status).toBe(200)
    expect(f.raw('snaps', 'p1')).not.toHaveProperty('justUs')
  })
})

describe('who am I and what can I tag', () => {
  it('in the each-other kind everyone shares and witnesses, and with tags off there is nothing to choose from', async () => {
    const { host } = fakeHost()
    const store = createCowitnessStore(host)
    expect(await store.whoAmI('cy')).toEqual({ share: true, witness: true })
    expect(await store.tagChoices()).toEqual([])
  })
})

describe('with the options off', () => {
  it('refuses a tag or "just us" patch with the words it always used, and a filing that carries them', async () => {
    const { host } = fakeHost()
    const routes = createCowitnessHandlers(host)
    vi.mocked(host.member).mockResolvedValue('ana')
    await routes.photo.POST(post({ photoId: 'p1' }))
    const t = await routes.snap.PATCH(patch({ kind: 'tag', ids: [] }), id('p1'))
    expect([t.status, await t.json()]).toEqual([400, { error: 'unknown patch kind' }])
    expect((await routes.photo.POST(post({ photoId: 'p2', justUs: true }))).status).toBe(400)
  })
  it('never asks the app who its people are', async () => {
    const { host } = fakeHost()
    const people = vi.fn()
    const store = createCowitnessStore({ ...host, people })
    await store.listCowitness('ana')
    expect(people).not.toHaveBeenCalled()
  })
  // The frozen golden sees only the snaps list and only the four callbacks its host has. This host
  // HAS the new parts, and every route is walked: nothing outside the snaps list is touched, and no
  // option's callback, list or people is ever asked for. A spoken reaction is the one moment
  // `spoken` names, so it is walked last and on its own.
  it('touches no list but snaps and calls none of the new parts, on every route, against a host that has them', async () => {
    const { host, f, b } = fakeHost()
    const touched = new Set<string>()
    const db = f.db as unknown as { collection(n: string): unknown }
    const watched = new Proxy(db, { get: (t, k) => (k === 'collection' ? (n: string) => { touched.add(n); return t.collection(n) } : Reflect.get(t, k)) })
    const tagged = vi.fn()
    const spoken = vi.fn()
    const people = vi.fn(async () => SHARERS_AND_A_WITNESS)
    const list = vi.fn(async () => [{ id: 't-first', label: 'First' }])
    const h: CowitnessHost<M> = {
      ...host, db: () => watched as unknown as ReturnType<CowitnessHost<M>['db']>, people, tags: { list },
      announce: { ...host.announce, tagged, spoken },
    }
    const store = createCowitnessStore(h)
    const routes = createCowitnessHandlers(h, store)
    const ok = async (r: Promise<Response>) => expect((await r).status).toBeLessThan(400)
    as(h, 'ana')
    await ok(routes.photo.POST(post({ photoId: 'p1', caption: 'hi' })))
    await ok(routes.video.POST(video('v1')))
    await ok(routes.snaps.GET(get()))
    await ok(routes.snap.GET(get(), id('p1')))
    await ok(routes.snap.PATCH(patch({ kind: 'hide' }), id('v1')))
    await ok(routes.snap.PATCH(patch({ kind: 'unhide' }), id('v1')))
    as(h, 'ben')
    await ok(routes.snap.PATCH(patch({ kind: 'witness', text: 'seen' }), id('p1')))
    await ok(routes.snap.PATCH(patch({ kind: 'comment', text: 'more' }), id('p1')))
    as(h, 'ana')
    const commentId = (f.raw('snaps', 'p1')?.comments as { id: string }[]).at(-1)!.id
    await ok(routes.snap.PATCH(patch({ kind: 'comment-heart', commentId, value: true }), id('p1')))
    await ok(routes.reactionUploadUrl.POST(post({ commentId: 'r-off00001', contentType: 'audio/mp4', size: 4, durationSec: 2 }), id('p1')))
    await store.listCowitness('ana')
    await store.listWitnessed('ana')
    await store.listQueue('ben')
    await store.cowitnessSummary('ben', '2000-01-01T00:00:00.000Z')
    expect(tagged).not.toHaveBeenCalled()
    expect(spoken).not.toHaveBeenCalled()
    b.put('p/snaps-audio/p1/r-off00001.m4a', Buffer.from('abcd'), 'audio/mp4')
    await ok(routes.reactions.POST(post({ commentId: 'r-off00001', contentType: 'audio/mp4', durationSec: 2 }), id('p1')))
    await Promise.all(scheduled)
    await ok(routes.reactionAudio.GET(get(), rid('p1', 'r-off00001')))
    // The host handing over `spoken` is its own opt-in: it hears the one spoken reaction, and nothing else.
    expect(spoken).toHaveBeenCalledTimes(1)
    expect(tagged).not.toHaveBeenCalled()
    expect(people).not.toHaveBeenCalled()
    expect(list).not.toHaveBeenCalled()
    expect([...touched]).toEqual(['snaps'])
    for (const s of Object.values(f.all('snaps'))) {
      for (const k of ['justUs', 'tags', 'witnessedBy', 'voice']) expect(s).not.toHaveProperty(k)
    }
  })
})

describe('one request asks who the people are once', () => {
  it('a store made with askPeopleOnce reads people() once however many calls the page makes, and the next request asks again', async () => {
    const { host, people } = setup()
    const page = async () => {
      const store = createCowitnessStore(askPeopleOnce(host))
      await store.whoAmI('cy')
      await store.listCowitness('cy')
      await store.cowitnessSummary('cy', '2000-01-01T00:00:00.000Z')
    }
    await page()
    expect(people).toHaveBeenCalledTimes(1)
    await page()
    expect(people).toHaveBeenCalledTimes(2)
  })
  it('a host with no people is handed back as it is', () => {
    const { host } = fakeHost()
    expect(askPeopleOnce(host)).toBe(host)
  })
})

describe('the streak in the audience kind', () => {
  it('sends a person who only witnesses no streak rows, and a person who shares their rows as before', async () => {
    const { routes, host, store } = setup({ witnessing: 'audience' })
    as(host, 'ana')
    await routes.photo.POST(post({ photoId: 'p1' }))
    expect((await store.listCowitness('cy')).streak).toEqual([])
    expect((await store.listCowitness('ben')).streak.map((r) => r.id)).toEqual(['p1'])
  })
})


describe('a batch mark on photos sent together', () => {
  const batch = (index: number, over: Record<string, unknown> = {}) => ({ id: 'batch-0001', index, size: 3, ...over })
  const on = { witnessing: 'audience', justUs: true, tags: true, multiPhoto: true } as CowitnessHost<M>['features']

  it('is stored on each snap, with the id, the place in the send and the size', async () => {
    const { host, routes, f } = setup(on)
    as(host, 'ana')
    for (let i = 0; i < 3; i++) expect((await routes.photo.POST(post({ photoId: `p${i}`, batch: batch(i) }))).status).toBe(200)
    expect(f.raw('snaps', 'p0')).toMatchObject({ batch: { id: 'batch-0001', index: 0, size: 3 } })
    expect(f.raw('snaps', 'p2')).toMatchObject({ batch: { id: 'batch-0001', index: 2, size: 3 } })
  })
  it('is written only when present, so a snap filed without one is what it always was', async () => {
    const { host, routes, f } = setup(on)
    as(host, 'ana')
    await routes.photo.POST(post({ photoId: 'p1' }))
    expect(f.raw('snaps', 'p1')).not.toHaveProperty('batch')
  })
  it('is refused when several photos at once is not on, before the pipeline is touched', async () => {
    const { host, routes } = setup()
    as(host, 'ana')
    const res = await routes.photo.POST(post({ photoId: 'p1', batch: batch(0) }))
    expect(res.status).toBe(400)
    expect(host.media.filePhoto).not.toHaveBeenCalled()
  })
  it.each([
    ['an id that is too short', batch(0, { id: 'abc' })],
    ['an id with characters that do not belong', batch(0, { id: 'batch 0001/../x' })],
    ['a size of one, which is not a batch', batch(0, { size: 1 })],
    ['a size over the ten a send may hold', batch(0, { size: 11 })],
    ['a place past the end of the send', batch(3)],
    ['a negative place', batch(-1)],
    ['a place that is not a whole number', batch(0.5)],
    ['something that is not an object', 'batch-0001'],
  ])('is refused with %s', async (_why, bad) => {
    const { host, routes } = setup(on)
    as(host, 'ana')
    expect((await routes.photo.POST(post({ photoId: 'p1', batch: bad }))).status).toBe(400)
    expect(host.media.filePhoto).not.toHaveBeenCalled()
  })
  it('is carried by a "just us" send the same way: the whole batch is just us together', async () => {
    const { host, routes, f } = setup(on)
    as(host, 'ana')
    await routes.photo.POST(post({ photoId: 'p0', justUs: true, batch: batch(0) }))
    expect(f.raw('snaps', 'p0')).toMatchObject({ justUs: true, batch: { id: 'batch-0001' } })
  })
})
