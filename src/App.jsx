import { useEffect, useState } from 'react'
import { supabase } from './lib/supabaseClient'

// Bit 1 smoke test: prove the React app can reach Supabase.
// It asks the DB for the row count of `reviewers` (created in Bit 2).
export default function App() {
  const [status, setStatus] = useState('checking…')

  useEffect(() => {
    supabase
      .from('reviewers')
      .select('*', { count: 'exact', head: true })
      .then(({ error, count }) => {
        if (error) setStatus(`Connected, but query failed: ${error.message}`)
        else setStatus(`Connected to Supabase ✓  (reviewers rows: ${count})`)
      })
  }, [])

  return (
    <div className="min-h-screen bg-slate-50 text-slate-800 flex flex-col items-center justify-center gap-3">
      <h1 className="text-3xl font-bold">SegCheck</h1>
      <p className="text-sm text-slate-500">
        SAM mask QA against ground-truth bounding boxes
      </p>
      <span className="mt-2 rounded-full bg-white px-4 py-1 text-sm shadow">
        {status}
      </span>
    </div>
  )
}
