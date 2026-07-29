import { useCallback, useEffect, useState } from 'react'
import { useOutletContext } from 'react-router-dom'
import { supabase } from '../lib/supabaseClient'
import MaskOverlay from '../components/MaskOverlay'
import { getClassColors, setClassColor, defaultColorFor } from '../lib/classColors'
import { useToast } from '../components/Toast'

export default function ReviewQueue() {
  const { projectId } = useOutletContext()
  const { showError, showSuccess } = useToast()
  const [mask, setMask] = useState(undefined)
  const [position, setPosition] = useState(null) // { index, total } within the current photo
  const [busy, setBusy] = useState(false)
  const [counts, setCounts] = useState(null)
  const [categories, setCategories] = useState([])
  const [classColors, setClassColors] = useState({})
  const [colorPanelOpen, setColorPanelOpen] = useState(false)

  // Opacity resets every session, per your call — no persistence.
  const [opacities, setOpacities] = useState({ photo: 1, mask: 0.5, polygon: 0.35, bbox: 1 })

  const loadNext = useCallback(async () => {
    setMask(undefined)
    setPosition(null)
    const { data, error } = await supabase
      .from('active_masks')
      .select(
        `id, manifest_mask_id, storage_path, category, bbox, segmentation, is_crowd,
         photo_id, photo_filename, photo_storage_path`,
      )
      .eq('project_id', projectId)
      .eq('status', 'pending')
      .order('created_at', { ascending: true })
      .limit(1)
    if (error) {
      console.error('loadNext failed:', error)
      showError('Could not load the review queue.')
      return
    }
    const next = data?.[0] ?? null
    setMask(next)
    if (next) {
      const { data: siblings } = await supabase
        .from('active_masks')
        .select('id')
        .eq('photo_id', next.photo_id)
        .order('created_at', { ascending: true })
      if (siblings) {
        const idx = siblings.findIndex((s) => s.id === next.id)
        setPosition({ index: idx + 1, total: siblings.length })
      }
    }
  }, [projectId, showError])

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
    loadNext()
    loadCounts()
    getClassColors(projectId)
      .then(setClassColors)
      .catch((e) => console.error('getClassColors failed:', e))
  }, [loadNext, loadCounts, projectId])

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
      await Promise.all([loadNext(), loadCounts()])
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