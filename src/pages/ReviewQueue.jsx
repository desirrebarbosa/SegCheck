import { useCallback, useEffect, useState } from 'react'
import { useOutletContext } from 'react-router-dom'
import { supabase } from '../lib/supabaseClient'
import MaskOverlay from '../components/MaskOverlay'
import { getClassColors, setClassColor, defaultColorFor } from '../lib/classColors'
import { useToast } from '../components/Toast'

// How many pending masks to hold in the local queue at once, and how close
// to the end of it we get before quietly fetching more (so Next never has
// to block on a network round trip in the common case).
const QUEUE_BATCH_SIZE = 25
const REFILL_THRESHOLD = 5

const MASK_COLUMNS = `id, manifest_mask_id, storage_path, category, bbox, segmentation, is_crowd,
         photo_id, photo_filename, photo_storage_path, created_at`

export default function ReviewQueue() {
  const { projectId } = useOutletContext()
  const { showError, showSuccess } = useToast()
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

  const loadQueue = useCallback(async () => {
    setQueueLoading(true)
    const { data, error } = await supabase
      .from('active_masks')
      .select(MASK_COLUMNS)
      .eq('project_id', projectId)
      .eq('status', 'pending')
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
  }, [projectId, showError])

  const fetchMore = useCallback(
    async (afterCreatedAt) => {
      const { data, error } = await supabase
        .from('active_masks')
        .select(MASK_COLUMNS)
        .eq('project_id', projectId)
        .eq('status', 'pending')
        .gt('created_at', afterCreatedAt)
        .order('created_at', { ascending: true })
        .limit(QUEUE_BATCH_SIZE)
      if (error) {
        console.error('fetchMore failed:', error)
        return []
      }
      return data ?? []
    },
    [projectId],
  )

  // Quietly top up the queue once we're getting close to the end of what's
  // loaded, so Prev/Next feel instant instead of stalling on a fetch.
  useEffect(() => {
    if (queue.length === 0) return
    if (queueIndex < queue.length - REFILL_THRESHOLD) return
    const last = queue[queue.length - 1]
    let cancelled = false
    fetchMore(last.created_at).then((more) => {
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
    const { data, error } = await supabase
      .from('active_masks')
      .select('status, category')
      .eq('project_id', projectId)
    if (error) return
    const c = { pending: 0, pass: 0, fail: 0 }
    const cats = new Set()
    for (const row of data) {
      c[row.status] = (c[row.status] ?? 0) + 1
      if (row.category) cats.add(row.category)
    }
    setCounts(c)
    setCategories([...cats].sort())
  }, [projectId])

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

  async function decide(status) {
    if (!mask) return
    setBusy(true)
    try {
      const {
        data: { user },
      } = await supabase.auth.getUser()
      const { error: updErr } = await supabase
        .from('masks')
        .update({ status, reviewed_by: user.id, reviewed_at: new Date().toISOString() })
        .eq('id', mask.id)
      if (updErr) throw updErr
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
          <h2 className="text-lg font-medium">Review</h2>
          {counts && (
            <div className="flex gap-3 text-xs">
              <span className="text-[#888780]">{counts.pending} pending</span>
              <span className="text-[#27500A]">{counts.pass} pass</span>
              <span className="text-[#791F1F]">{counts.fail} fail</span>
            </div>
          )}
        </div>

        {mask === undefined && <p className="mt-6 text-sm text-[#888780]">Loading…</p>}
        {mask === null && (
          <p className="mt-6 text-sm text-[#888780]">
            Nothing pending — queue is clear. Upload more, or check the Dashboard for the redo
            batch.
          </p>
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
                  {queueIndex + 1} of {counts?.pending ?? queue.length}
                </span>
                <button
                  disabled={!canGoNext}
                  onClick={goNext}
                  aria-label="Skip to next, come back later"
                  title="Not sure yet — skip for now"
                  className="flex h-8 w-8 items-center justify-center rounded-full text-[#5F5E5A] transition hover:bg-[#F1EFE8] disabled:cursor-not-allowed disabled:opacity-30"
                >
                  <i className="ti ti-chevron-right text-base" aria-hidden="true"></i>
                </button>
              </div>
              <span className="text-xs text-[#888780]">Not sure? Skip and come back to it</span>
            </div>

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