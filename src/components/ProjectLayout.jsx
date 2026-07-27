import { useEffect, useState } from 'react'
import { NavLink, Outlet, useParams, Link } from 'react-router-dom'
import { supabase } from '../lib/supabaseClient'
import { getProject, getMyMembership } from '../lib/projects'

// Wraps every in-project screen. Loads the project (RLS guarantees the user is
// a member), figures out if they're a lead, and exposes both to child routes
// via Outlet context. All nav links are scoped to /projects/:projectId.
export default function ProjectLayout({ session }) {
  const { projectId } = useParams()
  const [project, setProject] = useState(null)
  const [isLead, setIsLead] = useState(false)
  const [error, setError] = useState(null)

  useEffect(() => {
    let alive = true
    Promise.all([getProject(projectId), getMyMembership(projectId)])
      .then(([p, m]) => {
        if (!alive) return
        setProject(p)
        setIsLead(!!m?.is_lead)
      })
      .catch((e) => alive && setError(e.message))
    return () => {
      alive = false
    }
  }, [projectId])

  const links = [
    { to: '', label: 'Review Queue', end: true },
    { to: 'upload', label: 'Upload' },
    { to: 'fix', label: 'Fix' },
    { to: 'dashboard', label: 'Dashboard' },
    { to: 'members', label: 'Members' },
  ]

  if (error)
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-50 text-rose-600">
        {error} — <Link to="/" className="ml-2 underline">back to projects</Link>
      </div>
    )

  return (
    <div className="min-h-screen bg-slate-50 text-slate-800">
      <header className="flex items-center justify-between border-b border-slate-200 bg-white px-6 py-3">
        <div className="flex items-center gap-6">
          <Link to="/" className="text-sm text-slate-400 hover:text-slate-600">
            ← Projects
          </Link>
          <span className="font-bold">{project?.name ?? '…'}</span>
          <nav className="flex gap-1">
            {links.map((l) => (
              <NavLink
                key={l.to}
                to={l.to}
                end={l.end}
                className={({ isActive }) =>
                  `rounded px-3 py-1 text-sm ${
                    isActive
                      ? 'bg-slate-800 text-white'
                      : 'text-slate-600 hover:bg-slate-100'
                  }`
                }
              >
                {l.label}
              </NavLink>
            ))}
          </nav>
        </div>
        <div className="flex items-center gap-3 text-sm text-slate-500">
          <span>
            {session.user.email}
            {isLead && <span className="ml-1 text-slate-400">(lead)</span>}
          </span>
          <button
            onClick={() => supabase.auth.signOut()}
            className="rounded border border-slate-300 px-3 py-1 hover:bg-slate-100"
          >
            Sign out
          </button>
        </div>
      </header>

      <main className="p-6">
        {/* Child screens read { projectId, project, isLead } via useOutletContext() */}
        <Outlet context={{ projectId, project, isLead }} />
      </main>
    </div>
  )
}
