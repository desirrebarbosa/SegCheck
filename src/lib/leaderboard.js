import { supabase } from './supabaseClient'

// Project timezone is fixed rather than derived per-viewer, so every viewer
// sees the same week boundaries and the same numbers for "this week" — a
// shared leaderboard where everyone's clock disagrees on when the week
// started would undermine the whole point of it. The Philippines has no
// DST, so a fixed offset is exact; if the team ever spans a DST timezone,
// replace this with Intl.DateTimeFormat({ timeZone: ... }) instead.
const PROJECT_TZ_OFFSET_HOURS = 8 // Philippine Time (UTC+8)
const DAY_MS = 86400000

// Only these review_logs actions represent a reviewer's own effort.
// Deliberately excludes upload_photo, upload_version, auto_fail_missing
// (bulk/system-driven, attributed to whoever clicked Upload rather than
// whoever did the work) and redo_upload (a batch re-upload of externally
// edited masks, same attribution problem). submit_correction is MyRedo's
// per-reviewer redo flow and is the trustworthy signal for individual
// redo credit.
const REDO_ACTIONS = ['submit_correction']

// Monday 00:00 through the following Monday 00:00, in the project's fixed
// timezone, expressed as UTC ISO bounds for a half-open [from, to) query.
// Pure function — no clock/DB access beyond the `now` you pass in — so
// it's fully unit-testable without mocking anything.
//
// weeksAgo: 0 = the week containing `now`, 1 = the week before that, etc.
export function weekBounds(now = new Date(), weeksAgo = 0) {
  const offsetMs = PROJECT_TZ_OFFSET_HOURS * 3600000
  // Shift into the project's wall-clock time, but keep it in UTC fields so
  // getUTCDay()/getUTCFullYear() etc. read as "local" without any of the
  // environment's own timezone leaking in.
  const shifted = new Date(now.getTime() + offsetMs)
  const localMidnight = Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate())

  // getUTCDay(): 0 = Sunday .. 6 = Saturday. Distance back to Monday.
  const dayOfWeek = new Date(localMidnight).getUTCDay()
  const daysSinceMonday = (dayOfWeek + 6) % 7

  const thisMonday = localMidnight - daysSinceMonday * DAY_MS
  const from = thisMonday - weeksAgo * 7 * DAY_MS
  const to = from + 7 * DAY_MS

  return {
    fromISO: new Date(from - offsetMs).toISOString(),
    toISO: new Date(to - offsetMs).toISOString(),
    label: formatWeekLabel(new Date(from), new Date(to - DAY_MS)),
  }
}

function formatWeekLabel(start, end) {
  // Both dates are already at the project's local midnight, just carried in
  // UTC fields — format with timeZone: 'UTC' so nothing shifts again.
  const day = (d) => d.toLocaleDateString('en-US', { day: 'numeric', timeZone: 'UTC' })
  const dayWithMonth = (d) => d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })
  const sameMonth = start.getUTCMonth() === end.getUTCMonth() && start.getUTCFullYear() === end.getUTCFullYear()
  return sameMonth ? `${dayWithMonth(start)}–${day(end)}` : `${dayWithMonth(start)}–${dayWithMonth(end)}`
}

// One reviewer's count of a set of actions within a date range. Count-only
// (head: true, no rows returned) — same shape as fetchMemberProgress in
// projects.js, and for the same reason: exact at any backlog size, and
// nothing crosses the wire but the number.
async function countActions(projectId, reviewerId, actions, fromISO, toISO) {
  const { count, error } = await supabase
    .from('review_logs')
    .select('id', { count: 'exact', head: true })
    .eq('project_id', projectId)
    .eq('reviewer_id', reviewerId)
    .in('action', actions)
    .gte('created_at', fromISO)
    .lt('created_at', toISO)
  if (error) throw error
  return count ?? 0
}

// Ranks every project member by review + redo activity within one week.
// Sourced from review_logs, never from masks.reviewed_at/reviewed_by:
// skipping a mask bumps reviewed_at without logging anything (see
// ReviewQueue.jsx), so counting off the masks table would count skips as
// reviews. review_logs only gains a row when a decision or a correction
// actually happens.
//
// weeksAgo: 0 = current week, 1 = last week, etc. — same convention as
// weekBounds above.
export async function fetchWeeklyLeaderboard(projectId, { weeksAgo = 0 } = {}) {
  const { fromISO, toISO, label } = weekBounds(new Date(), weeksAgo)

  const { data: members, error: memberErr } = await supabase
    .from('project_members')
    .select('reviewer:reviewers(id, email, display_name)')
    .eq('project_id', projectId)
  if (memberErr) throw memberErr

  const rows = await Promise.all(
    members.map(async ({ reviewer }) => {
      const [pass, fail, redo] = await Promise.all([
        countActions(projectId, reviewer.id, ['confirm_pass'], fromISO, toISO),
        countActions(projectId, reviewer.id, ['confirm_fail'], fromISO, toISO),
        countActions(projectId, reviewer.id, REDO_ACTIONS, fromISO, toISO),
      ])
      const reviewed = pass + fail
      return {
        reviewerId: reviewer.id,
        email: reviewer.email,
        displayName: reviewer.display_name,
        pass,
        fail,
        reviewed,
        redo,
        total: reviewed + redo,
      }
    }),
  )

  // Highest total first; ties broken by redo count (the higher-effort
  // signal), then by email so the order is stable rather than arbitrary.
  rows.sort((a, b) => b.total - a.total || b.redo - a.redo || a.email.localeCompare(b.email))

  return { label, fromISO, toISO, rows }
}
