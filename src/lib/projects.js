import { supabase } from './supabaseClient'

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
    .select('is_lead, added_at, assigned_categories, reviewer:reviewers(id, email, display_name)')
    .eq('project_id', projectId)
  if (error) throw error

  // Per-member count of fail masks currently assigned to them, for display
  // next to their category chips. One query, tallied client-side rather
  // than N queries (one per member).
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
    assigned_categories: m.assigned_categories ?? [],
    redo_count: countsByReviewer.get(m.reviewer.id) ?? 0,
  }))
}

// Add an existing SegCheck account to the project by email.
export async function addMemberByEmail(projectId, email, categories = []) {
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

  const { error: e2 } = await supabase.from('project_members').insert({
    project_id: projectId,
    reviewer_id: rev.id,
    is_lead: false,
    assigned_categories: categories,
  })
  if (e2) {
    if (e2.code === '23505') throw new Error(`${clean} is already a member.`)
    throw e2
  }

  if (categories.length > 0) {
    return distributeRedoMasks(projectId, rev.id, categories)
  }
  return 0
}

// Assigns unassigned (assigned_to is null) fail masks in the given
// categories to reviewerId. Never reassigns another member's already-
// assigned work — only claims masks nobody's on the hook for yet. Returns
// the count assigned, for the "N redo items assigned" toast.
export async function distributeRedoMasks(projectId, reviewerId, categories) {
  if (!categories || categories.length === 0) return 0

  const { data, error } = await supabase
    .from('masks')
    .update({ assigned_to: reviewerId })
    .eq('project_id', projectId)
    .eq('status', 'fail')
    .in('category', categories)
    .is('assigned_to', null)
    .select('id')
  if (error) throw error
  return data.length
}

// Remove a member from a project. Gated to owner-only in the UI (RLS also
// only allows a project lead to delete rows via projects_delete-style
// policies — owner is additionally enforced client-side per your call that
// membership changes should be owner-only, not just lead-only).
export async function removeMember(projectId, reviewerId) {
  const { error } = await supabase
    .from('project_members')
    .delete()
    .eq('project_id', projectId)
    .eq('reviewer_id', reviewerId)
  if (error) throw error
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

// Distinct categories seen in a project's masks — used to populate the
// category picker on Members (add-member form) without a separate
// categories table. Cheap: selects one column, dedupes client-side.
export async function fetchProjectCategories(projectId) {
  const { data, error } = await supabase
    .from('masks')
    .select('category')
    .eq('project_id', projectId)
    .not('category', 'is', null)
  if (error) throw error
  return [...new Set(data.map((r) => r.category))].sort()
}