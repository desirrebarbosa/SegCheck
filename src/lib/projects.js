import { supabase } from './supabaseClient'
import { distributeEvenly } from './redoDistribution'

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

export async function listMembers(projectId) {
  const { data, error } = await supabase
    .from('project_members')
    .select('is_lead, added_at, reviewer:reviewers(id, email, display_name)')
    .eq('project_id', projectId)
  if (error) throw error

  // Per-member count of fail masks currently assigned to them.
  const { data: assigned, error: aErr } = await supabase
    .from('masks')
    .select('assigned_to')
    .eq('project_id', projectId)
    .eq('status', 'fail')
    .not('assigned_to', 'is', null)
  if (aErr) throw aErr
  const countsByReviewer = new Map()
  for (const row of assigned) {
    countsByReviewer.set(row.assigned_to, (countsByReviewer.get(row.assigned_to) ?? 0) + 1)
  }

  return data.map((m) => ({
    ...m,
    redo_count: countsByReviewer.get(m.reviewer.id) ?? 0,
  }))
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
  const unassigned = []
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from('masks')
      .select('id')
      .eq('project_id', projectId)
      .eq('status', status)
      .is('assigned_to', null)
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
  // Seeded in member order first: Map iteration order is insertion order,
  // and these counts resolve in whatever order the network returns them.
  // distributeEvenly breaks ties by iteration order, so seeding keeps the
  // split deterministic instead of varying run to run.
  const load = new Map(members.map((m) => [m.reviewer_id, 0]))
  await Promise.all(
    members.map(async (m) => {
      const { count, error } = await supabase
        .from('masks')
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
  const { data, error } = await supabase
    .from('active_masks')
    .select(
      `id, category, bbox, storage_path,
       photo_id, photo_filename, photo_storage_path, created_at`,
    )
    .eq('project_id', projectId)
    .eq('status', 'fail')
    .eq('assigned_to', reviewerId)
    .order('created_at', { ascending: true })
  if (error) throw error
  return data
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

  const { data, error } = await supabase
    .from('review_logs')
    .select('created_at')
    .eq('project_id', projectId)
    .gte('created_at', since.toISOString())
  if (error) throw error

  const counts = Array(7).fill(0)
  for (const row of data) {
    const dayIndex = Math.floor((new Date(row.created_at) - since) / 86400000)
    if (dayIndex >= 0 && dayIndex < 7) counts[dayIndex] += 1
  }
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
  const { data, error } = await supabase
    .from('masks')
    .select('category')
    .eq('project_id', projectId)
    .not('category', 'is', null)
  if (error) throw error
  return [...new Set(data.map((r) => r.category))].sort()
}