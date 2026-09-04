import { supabase } from './supabaseClient'
import { selectAll, IN_CHUNK } from './paging'
import { distributeEvenly } from './redoDistribution'

// Redo BATCHES: the record of what someone has actually downloaded.
//
// The distinction that matters is download vs assignment. A mask is assigned
// automatically the moment a reviewer fails it — long before anyone exports a
// zip — so "assigned" never meant "somebody is working on this". Re-levelling
// on assignment alone would take a half-finished batch away from whoever was
// annotating it.
//
// A batch is OPEN from the moment it is exported until its masks come back
// through the redo upload. Open batches are untouchable. Everything else can
// be released and re-dealt, even when it currently shows as assigned.

// Rows per `.in()` — matches paging.js, same URL-length reason.
const UPDATE_CHUNK = IN_CHUNK

// `active_masks` does NOT expose redo_batch_id: the view has a fixed column
// list that predates the column, so `select redo_batch_id from active_masks`
// is a 42703. Anything needing BOTH facts — "is this mask still on the latest
// photo version" AND "is it inside a batch" — therefore reads redo_batch_id
// from the base table and intersects against this id set.
//
// (Adding the column to the view would let both filters live in one query;
// that needs the view recreated, which is a migration, not a code change.)
async function fetchActiveFailIds(projectId) {
  const rows = await selectAll(
    () =>
      supabase
        .from('active_masks')
        .select('id')
        .eq('project_id', projectId)
        .eq('status', 'fail'),
    { orderBy: 'id' },
  )
  return new Set(rows.map((r) => r.id))
}

