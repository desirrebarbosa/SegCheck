import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { supabase } from '../lib/supabaseClient'
import {
  listMyProjects,
  createProject,
  fetchProjectStatusCounts,
  fetchWeeklyActivity,
} from '../lib/projects'
import { useToast } from '../components/Toast'

function sparklinePoints(counts) {
  const max = Math.max(1, ...counts)
  const w = 160
  const h = 36
  const step = w / (counts.length - 1)
  return counts.map((c, i) => `${i * step},${h - (c / max) * (h - 4) - 2}`).join(' ')
}

export default function ProjectsList({ session }) {
  const { showError } = useToast()
  const navigate = useNavigate()
  const [projects, setProjects] = useState(null) // null = loading
  const [summaries, setSummaries] = useState({}) // projectId -> { pending, pass, fail, activity }
  const [showNew, setShowNew] = useState(false)
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)

  async function refresh() {
    let list
    try {
      list = await listMyProjects()
      setProjects(list)
    } catch (e) {
      console.error('listMyProjects failed:', e)
      setProjects([])
      showError('Could not load your projects. Please try again.')
      return
    }

    // Per-project summary (counts + weekly activity) fetched in parallel —
    // failures are per-card, not fatal to the whole list.
    await Promise.all(
      list.map(async (p) => {
        try {
          const [counts, activity] = await Promise.all([
            fetchProjectStatusCounts(p.id),
            fetchWeeklyActivity(p.id),
          ])
          setSummaries((s) => ({ ...s, [p.id]: { ...counts, activity } }))
        } catch (e) {
          console.error('Project summary failed for', p.id, e)
        }
      }),
    )
  }

  useEffect(() => {
    refresh()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  async function handleAdd(e) {
    e.preventDefault()
    if (!name.trim()) return
    setBusy(true)
    try {
      await createProject(name)
      setName('')
      setShowNew(false)
      await refresh()
    } catch (e) {
      console.error('createProject failed:', e)
      showError('Could not create the project. Please try again.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="min-h-screen bg-white text-[#1a1a1a]">
      <header className="flex items-center justify-between border-b border-[#E5E4DF] px-4 py-3 md:px-6">
        <span className="text-sm font-medium text-[#5F5E5A]">Projects</span>
        <div className="flex items-center gap-3 text-sm text-[#888780]">
          <span className="hidden sm:inline">{session.user.email}</span>
          <button
            onClick={() => supabase.auth.signOut()}
            className="rounded-lg border border-[#B4B2A9] px-3 py-1.5 text-xs hover:bg-[#F7F7F5]"
          >
            Sign out
          </button>
        </div>
      </header>

      <main className="mx-auto max-w-3xl p-4 md:p-6">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-medium">Your projects</h2>
          <button
            onClick={() => setShowNew((v) => !v)}
            className="flex items-center gap-1.5 rounded-lg bg-[#1a1a1a] px-3.5 py-2 text-sm font-medium text-white"
          >
            <i className="ti ti-plus text-base" aria-hidden="true"></i>
            New project
          </button>
        </div>

        {showNew && (
          <form onSubmit={handleAdd} className="mb-5 flex gap-2">
            <input
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Project name"
              className="flex-1 rounded-lg border border-[#B4B2A9] px-3 py-2 text-sm"
            />
            <button
              type="submit"
              disabled={busy}
              className="rounded-lg bg-[#1a1a1a] px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
            >
              {busy ? 'Creating…' : 'Create'}
            </button>
          </form>
        )}

        {projects === null && <p className="text-sm text-[#888780]">Loading…</p>}
        {projects?.length === 0 && (
          <p className="text-sm text-[#888780]">No projects yet — create one above.</p>
        )}

        <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
          {projects?.map((p) => {
            const s = summaries[p.id]
            const hasData = s && s.pending + s.pass + s.fail > 0
            return (
              <div
                key={p.id}
                role="link"
                tabIndex={0}
                onClick={() => navigate(`/projects/${p.id}`)}
                onKeyDown={(e) => e.key === 'Enter' && navigate(`/projects/${p.id}`)}
                className={`rounded-xl bg-[#F7F7F5] p-3.5 ${
                  hasData ? 'border border-[#E5E4DF]' : 'border border-dashed border-[#B4B2A9]'
                } cursor-pointer hover:border-[#B4B2A9]`}
              >
                <div className="mb-0.5 flex items-center justify-between">
                  <span className="text-sm font-medium">{p.name}</span>
                  <span
                    className={`rounded-lg px-2 py-0.5 text-xs ${
                      p.is_lead ? 'bg-[#E6F1FB] text-[#0C447C]' : 'bg-[#F1EFE8] text-[#5F5E5A]'
                    }`}
                  >
                    {p.is_lead ? 'lead' : 'reviewer'}
                  </span>
                </div>

                {!s && <p className="mt-2 text-xs text-[#888780]">Loading…</p>}

                {s && !hasData && (
                  <p className="mt-1 text-xs text-[#888780]">
                    No uploads yet — add a dataset to get started.
                  </p>
                )}

                {s && hasData && (
                  <>
                    <p className="mb-1 text-[11px] text-[#888780]">Activities this week</p>
                    <svg
                      width="100%"
                      height="36"
                      viewBox="0 0 160 36"
                      preserveAspectRatio="none"
                      className="mb-2 block"
                    >
                      <polyline
                        points={sparklinePoints(s.activity)}
                        fill="none"
                        stroke="#639922"
                        strokeWidth="2"
                      />
                    </svg>
                    <div className="flex items-center justify-between">
                      <span className="text-xs text-[#5F5E5A]">
                        {s.pending} pending · {s.fail} fail
                      </span>
                      <div className="flex gap-1">
                        <button
                          onClick={(e) => {
                            e.stopPropagation()
                            navigate(`/projects/${p.id}/upload`)
                          }}
                          aria-label="Open upload"
                          className="flex h-7 w-7 items-center justify-center rounded-md border border-[#E5E4DF] bg-white"
                        >
                          <i className="ti ti-upload text-xs text-[#5F5E5A]" aria-hidden="true"></i>
                        </button>
                        <button
                          onClick={(e) => {
                            e.stopPropagation()
                            navigate(`/projects/${p.id}`)
                          }}
                          aria-label="Open review queue"
                          className="flex h-7 w-7 items-center justify-center rounded-md border border-[#E5E4DF] bg-white"
                        >
                          <i
                            className="ti ti-list-check text-xs text-[#5F5E5A]"
                            aria-hidden="true"
                          ></i>
                        </button>
                      </div>
                    </div>
                  </>
                )}
              </div>
            )
          })}
        </div>
      </main>
    </div>
  )
}