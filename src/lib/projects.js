import { supabase } from './supabaseClient'
import { distributeEvenly } from './redoDistribution'
import { selectAll } from './paging'

// All queries below are further constrained by RLS, so they only ever return
// projects/members the signed-in reviewer is allowed to see.

// Projects the current user is a member of, with their per-project lead flag.
// IMPORTANT: must filter to the current user's OWN project_members rows.
// The members_select RLS policy is `is_project_member(project_id)`, which
// deliberately lets any member see the FULL roster of a shared project (for
// the Members page) — so an unfiltered select here would return one row per
// *other* member too, and each one gets mapped into a "project" entry,
// making the same project appear to duplicate every time someone else is
// added to it.
export async function listMyProjects() {
  const {
    data: { user },
  } = await supabase.auth.getUser()

  const { data, error } = await supabase
    .from('project_members')
    .select('is_lead, added_at, project:projects(id, name, owner_id, created_at)')
    .eq('reviewer_id', user.id)
    .order('added_at', { ascending: false })
  if (error) throw error
  return data
    .filter((r) => r.project) // ignore any row whose project is hidden by RLS
    .map((r) => ({ ...r.project, is_lead: r.is_lead }))
}

// Create a project and add the creator as its lead member (two steps).
export async function createProject(name) {
  const {
    data: { user },
  } = await supabase.auth.getUser()

  const { data: project, error } = await supabase
    .from('projects')
    .insert({ name: name.trim(), owner_id: user.id })
    .select()
    .single()
  if (error) throw error

  const { error: mErr } = await supabase
    .from('project_members')
    .insert({ project_id: project.id, reviewer_id: user.id, is_lead: true })
  if (mErr) throw mErr

  return project
}

export async function getProject(projectId) {
  const { data, error } = await supabase
    .from('projects')
    .select('*')
    .eq('id', projectId)
    .single()
  if (error) throw error
  return data
}

// Is the current user a lead of this project?
export async function getMyMembership(projectId) {
  const {
    data: { user },
  } = await supabase.auth.getUser()
  const { data, error } = await supabase
    .from('project_members')
    .select('is_lead')
    .eq('project_id', projectId)
    .eq('reviewer_id', user.id)
    .maybeSingle()
  if (error) throw error
  return data // null if not a member
}

// Roster plus each member's outstanding redo count.
//
// `redo_count` was briefly removed here when fetchMemberProgress() took over
// reporting it, but the Dashboard's per-assignee redo export depends on it to
// label the assignee picker and size the batch — so it stays, and the two
// agree because both now count the same way.
//
// Counted through `active_masks`, NOT raw `masks`: masks on superseded photo
// versions keep their status and assignment but are invisible to every
// screen, so counting them here showed a bigger redo number than My Redo
// could actually list.
export async function listMembers(projectId) {
  const { data, error } = await supabase
    .from('project_members')
    .select('is_lead, added_at, reviewer:reviewers(id, email, display_name)')
    .eq('project_id', projectId)
  if (error) throw error

  // One count-only query per member rather than tallying rows client-side:
  // exact at any backlog size, and nothing crosses the wire but the numbers.
  const counts = await Promise.all(
    data.map(async (m) => {
      const { count, error: cErr } = await supabase
        .from('active_masks')
        .select('id', { count: 'exact', head: true })
        .eq('project_id', projectId)
        .eq('status', 'fail')
        .eq('assigned_to', m.reviewer.id)
      if (cErr) throw cErr
      return count ?? 0
    }),
  )

  return data.map((m, i) => ({ ...m, redo_count: counts[i] }))
}

