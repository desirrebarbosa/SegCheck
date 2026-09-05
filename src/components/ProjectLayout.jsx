import { useEffect, useState } from 'react'
import { NavLink, Outlet, useParams, Link } from 'react-router-dom'
import { supabase } from '../lib/supabaseClient'
import { getProject, getMyMembership } from '../lib/projects'

const links = [
  { to: '', label: 'Review', icon: 'ti-list-check', end: true },
  { to: 'my-redo', label: 'My Redo', icon: 'ti-clipboard-list' },
  { to: 'upload', label: 'Upload', icon: 'ti-upload' },
  { to: 'dashboard', label: 'Dashboard', icon: 'ti-chart-bar' },
  { to: 'members', label: 'Members', icon: 'ti-users' },
  { to: 'experiments', label: 'Experiments', icon: 'ti-flask' },
]

export default function ProjectLayout({ session }) {
  const { projectId } = useParams()
  const [project, setProject] = useState(null)
  const [isLead, setIsLead] = useState(false)
  const [isOwner, setIsOwner] = useState(false)
  const [error, setError] = useState(null)

  useEffect(() => {
    let alive = true
    Promise.all([getProject(projectId), getMyMembership(projectId)])
      .then(([p, m]) => {
        if (!alive) return
        setProject(p)
        setIsLead(!!m?.is_lead)
        setIsOwner(p.owner_id === session.user.id)
      })
      .catch((e) => alive && setError(e.message))
    return () => {
      alive = false
    }
  }, [projectId, session.user.id])

  if (error) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-white text-rose-700">
        {error} —{' '}
        <Link to="/" className="ml-2 underline">
          back to projects
        </Link>
      </div>
    )
  }

  return (
    <div className="flex min-h-screen bg-white text-[#1a1a1a] md:flex-row flex-col">
      {/* Desktop: left sidebar. Mobile: top bar + horizontal scroller. */}
      <aside className="flex flex-shrink-0 flex-col border-b border-[#E5E4DF] bg-white md:h-screen md:w-44 md:border-b-0 md:border-r">
        <div className="flex items-center justify-between px-3 py-3 md:flex-col md:items-start md:gap-3">
          <Link to="/" className="flex items-center gap-1.5 text-xs text-[#888780] hover:text-[#5F5E5A]">
            <i className="ti ti-chevron-left text-sm" aria-hidden="true"></i>
            Projects
          </Link>
          <span className="text-sm font-medium">{project?.name ?? '…'}</span>
        </div>

        <nav className="flex gap-1 overflow-x-auto px-2 pb-2 md:flex-col md:overflow-visible md:px-2">
          {links.map((l) => (
            <NavLink
              key={l.to}
              to={l.to}
              end={l.end}
              className={({ isActive }) =>
                `flex flex-shrink-0 items-center gap-2 rounded-lg px-2.5 py-1.5 text-sm ${
                  isActive ? 'bg-[#E6F1FB] text-[#0C447C]' : 'text-[#5F5E5A] hover:bg-[#F7F7F5]'
                }`
              }
            >
              <i className={`ti ${l.icon} text-base`} aria-hidden="true"></i>
              {l.label}
            </NavLink>
          ))}
        </nav>

        <div className="mt-auto hidden flex-col gap-1 border-t border-[#E5E4DF] p-3 md:flex">
          <span className="truncate text-xs text-[#888780]">{session.user.email}</span>
          {isLead && <span className="text-xs text-[#5F5E5A]">Project lead</span>}
          <button
            onClick={() => supabase.auth.signOut()}
            className="mt-2 rounded-lg border border-[#B4B2A9] px-2.5 py-1.5 text-left text-xs hover:bg-[#F7F7F5]"
          >
            Sign out
          </button>
        </div>
      </aside>

      <main className="flex-1 p-4 md:p-6">
        {/* Child screens read { projectId, project, isLead, isOwner } via useOutletContext() */}
        <Outlet context={{ projectId, project, isLead, isOwner }} />
      </main>
    </div>
  )
}