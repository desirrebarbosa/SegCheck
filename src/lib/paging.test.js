import { describe, it, expect } from 'vitest'
import { selectAll, selectAllIn, PAGE_SIZE, IN_CHUNK } from './paging'

// Minimal stand-in for a PostgREST query builder: .order() then .range(),
// awaited. Records every range it was asked for so the paging arithmetic
// itself can be asserted, not just the final row count.
function fakeTable(rows, { calls = [] } = {}) {
  return () => ({
    order: () => ({
      range: async (from, to) => {
        calls.push([from, to])
        return { data: rows.slice(from, to + 1), error: null }
      },
    }),
  })
}

describe('selectAll', () => {
  it('returns everything when the table fits in one page', async () => {
    const rows = Array.from({ length: 10 }, (_, i) => ({ id: i }))
    expect(await selectAll(fakeTable(rows))).toHaveLength(10)
  })

  // The bug this helper exists for: a bare select stops at PAGE_SIZE and
  // reports success, so the caller silently works with partial data.
  it('pages past the 1000-row cap', async () => {
    const rows = Array.from({ length: 2350 }, (_, i) => ({ id: i }))
    const result = await selectAll(fakeTable(rows))
    expect(result).toHaveLength(2350)
    expect(result.map((r) => r.id)).toEqual(rows.map((r) => r.id))
  })

  it('requests contiguous, non-overlapping ranges', async () => {
    const calls = []
    const rows = Array.from({ length: 2001 }, (_, i) => ({ id: i }))
    await selectAll(fakeTable(rows, { calls }))
    expect(calls).toEqual([
      [0, PAGE_SIZE - 1],
      [PAGE_SIZE, 2 * PAGE_SIZE - 1],
      [2 * PAGE_SIZE, 3 * PAGE_SIZE - 1],
    ])
  })

  // An exact multiple must still probe once more, otherwise a table of
  // exactly PAGE_SIZE rows is indistinguishable from a truncated one.
  it('stops correctly on an exact page boundary', async () => {
    const calls = []
    const rows = Array.from({ length: PAGE_SIZE }, (_, i) => ({ id: i }))
    const result = await selectAll(fakeTable(rows, { calls }))
    expect(result).toHaveLength(PAGE_SIZE)
    expect(calls).toHaveLength(2)
  })

  it('handles an empty table', async () => {
    expect(await selectAll(fakeTable([]))).toEqual([])
  })

  it('propagates a query error instead of returning partial rows', async () => {
    const build = () => ({
      order: () => ({ range: async () => ({ data: null, error: new Error('boom') }) }),
    })
    await expect(selectAll(build)).rejects.toThrow('boom')
  })
})

describe('selectAllIn', () => {
  it('splits the value list into chunks and concatenates the results', async () => {
    const values = Array.from({ length: 450 }, (_, i) => i)
    const chunks = []
    const rows = await selectAllIn(values, async (chunk) => {
      chunks.push(chunk.length)
      return { data: chunk.map((v) => ({ id: v })), error: null }
    })
    expect(chunks).toEqual([IN_CHUNK, IN_CHUNK, 50])
    expect(rows.map((r) => r.id)).toEqual(values)
  })

  it('does nothing when there are no values', async () => {
    let called = false
    const rows = await selectAllIn([], async () => {
      called = true
      return { data: [], error: null }
    })
    expect(rows).toEqual([])
    expect(called).toBe(false)
  })

  it('propagates a chunk error', async () => {
    await expect(
      selectAllIn([1, 2, 3], async () => ({ data: null, error: new Error('nope') })),
    ).rejects.toThrow('nope')
  })
})
