import { supabase } from './supabaseClient'
import { selectAll } from './paging'
import { uploadFile, getSignedUrl } from './storage'
import { deleteStoragePaths } from './admin'

// Experiment tracker data layer. Every query below is further constrained by
// RLS (experiments_select etc.), so nothing here can reach another project.
//
// Schema: segcheck-md/2026-09-05_experiments-module.sql
// Contract for the JSON import/export: segcheck-md/experiment-module.md

// Matches UPDATE_CHUNK in projects.js — PostgREST puts filter values in the
// request URL, so an unbounded .in() builds a URL long enough to be rejected.
const CHUNK = 200

const EXPERIMENT_COLUMNS =
  'id, project_id, seq, title, run_date, tasks, epochs, added_by, ' +
  'color_space, backbone, neck, heads, ' +
  'map_50, map_75, map_90, map_95, map_avg, miou, f1, ' +
  'notes, archived_at, created_at, updated_at, ' +
  'reviewer:reviewers!experiments_added_by_fkey(id, email, display_name)'

// ── Experiments ───────────────────────────────────────────────────────────

// Active experiments by default; archived rows are opt-in so the list stays
// the working set rather than the whole history.
//
// Through selectAll() rather than a bare select: PostgREST truncates at 1000
// rows silently, and a run log per epoch across a year of experiments gets
// there faster than it looks. Ordered on `seq`, which is unique per project.
export async function listExperiments(projectId, { includeArchived = false } = {}) {
  const rows = await selectAll(
    () => {
      let q = supabase.from('experiments').select(EXPERIMENT_COLUMNS).eq('project_id', projectId)
      if (!includeArchived) q = q.is('archived_at', null)
      return q
    },
    { orderBy: 'seq', ascending: false },
  )
  return rows
}

// One experiment with everything hanging off it. Three queries rather than
// one nested select: the runs can number in the thousands and would be
// re-sent for every embedded row otherwise.
export async function getExperiment(experimentId) {
  const { data: experiment, error } = await supabase
    .from('experiments')
    .select(EXPERIMENT_COLUMNS)
    .eq('id', experimentId)
    .single()
  if (error) throw error

  const [runs, attachments] = await Promise.all([
    listRuns(experimentId),
    listAttachments(experimentId),
  ])
  return { ...experiment, runs, attachments }
}

export async function createExperiment(projectId, fields, runs = []) {
  // `seq` is left out on purpose — the experiments_assign_seq trigger fills
  // it in per project, so two people adding at once cannot collide on 003.
  const { data: experiment, error } = await supabase
    .from('experiments')
    .insert({ ...fields, project_id: projectId })
    .select(EXPERIMENT_COLUMNS)
    .single()
  if (error) throw error

  if (runs.length) await replaceRuns(experiment.id, projectId, runs)
  return experiment
}

export async function updateExperiment(experimentId, fields) {
  const { data, error } = await supabase
    .from('experiments')
    .update(fields)
    .eq('id', experimentId)
    .select(EXPERIMENT_COLUMNS)
    .single()
  if (error) throw error
  return data
}

export async function archiveExperiment(experimentId, archived) {
  return updateExperiment(experimentId, { archived_at: archived ? new Date().toISOString() : null })
}

// Runs and attachment ROWS cascade with the experiment, but Storage objects
// do not — Supabase Storage is a separate API, so the files are listed and
// removed explicitly before the row goes, exactly as deleteProject does.
export async function deleteExperiment(experimentId) {
  const attachments = await listAttachments(experimentId)
  const paths = attachments.map((a) => a.storage_path)
  if (paths.length) await deleteStoragePaths(paths)

  const { error } = await supabase.from('experiments').delete().eq('id', experimentId)
  if (error) throw error
}

// ── Run log ───────────────────────────────────────────────────────────────

export async function listRuns(experimentId) {
  return selectAll(
    () =>
      supabase
        .from('experiment_runs')
        .select('id, epoch, metrics')
        .eq('experiment_id', experimentId),
    { orderBy: 'epoch' },
  )
}

