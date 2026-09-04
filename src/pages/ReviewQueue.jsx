import { useCallback, useEffect, useState } from 'react'
import { useOutletContext } from 'react-router-dom'
import { supabase } from '../lib/supabaseClient'
import MaskOverlay from '../components/MaskOverlay'
import { getClassColors, setClassColor, defaultColorFor } from '../lib/classColors'
import {
  fetchMyQueueCounts,
  fetchHelpablePendingCount,
  rebalanceAssignments,
} from '../lib/projects'
import { useToast } from '../components/Toast'
import { selectAll } from '../lib/paging'

// How many pending masks to hold in the local queue at once, and how close
// to the end of it we get before quietly fetching more (so Next never has
// to block on a network round trip in the common case).
const QUEUE_BATCH_SIZE = 25
const REFILL_THRESHOLD = 5

const MASK_COLUMNS = `id, manifest_mask_id, storage_path, category, bbox, segmentation, is_crowd,
         photo_id, photo_filename, photo_storage_path, created_at, reviewed_at`

export default function ReviewQueue() {
  const { projectId } = useOutletContext()
  const { showError, showSuccess } = useToast()
  const [userId, setUserId] = useState(null)
  // 'mine' = only what's assigned to me. 'helping' = everyone else's
  // still-pending work, entered deliberately once my own stack is clear.
  const [mode, setMode] = useState('mine')
  const [helpable, setHelpable] = useState(0)
  const [queue, setQueue] = useState([])
  const [queueIndex, setQueueIndex] = useState(0)
  const [queueLoading, setQueueLoading] = useState(true)
  const [position, setPosition] = useState(null) // { index, total } within the current photo
  const [busy, setBusy] = useState(false)
  const [counts, setCounts] = useState(null)
  const [categories, setCategories] = useState([])
  const [classColors, setClassColors] = useState({})
  const [colorPanelOpen, setColorPanelOpen] = useState(false)

  // Opacity resets every session, per your call — no persistence.
  const [opacities, setOpacities] = useState({ photo: 1, mask: 0.5, polygon: 0.35, bbox: 1 })

  // undefined = still loading the first batch, null = queue genuinely empty
  const mask = queue.length > 0 ? queue[queueIndex] : queueLoading ? undefined : null

  useEffect(() => {
    supabase.auth.getUser().then(({ data }) => setUserId(data.user?.id ?? null))
  }, [])

  // The one place the "whose work is this" rule lives, so the initial load
  // and the top-up below can't drift apart. In helping mode we deliberately
  // include unassigned masks as well as other people's: anything that
  // slipped through distribution would otherwise be reviewable by nobody.
  const scopeToMode = useCallback(
    (query) =>
      mode === 'mine'
        ? query.eq('assigned_to', userId)
        : query.or(`assigned_to.neq.${userId},assigned_to.is.null`),
    [mode, userId],
  )

  const loadQueue = useCallback(async () => {
    if (!userId) return // wait for the session before scoping anything
    setQueueLoading(true)
    const { data, error } = await scopeToMode(
      supabase
        .from('active_masks')
        .select(MASK_COLUMNS)
        .eq('project_id', projectId)
        .eq('status', 'pending'),
    )
      // Not-yet-skipped masks (reviewed_at still null) come first by creation
      // order; skipped ones sort after, oldest-skip-first — see decide()'s
      // skip handler below for why reviewed_at gets bumped on skip.
      .order('reviewed_at', { ascending: true, nullsFirst: true })
      .order('created_at', { ascending: true })
      .limit(QUEUE_BATCH_SIZE)
    setQueueLoading(false)
    if (error) {
      console.error('loadQueue failed:', error)
      showError('Could not load the review queue.')
      return
    }
    setQueue(data ?? [])
    setQueueIndex(0)
  }, [projectId, showError, userId, scopeToMode])

  const fetchMore = useCallback(
    async (offset) => {
      if (!userId) return []
      // Range-based rather than a created_at cursor: the two-column sort
      // above can't be paged correctly with a single-column cursor.
      const { data, error } = await scopeToMode(
        supabase
          .from('active_masks')
          .select(MASK_COLUMNS)
          .eq('project_id', projectId)
          .eq('status', 'pending'),
      )
        .order('reviewed_at', { ascending: true, nullsFirst: true })
        .order('created_at', { ascending: true })
        .range(offset, offset + QUEUE_BATCH_SIZE - 1)
      if (error) {
        console.error('fetchMore failed:', error)
        return []
      }
      return data ?? []
    },
    [projectId, userId, scopeToMode],
  )

  // Quietly top up the queue once we're getting close to the end of what's
  // loaded, so Prev/Next feel instant instead of stalling on a fetch.
  useEffect(() => {
    if (queue.length === 0) return
    if (queueIndex < queue.length - REFILL_THRESHOLD) return
    let cancelled = false
    fetchMore(queue.length).then((more) => {
      if (cancelled || more.length === 0) return
      setQueue((q) => {
        const existingIds = new Set(q.map((m) => m.id))
        const fresh = more.filter((m) => !existingIds.has(m.id))
        return fresh.length ? [...q, ...fresh] : q
      })
    })
    return () => {
      cancelled = true
    }
  }, [queueIndex, queue, fetchMore])

  const loadCounts = useCallback(async () => {
    if (!userId) return
    // My own numbers, not the project's — exact counts, no rows fetched.
    try {
      const [mine, helpableCount] = await Promise.all([
        fetchMyQueueCounts(projectId, userId),
        fetchHelpablePendingCount(projectId, userId),
      ])
      setCounts(mine)
      setHelpable(helpableCount)
    } catch (e) {
      console.error('loadCounts failed:', e)
    }

    // Categories stay project-wide: they drive the class-color picker,
    // which is per-project config rather than anyone's personal workload.
    // No categories table, so fetch the column and dedupe client-side.
    // Paged: the distinct list is derived from every mask row, so a read
    // truncated at 1000 drops whole classes out of the color picker.
    try {
      const catData = await selectAll(
        () => supabase.from('active_masks').select('id, category').eq('project_id', projectId),
        { orderBy: 'id' },
      )
      const cats = new Set()
      for (const row of catData) {
        if (row.category) cats.add(row.category)
      }
      setCategories([...cats].sort())
    } catch (e) {
      console.error('category load failed:', e)
    }
  }, [projectId, userId])

  useEffect(() => {
    loadQueue()
    loadCounts()
    getClassColors(projectId)
      .then(setClassColors)
      .catch((e) => console.error('getClassColors failed:', e))
  }, [loadQueue, loadCounts, projectId])

  // "instance X of Y" within the current photo — recomputed whenever the
  // displayed mask changes, whether that's from Prev/Next or a decision.
  useEffect(() => {
    if (!mask) {
      setPosition(null)
      return
    }
    let cancelled = false
    supabase
      .from('active_masks')
      .select('id')
      .eq('photo_id', mask.photo_id)
      .order('created_at', { ascending: true })
      .then(({ data }) => {
        if (cancelled || !data) return
        const idx = data.findIndex((s) => s.id === mask.id)
        setPosition({ index: idx + 1, total: data.length })
      })
    return () => {
      cancelled = true
    }
  }, [mask?.id, mask?.photo_id])

  const canGoPrev = queueIndex > 0
  const canGoNext = queueIndex < queue.length - 1

  function goPrev() {
    setQueueIndex((i) => Math.max(0, i - 1))
  }

  function goNext() {
    setQueueIndex((i) => Math.min(queue.length - 1, i + 1))
  }

  // Persists the skip so it sticks to the back of the line on reload/other
  // devices too, not just for this session. Fire-and-forget: the local
  // skip (goNext) already happened, and a failed bump just means this one
  // mask's position won't persist — not worth blocking the UI over.
  function skipMask(maskId) {
    supabase
      .from('masks')
      .update({ reviewed_at: new Date().toISOString() })
      .eq('id', maskId)
      .eq('status', 'pending')
      .then(({ error }) => {
        if (error) console.error('skipMask failed:', error)
      })
  }

  async function decide(status) {
    if (!mask) return
    setBusy(true)
    try {
      const {
        data: { user },
      } = await supabase.auth.getUser()
      // assigned_to is cleared on the way out: the mask has left this
      // reviewer's stack either way. For a pass that's the end of it; for
      // a fail it drops the mask back into the unassigned redo pool so the
      // rebalance below can hand it to whoever has the least redo work —
      // which is deliberately NOT guaranteed to be the person who just
      // failed it. Leaving assigned_to set would make the reviewer the
      // permanent owner of every mask they rejected and bypass redo
      // distribution entirely.
      // `.eq('status', 'pending')` makes this a no-op if someone else has
      // already decided this mask. "Help others" mode deliberately serves
      // work assigned to other people, so two reviewers landing on the same
      // mask is a normal race, not an edge case — and without the guard the
      // second decision silently overwrote the first, including flipping an
      // already-actioned fail back out of someone's redo pile.
      const { data: updated, error: updErr } = await supabase
        .from('masks')
        .update({
          status,
          reviewed_by: user.id,
          reviewed_at: new Date().toISOString(),
          assigned_to: null,
        })
        .eq('id', mask.id)
        .eq('status', 'pending')
        .select('id')
      if (updErr) throw updErr

      if (updated.length === 0) {
        // Already decided by someone else. Drop it from the local queue so
        // it stops being offered, but write no log row — we did not decide
        // it, and claiming otherwise would corrupt the leaderboard.
        const skipIndex = queueIndex
        const withoutIt = [...queue.slice(0, skipIndex), ...queue.slice(skipIndex + 1)]
        setQueue(withoutIt)
        setQueueIndex(Math.min(skipIndex, Math.max(0, withoutIt.length - 1)))
        showError('Someone else already reviewed that one — skipping it.')
        return
      }
      await supabase.from('review_logs').insert({
        project_id: projectId,
        mask_id: mask.id,
        photo_id: mask.photo_id,
        reviewer_id: user.id,
        action: status === 'pass' ? 'confirm_pass' : 'confirm_fail',
        status_before: 'pending',
        status_after: status,
      })
      // Drop the reviewed mask from the local queue — the item that was
      // next in line slides into this same index, so we stay put rather
      // than jumping the view.
      const decidedIndex = queueIndex
      const nextQueue = [...queue.slice(0, decidedIndex), ...queue.slice(decidedIndex + 1)]
      setQueue(nextQueue)
      setQueueIndex(Math.min(decidedIndex, Math.max(0, nextQueue.length - 1)))

      // Route the mask we just failed to someone for re-annotation. Only
      // the fail path needs this, and only the one now-unassigned row is
      // in play, so it's a cheap call. Non-fatal: the decision itself is
      // already saved, and the next rebalance would pick the mask up
      // anyway — it just wouldn't appear in anyone's My Redo until then.
      if (status === 'fail') {
        try {
          await rebalanceAssignments(projectId, 'fail')
        } catch (e) {
          // Surfaced, not just logged: the decision is saved either way, but
          // the mask is now sitting unassigned in nobody's My Redo while the
          // dashboard still counts it. Silently swallowing that made the gap
          // invisible until someone queried the database directly.
          console.error('rebalanceAssignments after fail failed:', e)
          showError(
            'Saved the fail, but could not hand it out for re-annotation — a lead can press “Distribute unassigned work” on the Members page.',
          )
        }
      }

      await loadCounts()
    } catch (e) {
      console.error('decide failed:', e)
      showError('Could not save that decision — please try again.')
    } finally {
      setBusy(false)
    }
  }

  async function handleColorChange(category, key, value) {
    try {
      const next = await setClassColor(projectId, category, { [key]: value })
      setClassColors(next)
    } catch (e) {
      console.error('setClassColor failed:', e)
      showError('Could not save that color.')
    }
  }

  function colorsFor(category) {
    const assigned = classColors[category]
    const fallback = defaultColorFor(category, categories)
    return { bbox: assigned?.bbox ?? fallback.bbox, polygon: assigned?.polygon ?? fallback.polygon }
  }

  return (
    <div className="flex flex-col gap-4 lg:flex-row">
      <section className="min-w-0 flex-1">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <h2 className="text-lg font-medium">Review</h2>
            {mode === 'helping' && (
              <span className="rounded-lg bg-[#E6F1FB] px-2 py-0.5 text-xs text-[#0C447C]">
                helping others
              </span>
            )}
          </div>
          {counts && (
            <div className="flex gap-3 text-xs">
              <span className="text-[#888780]">{counts.pending} pending</span>
              <span className="text-[#27500A]">{counts.pass} pass</span>
              <span className="text-[#791F1F]">{counts.fail} fail</span>
            </div>
          )}
        </div>
        <p className="mt-0.5 text-xs text-[#888780]">
          {mode === 'mine'
            ? 'Your assigned share of the review queue.'
            : "Other members' remaining work — your own queue is clear."}
        </p>

        {mask === undefined && <p className="mt-6 text-sm text-[#888780]">Loading…</p>}

        {mask === null && mode === 'mine' && (
          <div className="mt-6 space-y-3">
            <p className="text-sm text-[#888780]">
              Your queue is clear — everything assigned to you has been reviewed.
            </p>
            {helpable > 0 ? (
              <>
                <p className="text-sm text-[#5F5E5A]">
                  {helpable} mask(s) still pending across the rest of the team.
                </p>
                <button
                  onClick={() => setMode('helping')}
                  className="flex items-center gap-1.5 rounded-lg bg-[#1a1a1a] px-4 py-2 text-sm font-medium text-white"
                >
                  <i className="ti ti-users text-base" aria-hidden="true"></i>
                  Help other members
                </button>
              </>
            ) : (
              <p className="text-sm text-[#888780]">
                Nothing pending anywhere on this project. Upload more, or check the Dashboard for
                the redo batch.
              </p>
            )}
          </div>
        )}

        {mask === null && mode === 'helping' && (
          <div className="mt-6 space-y-3">
            <p className="text-sm text-[#888780]">
              Nothing left to help with — the whole project's queue is clear.
            </p>
            <button
              onClick={() => setMode('mine')}
              className="rounded-lg border border-[#B4B2A9] px-4 py-2 text-sm hover:bg-[#F7F7F5]"
            >
              Back to my queue
            </button>
          </div>
        )}

        {mask && (
          <div className="mt-4 space-y-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <span className="text-sm font-medium">{mask.photo_filename}</span>
                {mask.category && (
                  <span className="rounded-lg bg-[#F1EFE8] px-2 py-0.5 text-xs text-[#5F5E5A]">
                    {mask.category}
                  </span>
                )}
              </div>
              {position && (
                <span className="text-xs text-[#888780]">
                  instance {position.index} of {position.total}
                </span>
              )}
            </div>

            <MaskOverlay
              photoPath={mask.photo_storage_path}
              maskPath={mask.storage_path}
              bbox={mask.bbox}
              segmentation={mask.segmentation}
              opacities={opacities}
              bboxColor={colorsFor(mask.category).bbox}
              polygonColor={colorsFor(mask.category).polygon}
            />

            <div className="flex items-center justify-center gap-2">
              <div className="flex items-center gap-1 rounded-full border border-[#E5E4DF] bg-white p-1 shadow-sm">
                <button
                  disabled={!canGoPrev}
                  onClick={goPrev}
                  aria-label="Previous unsure image"
                  title="Not sure yet — go back"
                  className="flex h-8 w-8 items-center justify-center rounded-full text-[#5F5E5A] transition hover:bg-[#F1EFE8] disabled:cursor-not-allowed disabled:opacity-30"
                >
                  <i className="ti ti-chevron-left text-base" aria-hidden="true"></i>
                </button>
                <span className="min-w-[3.5rem] px-1 text-center text-xs tabular-nums text-[#888780]">
                  {queueIndex + 1} of {(mode === 'mine' ? counts?.pending : helpable) ?? queue.length}
                </span>
                <button
                  disabled={!canGoNext}
                  onClick={() => {
                    if (mask) skipMask(mask.id)
                    goNext()
                  }}
                  aria-label="Skip to next, come back later"
                  title="Not sure yet — skip for now"
                  className="flex h-8 w-8 items-center justify-center rounded-full text-[#5F5E5A] transition hover:bg-[#F1EFE8] disabled:cursor-not-allowed disabled:opacity-30"
                >
                  <i className="ti ti-chevron-right text-base" aria-hidden="true"></i>
                </button>
              </div>
              <span className="text-xs text-[#888780]">Not sure? Skip and come back to it</span>
            </div>

            {mode === 'helping' && (
              <p className="text-center">
                <button
                  onClick={() => setMode('mine')}
                  className="text-xs text-[#888780] underline hover:text-[#1a1a1a]"
                >
                  Back to my queue
                </button>
              </p>
            )}

            <div className="flex gap-2">
              <button
                disabled={busy}
                onClick={() => decide('fail')}
                className="flex flex-1 items-center justify-center gap-1.5 rounded-lg bg-[#FCEBEB] py-2.5 text-sm font-medium text-[#791F1F] disabled:opacity-50"
              >
                <i className="ti ti-x text-base" aria-hidden="true"></i>
                No, needs redo
              </button>
              <button
                disabled={busy}
                onClick={() => decide('pass')}
                className="flex flex-1 items-center justify-center gap-1.5 rounded-lg bg-[#EAF3DE] py-2.5 text-sm font-medium text-[#27500A] disabled:opacity-50"
              >
                <i className="ti ti-check text-base" aria-hidden="true"></i>
                Yes, looks good
              </button>
            </div>
          </div>
        )}
      </section>

      <aside className="w-full flex-shrink-0 space-y-4 lg:w-52">
        <div>
          <p className="mb-2 text-xs text-[#888780]">Layer opacity</p>
          <div className="space-y-2">
            {(['photo', 'mask', 'polygon', 'bbox']).map((key) => (
              <label key={key} className="block text-xs text-[#5F5E5A] capitalize">
                {key}
                <input
                  type="range"
                  min="0"
                  max="100"
                  value={opacities[key] * 100}
                  onChange={(e) =>
                    setOpacities((o) => ({ ...o, [key]: Number(e.target.value) / 100 }))
                  }
                  className="w-full"
                />
              </label>
            ))}
          </div>
        </div>

        <button
          onClick={() => setColorPanelOpen((v) => !v)}
          className="flex w-full items-center justify-center gap-1.5 rounded-lg border border-[#B4B2A9] py-2 text-sm hover:bg-[#F7F7F5]"
        >
          <i className="ti ti-palette text-base" aria-hidden="true"></i>
          Class colors
        </button>

        {colorPanelOpen && (
          <div className="space-y-2 border-t border-[#E5E4DF] pt-3">
            <p className="text-xs text-[#888780]">Bbox / polygon color</p>
            {categories.length === 0 && (
              <p className="text-xs text-[#888780]">No categories yet.</p>
            )}
            {categories.map((cat) => {
              const c = colorsFor(cat)
              return (
                <div key={cat} className="flex items-center gap-2">
                  <span className="flex-1 truncate text-xs">{cat}</span>
                  <input
                    type="color"
                    value={c.bbox}
                    onChange={(e) => handleColorChange(cat, 'bbox', e.target.value)}
                    className="h-5 w-5 rounded border-none p-0"
                    aria-label={`${cat} bbox color`}
                  />
                  <input
                    type="color"
                    value={c.polygon}
                    onChange={(e) => handleColorChange(cat, 'polygon', e.target.value)}
                    className="h-5 w-5 rounded border-none p-0"
                    aria-label={`${cat} polygon color`}
                  />
                </div>
              )
            })}
          </div>
        )}
      </aside>
    </div>
  )
}