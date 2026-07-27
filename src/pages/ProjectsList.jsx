import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { supabase } from '../lib/supabaseClient'
import { listMyProjects, createProject } from '../lib/projects'

// Landing screen after login: the reviewer's projects + "Add project".
export default function ProjectsList({ session }) {
  const [projects, setProjects] = useState(null) // null = loading
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)

  async function refresh() {
    try {
      setError(null)
      setProjects(await listMyProjects())
    } catch (e) {
      // Keep raw DB internals out of the UI; log for debugging only.
      console.error('listMyProjects failed:', e)
      setProjects([])
      setError('Could not load your projects. Please try again.')
    }
  }

  useEffect(() => {
    refresh()
  }, [])

  async function handleAdd(e) {
    e.preventDefault()
    if (!name.trim()) return
    setBusy(true)
    setError(null)
    try {
      await createProject(name)
      setName('')
      await refresh()
    } catch (e) {
      console.error('createProject failed:', e)
      setError('Could not create the project. Please try again.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="min-h-screen bg-slate-50 text-slate-800">
      <header className="flex items-center justify-between border-b border-slate-200 bg-white px-6 py-3">
        <span className="font-bold">SegCheck</span>
        <div className="flex items-center gap-3 text-sm text-slate-500">
          <span>{session.user.email}</span>
          <button
            onClick={() => supabase.auth.signOut()}
            className="rounded border border-slate-300 px-3 py-1 hover:bg-slate-100"
          >
            Sign out
          </button>
        </div>
      </header>

      <main className="mx-auto max-w-2xl p-6">
        <h2 className="text-xl font-semibold">Your projects</h2>

        <form onSubmit={handleAdd} className="mt-4 flex gap-2">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="New project name"
            className="flex-1 rounded border border-slate-300 px-3 py-2 text-sm"
          />
          <button
            type="submit"
            disabled={busy}
            className="rounded bg-slate-800 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
          >
            + Add project
          </button>
        </form>

        {error && <p className="mt-3 text-xs text-rose-600">{error}</p>}

        <ul className="mt-6 space-y-2">
          {projects === null && <li className="text-sm text-slate-400">Loading…</li>}
          {projects?.length === 0 && !error && (
            <li className="text-sm text-slate-400">
              No projects yet — create one above.
            </li>
          )}
          {projects?.map((p) => (
            <li key={p.id}>
              <Link
                to={`/projects/${p.id}`}
                className="flex items-center justify-between rounded-lg border border-slate-200 bg-white px-4 py-3 hover:border-slate-400"
              >
                <span className="font-medium">{p.name}</span>
                <span className="text-xs text-slate-400">
                  {p.is_lead ? 'lead' : 'reviewer'}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      </main>
    </div>
  )
}