// Per-member numbers, for the Members page and the Dashboard leaderboard.
// Keyed by reviewer id; every listed member gets an entry.
//
// The two halves come from deliberately different places:
//
//   - Outstanding load (`pending`, `redo`) from `active_masks` — what the
//     person can actually see in their review queue and My Redo right now.
//     Raw `masks` would include superseded photo versions, i.e. work that
//     is assigned to them but renders nowhere.
//
//   - Work completed (`passed`, `failed`, `redone`) from `review_logs`, NOT
//     from masks.reviewed_by. A redo upload resets reviewed_by to null (see
//     commitRedoUploadPlan), so counting masks would quietly erase a
//     reviewer's credit for every mask they failed that was later
//     re-annotated — which is precisely the work worth showing. review_logs
//     is append-only, so it is the only honest record of who did how much.
//
// All count-only (`head: true`, no rows returned), run in parallel — the
// same shape as the load counts in rebalanceAssignments. Cost is one small
// request per member per metric, which is fine for a project roster; if a
// roster ever grows past a few dozen people this wants a SQL view instead.
export async function fetchMemberProgress(projectId, reviewerIds) {
  const countMasks = async (reviewerId, status) => {
    const { count, error } = await supabase
      .from('active_masks')
      .select('id', { count: 'exact', head: true })
      .eq('project_id', projectId)
      .eq('status', status)
      .eq('assigned_to', reviewerId)
    if (error) throw error
    return count ?? 0
  }

  const countLogs = async (reviewerId, action) => {
    // Counted on created_at rather than id: PostgREST validates the column
    // list even for a head-only count, and created_at is the one column
    // review_logs is already read by elsewhere (fetchWeeklyActivity).
    const { count, error } = await supabase
      .from('review_logs')
      .select('created_at', { count: 'exact', head: true })
      .eq('project_id', projectId)
      .eq('reviewer_id', reviewerId)
      .eq('action', action)
    // `action` is a Postgres enum, so filtering on a label the enum does not
    // have is a 22P02 cast error rather than an empty result. That is not a
    // reason to blank the whole progress panel — a value the database has
    // never seen has, definitionally, a count of zero. Keeps the page
    // working when the code ships ahead of the enum migration.
    if (error?.code === '22P02') return 0
    if (error) throw error
    return count ?? 0
  }

  const lastActivity = async (reviewerId) => {
    const { data, error } = await supabase
      .from('review_logs')
      .select('created_at')
      .eq('project_id', projectId)
      .eq('reviewer_id', reviewerId)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle()
    if (error) throw error
    return data?.created_at ?? null
  }

  const entries = await Promise.all(
    reviewerIds.map(async (id) => {
      const [pending, redo, passed, failed, redone, lastActivityAt] = await Promise.all([
        countMasks(id, 'pending'),
        countMasks(id, 'fail'),
        countLogs(id, 'confirm_pass'),
        countLogs(id, 'confirm_fail'),
        countLogs(id, 'redo_upload'),
        lastActivity(id),
      ])
      // `qad` — pass + fail decisions — is the "how much reviewing did this
      // person actually do" number, and what the leaderboard ranks on.
      return [id, { pending, redo, passed, failed, qad: passed + failed, redone, lastActivityAt }]
    }),
  )

  return Object.fromEntries(entries)
}

// Roster joined to progress, ranked by masks reviewed. Ties break on passed
// then on name, so the order is stable rather than dependent on whatever
// order the roster query happened to return.
export async function fetchReviewLeaderboard(projectId) {
  const members = await listMembers(projectId)
  const progress = await fetchMemberProgress(
    projectId,
    members.map((m) => m.reviewer.id),
  )
  return members
    .map((m) => ({ reviewer: m.reviewer, is_lead: m.is_lead, ...progress[m.reviewer.id] }))
    .sort(
      (a, b) =>
        b.qad - a.qad ||
        b.passed - a.passed ||
        (a.reviewer.display_name || a.reviewer.email).localeCompare(
          b.reviewer.display_name || b.reviewer.email,
        ),
    )
}

// Add an existing SegCheck account to the project by email, then give them
// their share of whatever review + redo backlog is currently unassigned.
export async function addMemberByEmail(projectId, email) {
  const clean = email.trim().toLowerCase()
  const { data: rev, error: e1 } = await supabase
    .from('reviewers')
    .select('id')
    .eq('email', clean)
    .maybeSingle()
  if (e1) throw e1
  if (!rev)
    throw new Error(
      `No SegCheck account for ${clean}. They must sign in once before you can add them.`,
    )

  const { error: e2 } = await supabase
    .from('project_members')
    .insert({ project_id: projectId, reviewer_id: rev.id, is_lead: false })
  if (e2) {
    if (e2.code === '23505') throw new Error(`${clean} is already a member.`)
    throw e2
  }

  const { perMember } = await rebalanceAllAssignments(projectId)
  return perMember[rev.id] ?? 0
}

