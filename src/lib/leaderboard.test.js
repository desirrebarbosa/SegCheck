import { describe, it, expect } from 'vitest'
import { weekBounds } from './leaderboard'

// Covers the fixed-week boundary math: the leaderboard's whole point is
// that everyone sees the same week regardless of their own browser's
// timezone, so this needs to be exactly right at the edges rather than
// approximately right in the middle.
//
// PROJECT_TZ_OFFSET_HOURS is UTC+8 (Philippine Time, no DST) — every
// expected boundary below is that wall-clock Monday 00:00 converted to UTC.

describe('weekBounds', () => {
  it('puts a Wednesday squarely inside its own Mon–Sun week', () => {
    // Wed 2026-03-04 12:00 PHT = 2026-03-04T04:00:00Z
    const { fromISO, toISO } = weekBounds(new Date('2026-03-04T04:00:00Z'))
    expect(fromISO).toBe('2026-03-01T16:00:00.000Z') // Mon 2026-03-02 00:00 PHT
    expect(toISO).toBe('2026-03-08T16:00:00.000Z') // Mon 2026-03-09 00:00 PHT
  })

  it('counts the first instant of Monday as the start of the new week', () => {
    // Mon 2026-03-02 00:00:00 PHT exactly.
    const { fromISO } = weekBounds(new Date('2026-03-01T16:00:00.000Z'))
    expect(fromISO).toBe('2026-03-01T16:00:00.000Z')
  })

  it('counts one millisecond before Monday as still the previous week', () => {
    const { toISO } = weekBounds(new Date('2026-03-01T15:59:59.999Z'))
    expect(toISO).toBe('2026-03-01T16:00:00.000Z') // that week's own Monday boundary
  })

  it('treats the last instant of Sunday as inside the same week as Monday', () => {
    // Sun 2026-03-08 23:59:59.999 PHT — one ms before the next Monday.
    const { fromISO, toISO } = weekBounds(new Date('2026-03-08T15:59:59.999Z'))
    expect(fromISO).toBe('2026-03-01T16:00:00.000Z')
    expect(toISO).toBe('2026-03-08T16:00:00.000Z')
  })

  it('steps back a full 7 days per weeksAgo', () => {
    const current = weekBounds(new Date('2026-03-04T04:00:00Z'), 0)
    const lastWeek = weekBounds(new Date('2026-03-04T04:00:00Z'), 1)
    expect(new Date(current.fromISO) - new Date(lastWeek.fromISO)).toBe(7 * 86400000)
    expect(lastWeek.toISO).toBe(current.fromISO) // weeks tile with no gap or overlap
  })

  it('labels a week that stays within one month as "Mon D–D"', () => {
    const { label } = weekBounds(new Date('2026-03-04T04:00:00Z'))
    expect(label).toBe('Mar 2–8')
  })

  it('labels a week that crosses a month boundary with both months', () => {
    // Sat 2026-02-28 PHT falls in the week of Mon 2026-02-23 -> Sun 2026-03-01.
    const { label } = weekBounds(new Date('2026-02-28T04:00:00Z'))
    expect(label).toBe('Feb 23–Mar 1')
  })
})
