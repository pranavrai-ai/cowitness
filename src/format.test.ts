import { describe, expect, it } from 'vitest'
import { snapRow } from './format.js'
import { groupByDayOf } from './client/group-by-day.js'
import type { SnapView } from './types.js'

const view = (o: Partial<SnapView> = {}): SnapView => ({
  id: 's1', by: 'ben', caption: 'lunch', kind: 'photo', takenAt: '2026-09-27T14:03:00', width: 3, height: 4,
  paths: { original: 'o', display: 'd', thumb: 't' }, witnessedAt: null, hiddenAt: null,
  createdAt: '2026-09-27T19:00:00.000Z', thumbUrl: 'https://img/t', displayUrl: 'https://img/d', ...o,
})

describe('a snap as a row', () => {
  it('carries the batch a photo was sent in, only when it has one', () => {
    expect(snapRow(view({ batch: { id: 'batch-0001', index: 1, size: 3 } }))).toMatchObject({ batch: { id: 'batch-0001', index: 1, size: 3 } })
    expect(snapRow(view())).not.toHaveProperty('batch')
  })
  it('carries what the archive draws and nothing it does not', () => {
    expect(snapRow(view(), 'https://img/t')).toEqual({
      id: 's1', by: 'ben', caption: 'lunch', kind: 'photo', thumbUrl: 'https://img/t', durationSec: null,
      createdAt: '2026-09-27T19:00:00.000Z', witnessedAt: null, hidden: false,
    })
  })
  it('signs nothing on its own: a row with no thumbnail passed in has none', () => {
    expect(snapRow(view()).thumbUrl).toBeNull()
  })
  it('a video carries its length; a hidden one says so', () => {
    const v = view({ kind: 'video', hiddenAt: 'x', video: { path: 'p', posterPath: null, durationSec: 8.2, contentType: 'video/mp4' }, thumbUrl: null })
    expect(snapRow(v)).toMatchObject({ kind: 'video', durationSec: 8.2, hidden: true, thumbUrl: null })
  })
  it('rows group by the reader\'s day, in the order given', () => {
    const now = new Date(2026, 8, 27, 22, 0)
    const rows = [{ at: new Date(2026, 8, 27, 9).toISOString() }, { at: new Date(2026, 8, 26, 9).toISOString() }]
    expect(groupByDayOf(rows, (r) => r.at, now).map((g) => g.day)).toEqual(['Today', 'Yesterday'])
  })
})
