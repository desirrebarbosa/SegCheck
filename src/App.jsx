import { useEffect } from 'react'
import { BrowserRouter, Routes, Route } from 'react-router-dom'
import { supabase } from './lib/supabaseClient'
import { useSession } from './auth/useSession'
import { ToastProvider } from './components/Toast'
import { Analytics } from '@vercel/analytics/react';
import Login from './pages/Login'
import ProjectsList from './pages/ProjectsList'
import ProjectLayout from './components/ProjectLayout'
import ReviewQueue from './pages/ReviewQueue'
import Upload from './pages/Upload'
import Dashboard from './pages/Dashboard'
import Members from './pages/Members'
import MyRedo from './pages/MyRedo'
import Experiments from './pages/Experiments'
import ExperimentDetail from './pages/ExperimentDetail'

// Make sure a row exists in `reviewers` for the logged-in user, and keep the
// email current (the email is how leads add this person to a project).
async function ensureReviewer(user) {
  // display_name is written only when the row does not exist yet, or when it
  // is still blank. The previous version sent it on EVERY sign-in, so it
  // overwrote the stored value with the user's email each time they logged
  // in — harmless only because nothing sets a display name today, and a
  // silent data-loss bug the moment anything does.
  const { data: existing, error: readErr } = await supabase
    .from('reviewers')
    .select('display_name')
    .eq('id', user.id)
    .maybeSingle()
  if (readErr) {
    console.error('ensureReviewer lookup failed:', readErr)
    return
  }

  const row = { id: user.id, email: user.email?.toLowerCase() }
  if (!existing?.display_name) row.display_name = user.email

  // Error CHECKED: without a reviewers row a lead cannot add this person to
  // a project by email, and every query joining reviewers returns null for
  // them. Failing that silently produces a user who simply cannot be
  // invited, with nothing anywhere to say why.
  const { error } = await supabase.from('reviewers').upsert(row, { onConflict: 'id' })
  if (error) console.error('ensureReviewer upsert failed:', error)
}

export default function App() {
  const session = useSession()

  useEffect(() => {
    if (session?.user) ensureReviewer(session.user)
  }, [session])

  if (session === undefined) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-white text-[#888780]">
        Loading…
      </div>
    )
  }

  if (!session) {
    return (
      <ToastProvider>
        <Login />
      </ToastProvider>
    )
  }

  return (
    <ToastProvider>
      <BrowserRouter>
        <Routes>
          {/* Landing: pick or create a project */}
          <Route path="/" element={<ProjectsList session={session} />} />

          {/* Everything inside a project is scoped by :projectId */}
          <Route path="/projects/:projectId" element={<ProjectLayout session={session} />}>
            <Route index element={<ReviewQueue />} />
            <Route path="my-redo" element={<MyRedo />} />
            <Route path="upload" element={<Upload />} />
            <Route path="dashboard" element={<Dashboard />} />
            <Route path="members" element={<Members />} />
            <Route path="experiments" element={<Experiments />} />
            <Route path="experiments/:experimentId" element={<ExperimentDetail />} />
          </Route>
        </Routes>
        <div>
          {/* ... */}
          <Analytics />
        </div>
      </BrowserRouter>
    </ToastProvider>
  )
}