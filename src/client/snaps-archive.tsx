'use client'
import { clientConfig } from './config.js'

import Link from 'next/link'
import { useState } from 'react'
import type { Member, MemberNames } from '../types.js'
import type { SnapRow } from '../format.js'
import { groupByDayOf } from './group-by-day.js'
import { NoPoster, VideoMark } from './video-mark.js'
import { HAIRLINE, INK, MUTED, ON_INK, SERIF } from './theme.js'
import { SectionLabel } from './section-label.js'

// Everything either of you shared, forever, newest first, grouped by the day it was shared.
// Grouping happens here because the server does not know the phone's time zone.
// No tile prefetches its page: each one is a dynamic render, and a grid of them was twenty-odd
// server round trips per visit, fighting the thumbnails for a phone's connection.
// With options on, a voice snap's tile is its first words, a "just us" snap is marked, and a tagged
// snap names its tags; a row without those fields draws exactly what it always drew.
// Photos sent together are one tile: the first of them (lowest place), standing where the newest of
// them stands, with how many more there are in this day. Counted from the rows given, so a hidden or
// missing photo is not counted; a batch on two days is one tile on each.
function collapse(rows: SnapRow[]): { row: SnapRow; more: number }[] {
  const out: { row: SnapRow; more: number }[] = []
  const at = new Map<string, number>()
  for (const r of rows) {
    if (!r.batch) { out.push({ row: r, more: 0 }); continue }
    const i = at.get(r.batch.id)
    if (i === undefined) { at.set(r.batch.id, out.length); out.push({ row: r, more: 0 }); continue }
    const cur = out[i]
    out[i] = { row: r.batch.index < (cur.row.batch?.index ?? 0) ? r : cur.row, more: cur.more + 1 }
  }
  return out
}

export function SnapsArchive({ rows, me, names, empty = 'Nothing shared yet. Add a snap from your day.', tagLabels }: { rows: SnapRow[]; me: Member; names: MemberNames; empty?: string; tagLabels?: Record<string, string> }) {
  const [now] = useState(() => new Date())
  if (rows.length === 0) {
    return <p className="px-6 py-12 text-center text-[17px]" style={{ color: MUTED, fontFamily: SERIF }}>{empty}</p>
  }
  return (
    <div className="px-4">
      {groupByDayOf(rows, (r) => r.createdAt, now).map((g) => (
        <section key={g.day} aria-label={g.day} className="mb-6">
          <SectionLabel className="mb-2 px-1">{g.day}</SectionLabel>
          <ol className="grid grid-cols-3 gap-1.5">
            {collapse(g.rows).map(({ row: r, more }) => (
              <li key={r.id}>
                <Link href={`${clientConfig().pageBase}/${r.id}`} prefetch={false} className="relative block aspect-square overflow-hidden rounded-xl" style={{ backgroundColor: HAIRLINE }}>
                  {r.kind === 'voice'
                    ? <span className="flex h-full w-full items-center p-2 text-left text-[12px] leading-snug" style={{ color: INK, fontFamily: SERIF }}>{r.words || 'Voice note'}</span>
                    : r.thumbUrl
                    // eslint-disable-next-line @next/next/no-img-element -- signed, expiring storage URL
                    ? <img src={r.thumbUrl} alt={r.caption || `Snap from ${names[r.by]}`} className={`h-full w-full object-cover ${r.hidden ? 'opacity-40' : ''}`} />
                    : <NoPoster />}
                  {r.kind === 'video' && <VideoMark durationSec={r.durationSec ?? undefined} small />}
                  {more > 0 && <span aria-label={`${more} more photo${more === 1 ? '' : 's'}`} className="absolute bottom-1 right-1 rounded-full px-1.5 text-[11px] font-medium" style={{ backgroundColor: INK, color: ON_INK }}>+{more}</span>}
                  {r.hidden && <span className="absolute inset-x-0 bottom-1 text-center text-[11px] font-medium" style={{ color: INK }}>Hidden</span>}
                  {r.justUs && <span aria-label="Just us" className="absolute right-1 top-1 text-[11px]" style={{ color: INK }}>🔒</span>}
                </Link>
                <p className="mt-1 truncate px-0.5 text-[11px]" style={{ color: MUTED }}>
                  {r.by === me ? (r.witnessedAt ? 'Witnessed' : 'You') : names[r.by]}
                </p>
                {r.tags?.length && tagLabels ? <p className="truncate px-0.5 text-[11px]" style={{ color: MUTED }}>{r.tags.map((t) => tagLabels[t] ?? t).join(', ')}</p> : null}
              </li>
            ))}
          </ol>
        </section>
      ))}
    </div>
  )
}
