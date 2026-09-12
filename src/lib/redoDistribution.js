// The redo auto-distribution rule, kept free of any Supabase import so it
// can be unit tested without env vars or a database (supabaseClient.js
// throws at import time when VITE_SUPABASE_* are unset). projects.js does
// the querying and updating around this.

// Hands each id to whoever currently holds the fewest, updating the
// running load as it goes, so TOTAL per-member load ends up as level as
// possible rather than merely splitting the new pool evenly.
//
// `currentLoad` is a Map of reviewerId -> how many they already hold, and
// is mutated to the resulting load. Returns a Map of reviewerId -> the ids
// they were given (members who get nothing are absent). Ties break toward
// `currentLoad`'s iteration order, keeping the result deterministic for a
// given member order.
export function distributeEvenly(ids, currentLoad) {
  const byReviewer = new Map()
  for (const id of ids) {
    let target = null
    let lowest = Infinity
    for (const [reviewerId, count] of currentLoad) {
      if (count < lowest) {
        lowest = count
        target = reviewerId
      }
    }
    if (target === null) break // no members to assign to
    currentLoad.set(target, lowest + 1)
    if (!byReviewer.has(target)) byReviewer.set(target, [])
    byReviewer.get(target).push(id)
  }
  return byReviewer
}

// Full credit for work already finished: 1 submitted correction offsets 1
// redo mask. See seedLoad's creditWeight for what to change if this turns
// out too sharp.
export const CREDIT_WEIGHT = 1

// Builds the load map distributeEvenly levels, for the REDO pool.
//
// The thing being levelled is not "how many redo masks each member is
// holding" but "how much redo work each member has taken on in total" —
// what they have already finished plus what they are still holding:
//
//   seed = held + corrections submitted
//
// Levelling outstanding count alone (what this used to do, by passing the
// held counts straight into distributeEvenly) makes the split come out equal
// between people no matter what they have contributed, because equal
// outstanding is the loop's only fixed point. Someone who has submitted 300
// corrections and someone who has submitted 20 both get topped up to the
// same number, so the person who already did the work is handed just as much
// again.
//
// Seeding with the total instead means whoever is behind absorbs the pool
// until the lifetime totals line up, after which the split returns to even on
// its own. Self-correcting rather than a permanent handicap.
//
// `creditWeight` scales the offset: 1 is full credit (being far enough ahead
// takes you out of the deal until the others catch up), 0.5 lightens your
// share without ever zeroing it, 0 restores plain outstanding-count
// levelling.
//
// `memberIds` fixes the Map's iteration order, and distributeEvenly breaks
// ties by that order — so callers pass a stable member order rather than
// relying on whatever order their count queries happened to resolve in, or
// the same inputs stop producing the same split.
export function seedLoad(memberIds, held, credit, creditWeight = CREDIT_WEIGHT) {
  return new Map(
    memberIds.map((id) => [id, (held.get(id) ?? 0) + (credit.get(id) ?? 0) * creditWeight]),
  )
}