// How many mask ids go into one `.in('id', [...])` update. Every id is a
// 36-char UUID that ends up in the request URL, so an unbounded list on a
// few thousand masks builds a URL long enough to get rejected.
const UPDATE_CHUNK = 200

// Rows per page when reading the backlog. PostgREST returns at most 1000
// rows per request by default, so anything larger has to be paged.
const PAGE = 1000

// Splits every currently UNASSIGNED mask of one status across all current
// project members so that TOTAL load for that status ends up as even as
// possible. Never touches a mask that's already assigned to someone —
// this only distributes the unclaimed pool, whether that's the first
// distribution after a member is added or fresh masks from a new upload.
// Category is no longer a factor in who gets what (was, in an earlier
// version of this feature — replaced per direct instruction: split by
// count, not by class).
//
// The two statuses that get distributed are the two kinds of work someone
// can actually be given: 'pending' (QA review) and 'fail' (re-annotation).
// They're balanced SEPARATELY — a fair share of the review queue and a
// fair share of the redo backlog — rather than pooled, so nobody ends up
// with all the reviewing and none of the redo just because the totals
// happen to line up.
//
// Distribution is least-loaded-first rather than a positional round-robin:
// each unassigned mask goes to whoever currently holds the fewest. On an
// empty backlog the two are identical (190 unassigned / 4 members ->
// 48/48/47/47 either way), but they diverge as soon as load is uneven —
// a plain round-robin hands a member who already has 100 items the same
// share as one who has 0, so the gap never closes. Levelling here is the
// only way the totals converge, given we can't reassign existing work.
export async function rebalanceAssignments(projectId, status) {
  const { data: members, error: mErr } = await supabase
    .from('project_members')
    .select('reviewer_id')
    .eq('project_id', projectId)
  if (mErr) throw mErr
  if (members.length === 0) return { assigned: 0, perMember: {} }

  // Paged: PostgREST caps a plain select at 1000 rows, which would
  // silently leave the rest of a large backlog undistributed.
  //
  // Read through `active_masks`, NOT raw `masks`. Masks belong to a photo
  // version, and re-uploading a photo supersedes the previous version's
  // masks — they keep their status but drop out of `active_masks`, which is
  // what every reader (My Redo, the review queue, the dashboard) goes
  // through. Distributing from raw `masks` therefore handed people work on
  // superseded versions that no page can render: invisible assignments that
  // sit in someone's name forever. The write below still targets `masks` by
  // id, so nothing here depends on the view being updatable.
  const unassigned = []
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from('active_masks')
      .select('id')
      .eq('project_id', projectId)
      .eq('status', status)
      .is('assigned_to', null)
      // ORDER BY is not optional here. Postgres gives no row-order guarantee
      // without one, so paging with .range() alone can return a row twice
      // across two pages — harmless — or skip one entirely, which silently
      // leaves that mask undistributed and in nobody's list. At 3900+ fails
      // that is four pages of exposure. It self-heals (the next rebalance
      // picks the row up) which is exactly why it went unnoticed.
      .order('id', { ascending: true })
      .range(from, from + PAGE - 1)
    if (error) throw error
    unassigned.push(...data)
    if (data.length < PAGE) break
  }
  if (unassigned.length === 0) return { assigned: 0, perMember: {} }

  // Current per-member load, so the split below levels totals instead of
  // just splitting the new pool evenly. Counted server-side per member
  // (head:true, no rows returned) rather than by tallying every assigned
  // row client-side — exact regardless of backlog size, and it naturally
  // ignores rows pointing at someone who's no longer a member.
  // Counted through `active_masks` for the same reason as the pool above:
  // counting raw `masks` inflated a member's load with superseded rows, so
  // the leveller believed they were busier than they were and routed real
  // work away from them.
  // Seeded in member order first: Map iteration order is insertion order,
  // and these counts resolve in whatever order the network returns them.
  // distributeEvenly breaks ties by iteration order, so seeding keeps the
  // split deterministic instead of varying run to run.
  const load = new Map(members.map((m) => [m.reviewer_id, 0]))
  await Promise.all(
    members.map(async (m) => {
      const { count, error } = await supabase
        .from('active_masks')
        .select('id', { count: 'exact', head: true })
        .eq('project_id', projectId)
        .eq('status', status)
        .eq('assigned_to', m.reviewer_id)
      if (error) throw error
      load.set(m.reviewer_id, count ?? 0)
    }),
  )

  const byReviewer = distributeEvenly(
    unassigned.map((m) => m.id),
    load,
  )

  const perMember = {}
  for (const [reviewerId, ids] of byReviewer) {
    for (let i = 0; i < ids.length; i += UPDATE_CHUNK) {
      const { error } = await supabase
        .from('masks')
        .update({ assigned_to: reviewerId })
        .in('id', ids.slice(i, i + UPDATE_CHUNK))
      if (error) throw error
    }
    perMember[reviewerId] = ids.length
  }

  return { assigned: unassigned.length, perMember }
}