// Opens a batch for `reviewerId` covering `maskIds`, and stamps those masks
// so nothing can re-deal them until the batch is submitted. Called at export
// time — the moment the work actually leaves the app.
//
// batch_number is per project, so everyone's first round is batch 1 and the
// numbering reads the way people talk about it ("he's still on batch 1").
export async function openBatch(projectId, reviewerId, maskIds, { note } = {}) {
  if (maskIds.length === 0) return null

  const { data: last, error: nErr } = await supabase
    .from('redo_batches')
    .select('batch_number')
    .eq('project_id', projectId)
    .order('batch_number', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (nErr) throw nErr

  const { data: batch, error } = await supabase
    .from('redo_batches')
    .insert({
      project_id: projectId,
      reviewer_id: reviewerId,
      batch_number: (last?.batch_number ?? 0) + 1,
      note: note ?? null,
    })
    .select('id, batch_number')
    .single()
  if (error) throw error

  for (let i = 0; i < maskIds.length; i += UPDATE_CHUNK) {
    const { error: uErr } = await supabase
      .from('masks')
      .update({ redo_batch_id: batch.id, assigned_to: reviewerId })
      .in('id', maskIds.slice(i, i + UPDATE_CHUNK))
      .eq('status', 'fail')
    if (uErr) throw uErr
  }

  return batch
}

// Closes any batch whose masks have all come back — called after a redo
// upload. A batch stays open while even one mask is outstanding, so a partial
// re-upload does not release the rest of someone's work mid-batch.
export async function closeCompletedBatches(projectId, reviewerId) {
  const { data: open, error } = await supabase
    .from('redo_batches')
    .select('id')
    .eq('project_id', projectId)
    .eq('reviewer_id', reviewerId)
    .is('submitted_at', null)
  if (error) throw error

  // Superseded masks must not hold a batch open forever: they can never be
  // re-uploaded against, so waiting on them would leave their owner
  // permanently mid-batch.
  const activeFail = await fetchActiveFailIds(projectId)

  const closed = []
  for (const batch of open) {
    const rows = await selectAll(
      () => supabase.from('masks').select('id').eq('redo_batch_id', batch.id).eq('status', 'fail'),
      { orderBy: 'id' },
    )
    if (rows.some((r) => activeFail.has(r.id))) continue // still outstanding

    const { error: uErr } = await supabase
      .from('redo_batches')
      .update({ submitted_at: new Date().toISOString() })
      .eq('id', batch.id)
    if (uErr) throw uErr
    closed.push(batch.id)
  }
  return closed
}

// Who currently holds a downloaded batch. Reported so the UI can say who is
// mid-batch — NOT used to exclude anyone from a re-level. Holding an open
// batch protects the masks inside it; it does not take you out of the deal
// for everything else, or someone who downloaded early would fall further
// and further behind the people who did not.
export async function fetchEligibleMembers(projectId) {
  const [{ data: members, error: mErr }, { data: openBatches, error: bErr }] = await Promise.all([
    supabase.from('project_members').select('reviewer_id').eq('project_id', projectId),
    supabase
      .from('redo_batches')
      .select('reviewer_id')
      .eq('project_id', projectId)
      .is('submitted_at', null),
  ])
  if (mErr) throw mErr
  if (bErr) throw bErr

  const busy = new Set(openBatches.map((b) => b.reviewer_id))
  return {
    eligible: members.map((m) => m.reviewer_id).filter((id) => !busy.has(id)),
    busy: [...busy],
  }
}

// Re-levels the redo backlog.
//
// Unlike rebalanceAssignments — which only ever hands out masks nobody holds,
// and so can never correct an existing imbalance — this RELEASES first. What
// it can release is exactly what nobody has downloaded: anything inside an
// open batch is excluded by construction.
//
// Everyone takes part in the deal, including people mid-batch. What an open
// batch protects is the masks inside it, not its owner's place in the queue —
// they are simply topped up to the same TOTAL as everyone else.
//
// Owner-triggered rather than automatic. Moving work between people is a
// decision, not a background chore.
export async function relevelRedo(projectId) {
  const { data: members, error: mErr } = await supabase
    .from('project_members')
    .select('reviewer_id')
    .eq('project_id', projectId)
  if (mErr) throw mErr
  if (members.length === 0) {
    return { released: 0, dealt: 0, perMember: {}, participants: 0, busy: 0 }
  }
  const participants = members.map((m) => m.reviewer_id)
  const { busy } = await fetchEligibleMembers(projectId)

  // Release: unbatched fail work only. An open batch is somebody's downloaded
  // zip, in progress on their machine.
  // Read through `active_masks`, NOT raw `masks` — the same rule
  // rebalanceAssignments follows. Masks on superseded photo versions keep
  // their status and assignment but render nowhere, so dealing them out
  // spends real quota on work nobody can open: a member's visible total
  // comes up short by however many stale rows they were handed.
  const activeFail = await fetchActiveFailIds(projectId)
  const held = (
    await selectAll(
      () =>
        supabase
          .from('masks')
          .select('id')
          .eq('project_id', projectId)
          .eq('status', 'fail')
          .is('redo_batch_id', null)
          .not('assigned_to', 'is', null),
      { orderBy: 'id' },
    )
  ).filter((m) => activeFail.has(m.id))
  for (let i = 0; i < held.length; i += UPDATE_CHUNK) {
    const { error } = await supabase
      .from('masks')
      .update({ assigned_to: null })
      .in(
        'id',
        held.slice(i, i + UPDATE_CHUNK).map((m) => m.id),
      )
    if (error) throw error
  }

  // Deal the whole free pool across EVERY member, including anyone holding an
  // open batch. Their surviving load is exactly what is locked in that batch,
  // and seeding it means distributeEvenly levels TOTALS: someone already
  // holding 969 is topped up to the same total as everyone else rather than
  // being handed a full share on top, or skipped entirely.
  const pool = (
    await selectAll(
      () =>
        supabase
          .from('masks')
          .select('id')
          .eq('project_id', projectId)
          .eq('status', 'fail')
          .is('redo_batch_id', null)
          .is('assigned_to', null),
      { orderBy: 'id' },
    )
  ).filter((m) => activeFail.has(m.id))

  const load = new Map(participants.map((id) => [id, 0]))
  await Promise.all(
    participants.map(async (id) => {
      const { count, error } = await supabase
        .from('active_masks')
        .select('id', { count: 'exact', head: true })
        .eq('project_id', projectId)
        .eq('status', 'fail')
        .eq('assigned_to', id)
      if (error) throw error
      load.set(id, count ?? 0)
    }),
  )

  const byReviewer = distributeEvenly(
    pool.map((m) => m.id),
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

  return {
    released: held.length,
    dealt: pool.length,
    perMember,
    participants: participants.length,
    busy: busy.length,
  }
}

// Open-batch summary per member, for the Members page.
export async function fetchOpenBatches(projectId) {
  const { data, error } = await supabase
    .from('redo_batches')
    .select('id, reviewer_id, batch_number, exported_at')
    .eq('project_id', projectId)
    .is('submitted_at', null)
  if (error) throw error

  const activeFail = await fetchActiveFailIds(projectId)
  const byReviewer = {}
  await Promise.all(
    data.map(async (b) => {
      const rows = await selectAll(
        () => supabase.from('masks').select('id').eq('redo_batch_id', b.id).eq('status', 'fail'),
        { orderBy: 'id' },
      )
      byReviewer[b.reviewer_id] = {
        batchNumber: b.batch_number,
        exportedAt: b.exported_at,
        outstanding: rows.filter((r) => activeFail.has(r.id)).length,
      }
    }),
  )
  return byReviewer
}
