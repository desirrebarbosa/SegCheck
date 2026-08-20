// "3m ago" / "2h ago" / "5d ago" — short enough to sit inline in a member
// row without wrapping. Deliberately coarse: the point is "is this person
// active", not a precise timestamp, so anything past a month reads as a
// date instead of an ever-growing number of days.
const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

export function relativeTime(iso, now = Date.now()) {
  if (!iso) return ''
  const then = new Date(iso).getTime()
  if (Number.isNaN(then)) return ''

  const diff = now - then
  // Clock skew between the browser and the database can put a just-written
  // row a few seconds in the future; "just now" beats "-1m ago".
  if (diff < MINUTE) return 'just now'
  if (diff < HOUR) return `${Math.floor(diff / MINUTE)}m ago`
  if (diff < DAY) return `${Math.floor(diff / HOUR)}h ago`
  if (diff < 30 * DAY) return `${Math.floor(diff / DAY)}d ago`
  return new Date(then).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}
