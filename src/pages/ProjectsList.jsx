import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { supabase } from '../lib/supabaseClient'
import { listMyProjects, createProject } from '../lib/projects'
import { useToast } from '../components/Toast'

export default function ProjectsList({ session }) {
  const { showError } = useToast()
  const [projects, setProjects] = useState(null) // null = loading
  const [showNew, setShowNew] = useState(false)
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)

  async function refresh() {
    try {
      setProjects(await listMyProjects())
    } catch (e) {
      console.error('listMyProjects failed:', e)
      setProjects([])
      showError('Could not load your projects. Please try again.')
    }
  }

  useEffect(() => {
    refresh()
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
            className="flex items-center gap-1.5 rounded-lg border border-[#B4B2A9] px-3 py-1.5 text-sm hover:bg-[#F7F7F5]"
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

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {projects?.map((p) => (
            <Link
              key={p.id}
              to={`/projects/${p.id}`}
              className="rounded-xl border border-[#E5E4DF] bg-[#F7F7F5] p-4 hover:border-[#B4B2A9]"
            >
              <div className="mb-2 flex items-center justify-between">
                <span className="text-sm font-medium">{p.name}</span>
                <span
                  className={`rounded-lg px-2 py-0.5 text-xs ${
                    p.is_lead ? 'bg-[#E6F1FB] text-[#0C447C]' : 'bg-[#F1EFE8] text-[#5F5E5A]'
                  }`}
                >
                  {p.is_lead ? 'lead' : 'reviewer'}
                </span>
              </div>
            </Link>
          ))}
        </div>
      </main>
    </div>
  )
}