// The two distributable statuses, in the order they're handed out.
// 'pending' first so a member who joins mid-project gets reviewing work
// before redo work — reviewing is the step that unblocks everything else.
export const ASSIGNABLE_STATUSES = ['pending', 'fail']

// Distributes both kinds of work. Use this rather than calling
// rebalanceAssignments directly, so no caller has to remember there are
// two pools. Returns totals plus the per-status breakdown.
export async function rebalanceAllAssignments(projectId) {
  const byStatus = {}
  let assigned = 0
  const perMember = {}
  for (const status of ASSIGNABLE_STATUSES) {
    const result = await rebalanceAssignments(projectId, status)
    byStatus[status] = result
    assigned += result.assigned
    for (const [reviewerId, n] of Object.entries(result.perMember)) {
      perMember[reviewerId] = (perMember[reviewerId] ?? 0) + n
    }
  }
  return { assigned, perMember, byStatus }
}

// One reviewer's own numbers, for the review queue header.
//
// `pending` is what's still assigned to them — work outstanding. `pass`
// and `fail` are counted by `reviewed_by` instead, because a decision
// clears `assigned_to` (the mask leaves your stack the moment you decide
// on it, and a fail goes back into the pool to be redistributed for
// redo). So these read as "waiting on me / I passed / I failed", which is
// what someone actually wants to know about their own progress.
export async function fetchMyQueueCounts(projectId, reviewerId) {
  const countWhere = async (build) => {
    const { count, error } = await build(
      supabase.from('active_masks').select('id', { count: 'exact', head: true }),
    ).eq('project_id', projectId)
    if (error) throw error
    return count ?? 0
  }

  const [pending, pass, fail] = await Promise.all([
    countWhere((q) => q.eq('status', 'pending').eq('assigned_to', reviewerId)),
    countWhere((q) => q.eq('status', 'pass').eq('reviewed_by', reviewerId)),
    countWhere((q) => q.eq('status', 'fail').eq('reviewed_by', reviewerId)),
  ])
  return { pending, pass, fail }
}

// How much unclaimed-by-me pending work is left across the project — the
// pool the "help others" mode draws from. Used to decide whether offering
// to help is worth showing at all.
export async function fetchHelpablePendingCount(projectId, reviewerId) {
  const { count, error } = await supabase
    .from('active_masks')
    .select('id', { count: 'exact', head: true })
    .eq('project_id', projectId)
    .eq('status', 'pending')
    .or(`assigned_to.neq.${reviewerId},assigned_to.is.null`)
  if (error) throw error
  return count ?? 0
}

// Read-only: the redo (fail) masks currently assigned to one reviewer, for
// the dedicated "My Redo" list.
export async function fetchMyRedoAssignments(projectId, reviewerId) {
  // Paged: one person's share of a few thousand fails is comfortably over
  // PostgREST's 1000-row cap, so a bare select silently cut their list short
  // — the work was assigned to them and simply never shown.
  return selectAll(
    () =>
      supabase
        .from('active_masks')
        .select(
          `id, status, category, bbox, segmentation, storage_path, is_missing,
       manifest_mask_id, assigned_to,
       photo_id, photo_filename, photo_storage_path, created_at`,
        )
        .eq('project_id', projectId)
        .eq('status', 'fail')
        .eq('assigned_to', reviewerId),
    { orderBy: 'id' },
  )
}

