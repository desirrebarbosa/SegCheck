import { useState } from 'react'
import { supabase } from '../lib/supabaseClient'

// Email + password auth. The lead can create the 3 reviewer accounts here.
// (In Supabase: Authentication → Providers → Email. If "Confirm email" is on,
// either turn it off for this internal tool, or confirm via the emailed link.)
export default function Login() {
  const [mode, setMode] = useState('signin') // 'signin' | 'signup'
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState(null)

  async function handleSubmit(e) {
    e.preventDefault()
    setBusy(true)
    setMessage(null)
    const { error } =
      mode === 'signin'
        ? await supabase.auth.signInWithPassword({ email, password })
        : await supabase.auth.signUp({ email, password })
    setBusy(false)
    if (error) setMessage(error.message)
    else if (mode === 'signup')
      setMessage('Account created. If email confirmation is on, check your inbox; otherwise sign in.')
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-slate-50">
      <form
        onSubmit={handleSubmit}
        className="w-80 rounded-xl bg-white p-6 shadow space-y-4"
      >
        <div>
          <h1 className="text-2xl font-bold text-slate-800">SegCheck</h1>
          <p className="text-xs text-slate-500">Reviewer sign in</p>
        </div>

        <input
          type="email"
          required
          placeholder="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          className="w-full rounded border border-slate-300 px-3 py-2 text-sm"
        />
        <input
          type="password"
          required
          placeholder="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className="w-full rounded border border-slate-300 px-3 py-2 text-sm"
        />

        <button
          type="submit"
          disabled={busy}
          className="w-full rounded bg-slate-800 py-2 text-sm font-medium text-white disabled:opacity-50"
        >
          {busy ? '…' : mode === 'signin' ? 'Sign in' : 'Create account'}
        </button>

        {message && <p className="text-xs text-rose-600">{message}</p>}

        <button
          type="button"
          onClick={() => setMode(mode === 'signin' ? 'signup' : 'signin')}
          className="w-full text-xs text-slate-500 underline"
        >
          {mode === 'signin'
            ? 'Need an account? Create one'
            : 'Have an account? Sign in'}
        </button>
      </form>
    </div>
  )
}
