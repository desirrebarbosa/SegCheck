import { supabase } from './supabaseClient'
import { seedLoad } from './redoDistribution'

// How the redo pool gets seeded before it is dealt.
//
// This lives in its own module because BOTH deal paths need it and they must
// not drift: rebalanceAssignments() in projects.js hands out the free pool,
// and relevelRedo() in redoBatches.js releases first and re-deals. The load
// block used to be duplicated verbatim in the two, which means crediting one
// and not the other would have a re-level quietly undo what distribution had
// just done.
//
// Kept out of redoDistribution.js on purpose — that file imports no Supabase
// so its rules can be unit tested without env vars (supabaseClient.js throws
// at import time when VITE_SUPABASE_* are unset). The arithmetic lives there;
// the querying lives here.

// Total corrections one reviewer has successfully submitted to a project.
//
// Reads mask_corrections rather than masks/active_masks because submitting a
// correction clears assigned_to and moves the mask to 'fixed' (see the
// submit_corrections RPC) — mask_corrections is the durable record of who did
// the work.
//
// Deliberately NOT filtered to active photo versions, unlike every count of
// outstanding work. A correction on a mask whose photo was later superseded
// still counts: the work was done, and re-uploading a photo does not undo it.
export async function fetchCorrectionCount(projectId, reviewerId) {
  const { count, error } = await supabase
    .from('mask_corrections')
    .select('id', { count: 'exact', head: true })
    .eq('project_id', projectId)
    .eq('submitted_by', reviewerId)
  if (error) throw error
  return count ?? 0
}

// Redo masks one reviewer is holding right now.
//
// Counted through `active_masks`, NOT raw `masks`: masks on superseded photo
// versions keep their status and assignment but are invisible to every
// screen, so counting them tells the leveller someone is busier than they are
// and routes real work away from them.
async function fetchHeldRedoCount(projectId, reviewerId) {
  const { count, error } = await supabase
    .from('active_masks')
    .select('id', { count: 'exact', head: true })
    .eq('project_id', projectId)
    .eq('status', 'fail')
    .eq('assigned_to', reviewerId)
  if (error) throw error
  return count ?? 0
}

// The load map for the redo pool: held + corrections already submitted, per
// member. See seedLoad() in redoDistribution.js for why the credit is there.
//
// Count-only queries (head: true, no rows cross the wire) run in parallel —
// exact at any backlog size, and they naturally ignore rows pointing at
// someone who is no longer a member. Two per member; if a roster ever grows
// past a few dozen people this wants a SQL view instead.
//
// `memberIds` order is carried through to the returned Map, because
// distributeEvenly breaks ties by iteration order and these counts resolve in
// whatever order the network returns them.
export async function fetchRedoLoad(projectId, memberIds) {
  const rows = await Promise.all(
    memberIds.map(async (id) => {
      const [held, credit] = await Promise.all([
        fetchHeldRedoCount(projectId, id),
        fetchCorrectionCount(projectId, id),
      ])
      return { id, held, credit }
    }),
  )

  return seedLoad(
    memberIds,
    new Map(rows.map((r) => [r.id, r.held])),
    new Map(rows.map((r) => [r.id, r.credit])),
  )
}
