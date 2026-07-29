import { useEffect } from 'react'
import { BrowserRouter, Routes, Route } from 'react-router-dom'
import { supabase } from './lib/supabaseClient'
import { useSession } from './auth/useSession'
import { ToastProvider } from './components/Toast'
import Login from './pages/Login'
import ProjectsList from './pages/ProjectsList'
import ProjectLayout from './components/ProjectLayout'
import ReviewQueue from './pages/ReviewQueue'
import Upload from './pages/Upload'
import Dashboard from './pages/Dashboard'
import Members from './pages/Members'

// Make sure a row exists in `reviewers` for the logged-in user, and keep the
// email current (the email is how leads add this person to a project).
async function ensureReviewer(user) {
  await supabase.from('reviewers').upsert(
    {
      id: user.id,
      email: user.email?.toLowerCase(),
      display_name: user.email,
    },
    { onConflict: 'id' },
  )
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
            <Route path="upload" element={<Upload />} />
            <Route path="dashboard" element={<Dashboard />} />
            <Route path="members" element={<Members />} />
          </Route>
        </Routes>
      </BrowserRouter>
    </ToastProvider>
  )
}