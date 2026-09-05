import { useCallback, useEffect, useState } from 'react'
import { fetchWeeklyLeaderboard } from '../lib/leaderboard'

// Self-fetching (unlike MetricChart) so it drops into any page that already
// has a projectId in scope — Dashboard today, potentially Members later —
// with no wiring beyond the one prop.
export default function WeeklyLeaderboard({ projectId }) {
  const [weeksAgo, setWeeksAgo] = useState(0)
  const [board, setBoard] = useState(null) // { label, rows }
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const result = await fetchWeeklyLeaderboard(projectId, { weeksAgo })
      setBoard(result)
    } catch (e) {
      console.error('fetchWeeklyLeaderboard failed:', e)
      setError('Could not load the leaderboard.')
    } finally {
      setLoading(false)
    }
  }, [projectId, weeksAgo])

  useEffect(() => {
    load()
  }, [load])

  const rows = board?.rows ?? []
  const hasActivity = rows.some((r) => r.total > 0)

  return (
    <section className="rounded-xl border border-[#E5E4DF] bg-white p-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-medium">Leaderboard</h2>
          <p className="mt-0.5 text-xs text-[#888780]">
            {board ? `Week of ${board.label}` : 'Loading…'}
          </p>
        </div>
        <div className="flex items-center gap-1 rounded-full border border-[#E5E4DF] p-1 text-xs">
          <button
            onClick={() => setWeeksAgo((w) => w + 1)}
            className="flex h-6 w-6 items-center justify-center rounded-full text-[#5F5E5A] hover:bg-[#F1EFE8]"
            aria-label="Previous week"
            title="Previous week"
          >
            <i className="ti ti-chevron-left text-sm" aria-hidden="true"></i>
          </button>
          <span className="min-w-[3rem] text-center text-[#888780]">
            {weeksAgo === 0 ? 'This week' : `${weeksAgo}w ago`}
          </span>
          <button
            disabled={weeksAgo === 0}
            onClick={() => setWeeksAgo((w) => Math.max(0, w - 1))}
            className="flex h-6 w-6 items-center justify-center rounded-full text-[#5F5E5A] hover:bg-[#F1EFE8] disabled:cursor-not-allowed disabled:opacity-30"
            aria-label="Next week"
            title="Next week"
          >
            <i className="ti ti-chevron-right text-sm" aria-hidden="true"></i>
          </button>
        </div>
      </div>

      {loading && <p className="mt-4 text-sm text-[#888780]">Loading…</p>}
      {!loading && error && <p className="mt-4 text-sm text-[#791F1F]">{error}</p>}

      {!loading && !error && rows.length === 0 && (
        <p className="mt-4 text-sm text-[#888780]">No members on this project yet.</p>
      )}

      {!loading && !error && rows.length > 0 && !hasActivity && (
        <p className="mt-4 text-sm text-[#888780]">No activity logged for this week yet.</p>
      )}

      {!loading && !error && hasActivity && (
        <div className="mt-3 overflow-x-auto">
          <table className="w-full min-w-[420px] text-sm">
            <thead>
              <tr className="text-left text-xs text-[#888780]">
                <th className="w-8 pb-2 font-normal">#</th>
                <th className="pb-2 font-normal">Member</th>
                <th className="pb-2 text-right font-normal">Pass</th>
                <th className="pb-2 text-right font-normal">Fail</th>
                <th className="pb-2 text-right font-normal">Redo</th>
                <th className="pb-2 text-right font-normal">Total</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={r.reviewerId} className="border-t border-[#F1EFE8]">
                  <td className="py-2 text-[#888780]">{i + 1}</td>
                  <td className="py-2 font-medium text-[#1a1a1a]">
                    {r.displayName || r.email}
                  </td>
                  <td className="py-2 text-right text-[#27500A]">{r.pass}</td>
                  <td className="py-2 text-right text-[#791F1F]">{r.fail}</td>
                  <td className="py-2 text-right text-[#5F5E5A]">{r.redo}</td>
                  <td className="py-2 text-right font-medium text-[#1a1a1a]">{r.total}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}
