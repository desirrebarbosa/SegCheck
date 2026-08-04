import { useCallback, useEffect, useState } from 'react'
import { useOutletContext } from 'react-router-dom'
import {
  listMembers,
  addMemberByEmail,
  removeMember,
  fetchProjectCategories,
} from '../lib/projects'
import { useToast } from '../components/Toast'

export default function Members() {
  const { projectId, project, isOwner } = useOutletContext()
  const { showError, showSuccess } = useToast()
  const [members, setMembers] = useState(null)
  const [categories, setCategories] = useState([])
  const [email, setEmail] = useState('')
  const [selectedCategories, setSelectedCategories] = useState([])
  const [busy, setBusy] = useState(false)

  const refresh = useCallback(async () => {
    try {
      const [m, cats] = await Promise.all([
        listMembers(projectId),
        fetchProjectCategories(projectId),
      ])
      setMembers(m)
      setCategories(cats)
    } catch (e) {
      console.error('Members refresh failed:', e)
      showError('Could not load members.')
    }
  }, [projectId, showError])

  useEffect(() => {
    refresh()
  }, [refresh])

  function toggleCategory(cat) {
    setSelectedCategories((s) => (s.includes(cat) ? s.filter((c) => c !== cat) : [...s, cat]))
  }

  async function handleAdd(e) {
    e.preventDefault()
    if (!email.trim()) return
    setBusy(true)
    try {
      const assignedCount = await addMemberByEmail(projectId, email, selectedCategories)
      setEmail('')
      setSelectedCategories([])
      await refresh()
      showSuccess(
        assignedCount > 0 ? `Added — ${assignedCount} redo item(s) assigned.` : 'Member added.',
      )
    } catch (e) {
      showError(e.message)
    } finally {
      setBusy(false)
    }
  }

  async function handleRemove(reviewerId, label) {
    if (reviewerId === project?.owner_id) {
      showError('The project owner can\u2019t be removed from the project.')
      return
    }
    if (!confirm(`Remove ${label} from this project?`)) return
    try {
      await removeMember(projectId, reviewerId)
      await refresh()
      showSuccess('Member removed.')
    } catch (e) {
      showError('Could not remove member — ' + e.message)
    }
  }

  return (
    <section className="max-w-xl">
      <h2 className="text-lg font-medium">Members</h2>

      <form onSubmit={handleAdd} className="mt-4 space-y-2">
        <div className="flex gap-2">
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="email@example.com"
            className="flex-1 rounded-lg border border-[#B4B2A9] px-3 py-2 text-sm"
          />
          <button
            type="submit"
            disabled={busy}
            className="rounded-lg bg-[#1a1a1a] px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
          >
            {busy ? 'Adding…' : 'Add'}
          </button>
        </div>

        {categories.length > 0 && (
          <div>
            <p className="mb-1 text-xs text-[#888780]">
              Assign classes (redo/fail masks in these classes route to them automatically)
            </p>
            <div className="flex flex-wrap gap-1.5">
              {categories.map((cat) => (
                <button
                  key={cat}
                  type="button"
                  onClick={() => toggleCategory(cat)}
                  className={`rounded-lg px-2.5 py-1 text-xs ${
                    selectedCategories.includes(cat)
                      ? 'bg-[#E6F1FB] text-[#0C447C]'
                      : 'bg-[#F1EFE8] text-[#5F5E5A]'
                  }`}
                >
                  {cat}
                </button>
              ))}
            </div>
          </div>
        )}
      </form>

      <div className="mt-5 divide-y divide-[#E5E4DF] rounded-xl border border-[#E5E4DF]">
        {members === null && <p className="p-4 text-sm text-[#888780]">Loading…</p>}
        {members?.map((m) => (
          <div key={m.reviewer.id} className="flex items-center justify-between gap-3 px-4 py-2.5">
            <div className="min-w-0">
              <p className="truncate text-sm">{m.reviewer.display_name || m.reviewer.email}</p>
              <p className="truncate text-xs text-[#888780]">{m.reviewer.email}</p>
              {m.assigned_categories.length > 0 && (
                <div className="mt-1 flex flex-wrap items-center gap-1">
                  {m.assigned_categories.map((cat) => (
                    <span
                      key={cat}
                      className="rounded bg-[#F1EFE8] px-1.5 py-0.5 text-[11px] text-[#5F5E5A]"
                    >
                      {cat}
                    </span>
                  ))}
                  {m.redo_count > 0 && (
                    <span className="text-[11px] text-[#791F1F]">{m.redo_count} redo</span>
                  )}
                </div>
              )}
            </div>
            <div className="flex flex-shrink-0 items-center gap-3">
              {m.is_lead && (
                <span className="rounded-lg bg-[#E6F1FB] px-2 py-0.5 text-xs text-[#0C447C]">
                  lead
                </span>
              )}
              {m.reviewer.id === project?.owner_id && (
                <span className="rounded-lg bg-[#F3F1E9] px-2 py-0.5 text-xs text-[#5F5E5A]">
                  owner
                </span>
              )}
              {isOwner && m.reviewer.id !== project?.owner_id && (
                <button
                  onClick={() => handleRemove(m.reviewer.id, m.reviewer.email)}
                  aria-label={`Remove ${m.reviewer.email}`}
                  className="text-[#888780] hover:text-[#791F1F]"
                >
                  <i className="ti ti-x text-base" aria-hidden="true"></i>
                </button>
              )}
            </div>
          </div>
        ))}
      </div>
    </section>
  )
}