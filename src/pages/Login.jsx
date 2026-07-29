import { useState } from 'react'
import { supabase } from '../lib/supabaseClient'

export default function Login() {
  const [mode, setMode] = useState('signin')
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
      setMessage(
        'Account created. If email confirmation is on, check your inbox; otherwise sign in.',
      )
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-white">
      <form
        onSubmit={handleSubmit}
        className="w-80 space-y-4 rounded-xl border border-[#E5E4DF] p-6"
      >
        <div>
          <h1 className="text-lg font-medium text-[#1a1a1a]">Sign in</h1>
          <p className="text-xs text-[#888780]">SegCheck reviewer access</p>
        </div>

        <input
          type="email"
          required
          placeholder="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          className="w-full rounded-lg border border-[#B4B2A9] px-3 py-2 text-sm"
        />
        <input
          type="password"
          required
          placeholder="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className="w-full rounded-lg border border-[#B4B2A9] px-3 py-2 text-sm"
        />

        <button
          type="submit"
          disabled={busy}
          className="w-full rounded-lg bg-[#1a1a1a] py-2 text-sm font-medium text-white disabled:opacity-50"
        >
          {busy ? '…' : mode === 'signin' ? 'Sign in' : 'Create account'}
        </button>

        {message && <p className="text-xs text-[#791F1F]">{message}</p>}

        <button
          type="button"
          onClick={() => setMode(mode === 'signin' ? 'signup' : 'signin')}
          className="w-full text-xs text-[#888780] underline"
        >
          {mode === 'signin' ? 'Need an account? Create one' : 'Have an account? Sign in'}
        </button>
      </form>
    </div>
  )
}