// Remove a member from a project. Gated to owner-only in the UI (RLS also
// only allows a project lead to delete rows via projects_delete-style
// policies — owner is additionally enforced client-side per your call that
// membership changes should be owner-only, not just lead-only).
export async function removeMember(projectId, reviewerId) {
  // Release their work BEFORE dropping the membership row. Anything still
  // pointing at a removed member is stranded: it isn't null, so
  // rebalanceAssignments skips it, and no current member's queue or My
  // Redo list can surface it — the items would quietly disappear from the
  // backlog. Doing this first means a failure here aborts the removal
  // with the assignments intact, rather than the other order, which
  // could drop the membership and then strand the work.
  const { error: relErr } = await supabase
    .from('masks')
    .update({ assigned_to: null })
    .eq('project_id', projectId)
    .in('status', ASSIGNABLE_STATUSES)
    .eq('assigned_to', reviewerId)
  if (relErr) throw relErr

  const { error } = await supabase
    .from('project_members')
    .delete()
    .eq('project_id', projectId)
    .eq('reviewer_id', reviewerId)
  if (error) throw error

  // Hand the released items to whoever's left.
  return rebalanceAllAssignments(projectId)
}
// Pending/pass/fail counts for one project — cheap count-only queries, used
// to render the projects list without pulling every mask row for every
// project. (Restored — this and fetchWeeklyActivity were part of the
// dashboard redesign and were missing from the last re-uploaded source.)
export async function fetchProjectStatusCounts(projectId) {
  const statuses = ['pending', 'pass', 'fail']
  const counts = {}
  await Promise.all(
    statuses.map(async (status) => {
      const { count, error } = await supabase
        .from('active_masks')
        .select('id', { count: 'exact', head: true })
        .eq('project_id', projectId)
        .eq('status', status)
      if (error) throw error
      counts[status] = count ?? 0
    }),
  )
  return counts
}

// Daily activity counts for the last 7 days, oldest to newest. Pulls from
// review_logs, which covers every action (uploads, versioning, auto-fails,
// confirm/reject) — not just review decisions, since this reflects all
// activity on a project, not only the QA step.
export async function fetchWeeklyActivity(projectId) {
  const since = new Date()
  since.setHours(0, 0, 0, 0)
  since.setDate(since.getDate() - 6)

  // One count-only query per day rather than fetching a week of rows and
  // tallying them here. The old shape hit PostgREST's 1000-row cap on any
  // busy week and undercounted the sparkline without erroring — and on a
  // quiet week it pulled rows it only ever needed the length of.
  const DAY = 86400000
  const counts = await Promise.all(
    Array.from({ length: 7 }, async (_, i) => {
      const from = new Date(since.getTime() + i * DAY)
      const to = new Date(since.getTime() + (i + 1) * DAY)
      const { count, error } = await supabase
        .from('review_logs')
        .select('created_at', { count: 'exact', head: true })
        .eq('project_id', projectId)
        .gte('created_at', from.toISOString())
        .lt('created_at', to.toISOString())
      if (error) throw error
      return count ?? 0
    }),
  )
  return counts
}

// Distinct categories seen in a project's masks, without a separate
// categories table. Cheap: selects one column, dedupes client-side.
//
// Currently UNUSED: this backed the per-category picker on the add-member
// form, from the version of redo assignment that split work by class.
// That's been replaced by the even-by-count split, so nothing calls this
// today. Kept because Feature 6's per-category guide defaults (skeleton vs
// star-convex) need exactly this list — delete it if that lands elsewhere.
export async function fetchProjectCategories(projectId) {
  // Paged: the distinct-categories list is derived client-side from every
  // mask row, so a truncated read drops whole categories from the result.
  const rows = await selectAll(
    () =>
      supabase
        .from('masks')
        .select('id, category')
        .eq('project_id', projectId)
        .not('category', 'is', null),
    { orderBy: 'id' },
  )
  return [...new Set(rows.map((r) => r.category))].sort()
}