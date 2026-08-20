import { useCallback, useEffect, useState } from 'react'
import { useOutletContext } from 'react-router-dom'
import {
  listMembers,
  fetchMemberProgress,
  addMemberByEmail,
  removeMember,
  rebalanceAllAssignments,
} from '../lib/projects'
import { relevelRedo, fetchOpenBatches } from '../lib/redoBatches'
import { useToast } from '../components/Toast'

export default function Members() {
  const { projectId, project, isOwner } = useOutletContext()
  const { showError, showSuccess } = useToast()
  const [members, setMembers] = useState(null)
  const [progress, setProgress] = useState(null) // keyed by reviewer id
  const [openBatches, setOpenBatches] = useState({}) // reviewer id -> open batch
  const [email, setEmail] = useState('')
  const [busy, setBusy] = useState(false)

  // Roster first, numbers second: the roster is one query and the progress
  // counts are several per member, so painting the list immediately and
  // filling the stats in beats holding the whole page on the slower half.
  // A failed progress load leaves the roster usable rather than blanking it.
  const refresh = useCallback(async () => {
    let roster
    try {
      roster = await listMembers(projectId)
      setMembers(roster)
    } catch (e) {
      console.error('Members refresh failed:', e)
      showError('Could not load members.')
      return
    }
    try {
      const [prog, batches] = await Promise.all([
        fetchMemberProgress(
          projectId,
          roster.map((m) => m.reviewer.id),
        ),
        fetchOpenBatches(projectId),
      ])
      setProgress(prog)
      setOpenBatches(batches)
    } catch (e) {
      console.error('fetchMemberProgress failed:', e)
      showError('Could not load member progress.')
    }
  }, [projectId, showError])

  useEffect(() => {
    refresh()
  }, [refresh])

  async function handleAdd(e) {
    e.preventDefault()
    if (!email.trim()) return
    setBusy(true)
    try {
      const assignedCount = await addMemberByEmail(projectId, email)
      setEmail('')
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

  // Distribution normally happens on its own (upload, member added or
  // removed). This is the manual trigger for the case those don't cover:
  // work that predates auto-distribution, or anything left unassigned by
  // a rebalance that failed midway. Safe to press at any time — it only
  // ever hands out unclaimed work, never moves what someone already has.
  async function handleDistribute() {
    setBusy(true)
    try {
      const { assigned } = await rebalanceAllAssignments(projectId)
      await refresh()
      showSuccess(
        assigned > 0
          ? `${assigned} unassigned mask(s) distributed.`
          : 'Nothing to distribute — all work is already assigned.',
      )
    } catch (e) {
      showError('Could not distribute work — ' + e.message)
    } finally {
      setBusy(false)
    }
  }

  // Distinct from "Distribute unassigned work", which only ever hands out
  // masks nobody holds and so can never correct an imbalance that already
  // exists. This RELEASES first — but only work nobody has downloaded, so a
  // batch someone is mid-way through is untouchable. Its owner still takes
  // part in the deal: the batch protects those masks, not their place in the
  // queue, so they are topped up to the same total as everyone else.
  async function handleRelevel() {
    if (
      !confirm(
        'Re-level the redo backlog?\n\n' +
          'Work that has been downloaded stays with whoever has it. Everything ' +
          'else is released and re-split so every member ends up with the same ' +
          'total — including anyone mid-batch, who is topped up to match.',
      )
    )
      return
    setBusy(true)
    try {
      const { released, dealt, participants, busy: midBatch } = await relevelRedo(projectId)
      await refresh()
      if (dealt === 0) {
        showError('Nothing to re-level — every remaining mask is inside a downloaded batch.')
      } else {
        showSuccess(
          `Re-levelled: ${released} released, ${dealt} split across ${participants} member(s).` +
            (midBatch > 0 ? ` ${midBatch} mid-batch, topped up to match.` : ''),
        )
      }
    } catch (e) {
      showError('Could not re-level the redo backlog — ' + e.message)
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
      const { assigned } = await removeMember(projectId, reviewerId)
      await refresh()
      showSuccess(
        assigned > 0
          ? `Member removed — ${assigned} redo item(s) redistributed.`
          : 'Member removed.',
      )
    } catch (e) {
      showError('Could not remove member — ' + e.message)
    }
  }

  return (
    <section className="max-w-xl">
      <h2 className="text-lg font-medium">Members</h2>
      <p className="mt-1 text-sm text-[#888780]">
        Review and redo work is split evenly by count across everyone here — no manual
        assignment needed. Each member sees only their own share, but everyone&rsquo;s
        progress is visible below.
      </p>

      <form onSubmit={handleAdd} className="mt-4 flex gap-2">
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
      </form>

      {isOwner && (
        <button
          onClick={handleDistribute}
          disabled={busy}
          className="mt-3 flex items-center gap-1.5 rounded-lg border border-[#B4B2A9] px-3.5 py-2 text-sm hover:bg-[#F7F7F5] disabled:opacity-50"
        >
          <i className="ti ti-arrows-split-2 text-base" aria-hidden="true"></i>
          Distribute unassigned work
        </button>
      )}

      {isOwner && (
        <button
          onClick={handleRelevel}
          disabled={busy}
          className="mt-2 flex items-center gap-1.5 rounded-lg border border-[#B4B2A9] px-3.5 py-2 text-sm hover:bg-[#F7F7F5] disabled:opacity-50"
        >
          <i className="ti ti-scale text-base" aria-hidden="true"></i>
          Re-level redo backlog
        </button>
      )}

      <div className="mt-5 divide-y divide-[#E5E4DF] rounded-xl border border-[#E5E4DF]">
        {members === null && <p className="p-4 text-sm text-[#888780]">Loading…</p>}
        {members?.map((m) => (
          <div key={m.reviewer.id} className="flex items-start justify-between gap-3 px-4 py-2.5">
            <div className="min-w-0">
              <p className="truncate text-sm">{m.reviewer.display_name || m.reviewer.email}</p>
              <p className="truncate text-xs text-[#888780]">{m.reviewer.email}</p>
              <MemberProgress p={progress?.[m.reviewer.id]} loading={progress === null} />
              {openBatches[m.reviewer.id] && (
                <p className="mt-1 inline-flex items-center gap-1.5 rounded-lg bg-[#FDF3E7] px-2 py-0.5 text-xs text-[#7A4A12]">
                  <i className="ti ti-lock text-xs" aria-hidden="true"></i>
                  Batch {openBatches[m.reviewer.id].batchNumber} downloaded —{' '}
                  {openBatches[m.reviewer.id].outstanding} left, protected
                </p>
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

// One member's numbers. Split into "still on their plate" and "already
// done" because they answer different questions — the first is whether to
// give them more work, the second is whether they are actually working.
// Zeroes are rendered rather than hidden: a member with 0 outstanding and
// 0 done needs to look different from one who has cleared their queue, and
// the old "hide when zero" badge made those two identical.
// Outstanding work only — what this member still has on their plate.
//
// Zeroes are rendered rather than hidden: a member who has cleared their
// queue and one who was never given anything need to look different.
function MemberProgress({ p, loading }) {
  if (loading) return <p className="mt-1 text-xs text-[#B4B2A9]">Loading progress…</p>
  if (!p) return null
  return (
    <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
      <Metric value={p.pending} label="to review" />
      <Metric value={p.redo} label="to redo" tone="danger" />
    </div>
  )
}

function Metric({ value, label, tone }) {
  const color =
    tone === 'danger'
      ? 'text-[#791F1F]'
      : tone === 'success'
        ? 'text-[#27500A]'
        : tone === 'strong'
          ? 'text-[#1a1a1a]'
          : 'text-[#5F5E5A]'
  return (
    <span className={color}>
      <span className="font-medium">{value}</span>{' '}
      <span className="text-[#888780]">{label}</span>
    </span>
  )
}
