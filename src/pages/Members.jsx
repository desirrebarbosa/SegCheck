import { useEffect, useState } from 'react'
import { useOutletContext } from 'react-router-dom'
import { listMembers, addMemberByEmail } from '../lib/projects'

// Per-project account roster. Leads can add accounts by email.
export default function Members() {
  const { projectId, isLead } = useOutletContext()
  const [members, setMembers] = useState(null)
  const [email, setEmail] = useState('')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState(null)

  async function refresh() {
    try {
      setMembers(await listMembers(projectId))
    } catch (e) {
      setMsg({ kind: 'err', text: e.message })
    }
  }

  useEffect(() => {
    refresh()
  }, [projectId])

  async function handleAdd(e) {
    e.preventDefault()
    if (!email.trim()) return
    setBusy(true)
    setMsg(null)
    try {
      await addMemberByEmail(projectId, email)
      setEmail('')
      setMsg({ kind: 'ok', text: 'Member added.' })
      await refresh()
    } catch (e) {
      setMsg({ kind: 'err', text: e.message })
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="max-w-xl">
      <h2 className="text-xl font-semibold">Members</h2>

      {isLead ? (
        <form onSubmit={handleAdd} className="mt-4 flex gap-2">
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="account email to add"
            className="flex-1 rounded border border-slate-300 px-3 py-2 text-sm"
          />
          <button
            type="submit"
            disabled={busy}
            className="rounded bg-slate-800 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
          >
            Add
          </button>
        </form>
      ) : (
        <p className="mt-2 text-xs text-slate-400">
          Only a project lead can add members.
        </p>
      )}

      {msg && (
        <p className={`mt-3 text-xs ${msg.kind === 'ok' ? 'text-emerald-600' : 'text-rose-600'}`}>
          {msg.text}
        </p>
      )}

      <ul className="mt-6 divide-y divide-slate-200 rounded-lg border border-slate-200 bg-white">
        {members === null && <li className="px-4 py-3 text-sm text-slate-400">Loading…</li>}
        {members?.map((m) => (
          <li key={m.reviewer.id} className="flex items-center justify-between px-4 py-3">
            <span className="text-sm">{m.reviewer.email ?? m.reviewer.display_name}</span>
            <span className="text-xs text-slate-400">{m.is_lead ? 'lead' : 'reviewer'}</span>
          </li>
        ))}
      </ul>
    </section>
  )
}
