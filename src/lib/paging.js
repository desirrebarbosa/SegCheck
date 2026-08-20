// PostgREST returns at most 1000 rows per request, silently. A plain
// `.select()` over a table with more than that comes back truncated with no
// error and no indication anything is missing — which is how a redo export
// of 3910 masks quietly became an export of 1000.
//
// Everything that reads an unbounded set of rows should go through
// selectAll() rather than a bare select.

export const PAGE_SIZE = 1000

// `build()` must return a FRESH PostgREST query each call — the builders are
// thenable and single-use, so reusing one across pages does not work.
//
// `orderBy` is not optional and defaults to a unique column on purpose:
// Postgres gives no row-order guarantee without an ORDER BY, so paging with
// .range() alone can return a row on two pages or on neither. Skipping a row
// silently is exactly the failure this helper exists to prevent, so pass a
// column that is unique within the result set.
export async function selectAll(build, { orderBy = 'id', ascending = true } = {}) {
  const rows = []
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await build()
      .order(orderBy, { ascending })
      .range(from, from + PAGE_SIZE - 1)
    if (error) throw error
    rows.push(...(data ?? []))
    if (!data || data.length < PAGE_SIZE) break
  }
  return rows
}

// How many values go into one `.in(column, [...])`. PostgREST puts them in
// the request URL, so an unbounded list — a redo zip naming a few thousand
// masks, say — builds a URL long enough to be rejected by the server or the
// browser. Matches UPDATE_CHUNK in projects.js, which exists for the same
// reason on the write side.
export const IN_CHUNK = 200

// Runs one `.in()` query per chunk of `values` and concatenates the rows.
// `build(chunk)` returns a fresh query for that chunk. Each chunk is capped
// at PAGE_SIZE rows, so chunks stay well inside the row cap too: 200 ids can
// only match 200 rows when the filter column is unique.
export async function selectAllIn(values, build) {
  const rows = []
  for (let i = 0; i < values.length; i += IN_CHUNK) {
    const { data, error } = await build(values.slice(i, i + IN_CHUNK))
    if (error) throw error
    rows.push(...(data ?? []))
  }
  return rows
}
