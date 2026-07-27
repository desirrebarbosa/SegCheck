import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabaseClient'

// Tracks the current Supabase auth session.
//   undefined  -> still loading (we don't know yet)
//   null       -> definitely logged out
//   <session>  -> logged in
export function useSession() {
  const [session, setSession] = useState(undefined)

  useEffect(() => {
    // Get the session that may already exist (e.g. after a page refresh).
    supabase.auth.getSession().then(({ data }) => setSession(data.session))

    // Then keep it in sync as the user logs in / out.
    const { data: sub } = supabase.auth.onAuthStateChange((_event, s) => {
      setSession(s)
    })
    return () => sub.subscription.unsubscribe()
  }, [])

  return session
}
