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
    .select('is_lead, added_at, reviewer:reviewers(id, email, display_name)')
    .eq('project_id', projectId)
  if (error) throw error
  return data
}

// Add an existing SegCheck account to the project by email.
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