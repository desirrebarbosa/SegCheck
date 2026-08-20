import { describe, it, expect } from 'vitest'
import { relativeTime } from './relativeTime'

// Fixed "now" so these never depend on when the suite runs.
const NOW = new Date('2026-08-19T12:00:00Z').getTime()
const ago = (ms) => new Date(NOW - ms).toISOString()

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

describe('relativeTime', () => {
  it('reports anything under a minute as "just now"', () => {
    expect(relativeTime(ago(0), NOW)).toBe('just now')
    expect(relativeTime(ago(59_000), NOW)).toBe('just now')
  })

  it('rounds down to whole minutes, hours and days', () => {
    expect(relativeTime(ago(MINUTE), NOW)).toBe('1m ago')
    expect(relativeTime(ago(59 * MINUTE), NOW)).toBe('59m ago')
    expect(relativeTime(ago(HOUR), NOW)).toBe('1h ago')
    expect(relativeTime(ago(23 * HOUR), NOW)).toBe('23h ago')
    expect(relativeTime(ago(DAY), NOW)).toBe('1d ago')
    expect(relativeTime(ago(29 * DAY), NOW)).toBe('29d ago')
  })

  it('falls back to a date past a month, rather than a huge day count', () => {
    expect(relativeTime(ago(400 * DAY), NOW)).not.toMatch(/ago$/)
  })

  // Clock skew between the browser and the database can date a just-written
  // row slightly in the future; that must not render as a negative age.
  it('treats a future timestamp as "just now"', () => {
    expect(relativeTime(new Date(NOW + 30_000).toISOString(), NOW)).toBe('just now')
  })

  it('returns an empty string for missing or unparseable input', () => {
    expect(relativeTime(null, NOW)).toBe('')
    expect(relativeTime(undefined, NOW)).toBe('')
    expect(relativeTime('not a date', NOW)).toBe('')
  })
})