// Upsert on (experiment_id, epoch), then drop any epoch the new log doesn't
// mention. Re-importing the same file is therefore a no-op rather than a
// doubled chart, and re-importing a SHORTER log genuinely shortens it —
// an upsert alone would leave the old tail behind and draw a curve that
// never happened.
export async function replaceRuns(experimentId, projectId, runs) {
  const rows = runs.map((r) => ({
    experiment_id: experimentId,
    project_id: projectId,
    epoch: r.epoch,
    metrics: r.metrics ?? {},
  }))

  for (let i = 0; i < rows.length; i += CHUNK) {
    const { error } = await supabase
      .from('experiment_runs')
      .upsert(rows.slice(i, i + CHUNK), { onConflict: 'experiment_id,epoch' })
    if (error) throw error
  }

  const keep = rows.map((r) => r.epoch)
  let del = supabase.from('experiment_runs').delete().eq('experiment_id', experimentId)
  if (keep.length) del = del.not('epoch', 'in', `(${keep.join(',')})`)
  const { error: dErr } = await del
  if (dErr) throw dErr
}

// ── Attachments ───────────────────────────────────────────────────────────

export async function listAttachments(experimentId) {
  const { data, error } = await supabase
    .from('experiment_attachments')
    .select('id, storage_path, original_filename, content_type, byte_size, created_at')
    .eq('experiment_id', experimentId)
    .order('created_at', { ascending: true })
  if (error) throw error
  return data
}

// The {projectId}/... prefix is not cosmetic: listProjectStorageObjects in
// admin.js walks down from projectId to sweep a project's files on delete,
// so anything stored outside it is orphaned the moment the project goes.
export async function addAttachment({ experimentId, projectId, userId, file }) {
  const id = crypto.randomUUID()
  const safeName = file.name.replace(/[^\w.\-]+/g, '_')
  const path = `${projectId}/experiments/${experimentId}/${id}-${safeName}`

  await uploadFile(path, file)

  const { data, error } = await supabase
    .from('experiment_attachments')
    .insert({
      id,
      experiment_id: experimentId,
      project_id: projectId,
      storage_path: path,
      original_filename: file.name,
      content_type: file.type || null,
      byte_size: file.size ?? null,
      uploaded_by: userId,
    })
    .select('id, storage_path, original_filename, content_type, byte_size, created_at')
    .single()
  if (error) throw error
  return data
}

// Row first, then the file. The other order can leave a row pointing at
// nothing if the delete fails halfway; this way the worst case is an
// unreferenced file, which the project-delete sweep picks up later.
export async function removeAttachment(attachment) {
  const { error } = await supabase
    .from('experiment_attachments')
    .delete()
    .eq('id', attachment.id)
  if (error) throw error
  await deleteStoragePaths([attachment.storage_path])
}

export async function attachmentUrl(path) {
  return getSignedUrl(path)
}

// ── Model families (the filter pills) ─────────────────────────────────────

// One model family per member — that is what the pill row on the Experiments
// page is. Returns the roster either way, so a project where nobody has set
// a family still gets pills, labelled by name.
export async function listModelFamilies(projectId) {
  const { data, error } = await supabase
    .from('project_members')
    .select('reviewer_id, is_lead, model_family, reviewer:reviewers(id, email, display_name)')
    .eq('project_id', projectId)
  if (error) throw error

  return data
    .filter((m) => m.reviewer)
    .map((m) => ({
      reviewerId: m.reviewer.id,
      email: m.reviewer.email,
      displayName: m.reviewer.display_name,
      modelFamily: m.model_family,
      isLead: m.is_lead,
      // What the pill actually says: the family if there is one, otherwise
      // fall back to the person, so no pill is ever blank.
      label: m.model_family || m.reviewer.display_name || m.reviewer.email,
    }))
    .sort((a, b) => a.label.localeCompare(b.label))
}

// Leads only — enforced by the existing members_update RLS policy, which is
// USING (is_project_lead(project_id)).
export async function setModelFamily(projectId, reviewerId, family) {
  const clean = family?.trim() || null
  const { error } = await supabase
    .from('project_members')
    .update({ model_family: clean })
    .eq('project_id', projectId)
    .eq('reviewer_id', reviewerId)
  if (error) {
    // project_members_model_family_idx is unique on (project_id, lower(family)):
    // one model family belongs to exactly one member.
    if (error.code === '23505') throw new Error(`${clean} is already assigned to another member.`)
    throw error
  }
}
