import { describe, it, expect } from 'vitest'
import { distributeEvenly } from './redoDistribution'

// Covers the redo auto-distribution rule: the unassigned pool is handed
// out so that TOTAL per-member load ends up as level as possible, without
// ever reassigning work someone already holds.

// Convenience: build the load Map the way rebalanceRedoAssignments does.
const load = (obj) => new Map(Object.entries(obj))

// How many each reviewer ends up with, given what they started with.
function finalCounts(before, result) {
  const counts = { ...before }
  for (const [reviewerId, ids] of result) counts[reviewerId] += ids.length
  return counts
}

describe('distributeEvenly', () => {
  it('splits an even backlog evenly across members', () => {
    const result = distributeEvenly(
      Array.from({ length: 8 }, (_, i) => `m${i}`),
      load({ a: 0, b: 0, c: 0, d: 0 }),
    )
    expect(finalCounts({ a: 0, b: 0, c: 0, d: 0 }, result)).toEqual({ a: 2, b: 2, c: 2, d: 2 })
  })

  it('spreads the remainder one-each when it does not divide evenly', () => {
    // The plan's worked example: 190 across 4 -> 48/48/47/47.
    const result = distributeEvenly(
      Array.from({ length: 190 }, (_, i) => `m${i}`),
      load({ a: 0, b: 0, c: 0, d: 0 }),
    )
    const counts = finalCounts({ a: 0, b: 0, c: 0, d: 0 }, result)
    expect(Object.values(counts).sort()).toEqual([47, 47, 48, 48])
    expect(Object.values(counts).reduce((n, x) => n + x, 0)).toBe(190)
  })

  it('levels totals rather than splitting the new pool evenly', () => {
    // The case a positional round-robin gets wrong: `a` is already loaded,
    // so a fair split of 6 new items is NOT 3/3 — it's everything to `b`
    // until the two are level, then alternating.
    const before = { a: 10, b: 4 }
    const result = distributeEvenly(['m1', 'm2', 'm3', 'm4', 'm5', 'm6'], load(before))
    expect(finalCounts(before, result)).toEqual({ a: 10, b: 10 })
    expect(result.get('a')).toBeUndefined() // `a` correctly gets nothing
    expect(result.get('b')).toHaveLength(6)
  })

  it('gives a brand-new member the whole pool until they catch up', () => {
    // Adding a member to a project with an existing backlog: they should
    // absorb the unassigned work first, since nobody else's is touched.
    const before = { veteran: 20, newcomer: 0 }
    const result = distributeEvenly(['m1', 'm2', 'm3'], load(before))
    expect(result.get('newcomer')).toEqual(['m1', 'm2', 'm3'])
    expect(result.has('veteran')).toBe(false)
  })

  it('never reassigns existing work — only the ids it is given', () => {
    const result = distributeEvenly(['m1', 'm2'], load({ a: 5, b: 5 }))
    const handedOut = [...result.values()].flat()
    expect(handedOut.sort()).toEqual(['m1', 'm2'])
  })

  it('returns nothing when there are no members', () => {
    expect(distributeEvenly(['m1', 'm2'], load({})).size).toBe(0)
  })

  it('returns nothing when there is no backlog', () => {
    expect(distributeEvenly([], load({ a: 0, b: 0 })).size).toBe(0)
  })

  it('mutates the passed load map to the resulting load', () => {
    // a=1,b=0 plus 3 items: b, then a (tie at 1, broken by order), then b.
    const current = load({ a: 1, b: 0 })
    distributeEvenly(['m1', 'm2', 'm3'], current)
    expect(Object.fromEntries(current)).toEqual({ a: 2, b: 2 })
  })
})
