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
