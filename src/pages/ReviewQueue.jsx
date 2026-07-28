import { useCallback, useEffect, useState } from 'react'
import { useOutletContext } from 'react-router-dom'
import { supabase } from '../lib/supabaseClient'
import MaskOverlay from '../components/MaskOverlay'

// active_masks (a view, see db/bit3_pivot_schema.sql) already restricts to
// each photo's LATEST version, so a stale mask from a superseded version
// never shows up here. Masks with is_missing=true are inserted as status
// 'fail' directly at upload time, so they never reach 'pending' either —
// nothing to look at, so no manual step needed for them.
export default function ReviewQueue() {
  const { projectId } = useOutletContext()
  const [mask, setMask] = useState(undefined) // undefined = loading, null = queue empty
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const [counts, setCounts] = useState(null)

  const loadNext = useCallback(async () => {
    setMask(undefined)
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
    if (error) setError(error.message)
    else setMask(data?.[0] ?? null)
  }, [projectId])

  const loadCounts = useCallback(async () => {
    const { data, error } = await supabase
      .from('active_masks')
      .select('status')
      .eq('project_id', projectId)
    if (error) return
    const c = { pending: 0, pass: 0, fail: 0 }
    for (const row of data) c[row.status] = (c[row.status] ?? 0) + 1
    setCounts(c)
  }, [projectId])

  useEffect(() => {
    loadNext()
    loadCounts()
  }, [loadNext, loadCounts])

  async function decide(status) {
    if (!mask) return
    setBusy(true)
    setError(null)
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
      setError(e.message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <section>
      <div className="flex items-center justify-between">
        <h2 className="text-xl font-semibold">Review Queue</h2>
        {counts && (
          <div className="flex gap-3 text-xs">
            <span className="text-slate-500">{counts.pending} pending</span>
            <span className="text-emerald-600">{counts.pass} pass</span>
            <span className="text-rose-600">{counts.fail} fail</span>
          </div>
        )}
      </div>

      {error && <p className="mt-3 text-sm text-rose-600">{error}</p>}

      {mask === undefined && <p className="mt-6 text-sm text-slate-400">Loading…</p>}

      {mask === null && (
        <p className="mt-6 text-sm text-slate-400">
          Nothing pending — queue is clear. Upload more, or check the Dashboard for the redo
          batch.
        </p>
      )}

      {mask && (
        <div className="mt-6 space-y-4">
          <div className="text-sm text-slate-500">
            {mask.photo_filename}
            {mask.category && <span className="ml-2 text-slate-400">· {mask.category}</span>}
          </div>

          <MaskOverlay
            photoPath={mask.photo_storage_path}
            maskPath={mask.storage_path}
            bbox={mask.bbox}
            segmentation={mask.segmentation}
            isCrowd={mask.is_crowd}
          />

          <div className="flex gap-3">
            <button
              disabled={busy}
              onClick={() => decide('pass')}
              className="rounded bg-emerald-600 px-5 py-2 text-sm font-medium text-white disabled:opacity-50"
            >
              Yes — mask is good
            </button>
            <button
              disabled={busy}
              onClick={() => decide('fail')}
              className="rounded bg-rose-600 px-5 py-2 text-sm font-medium text-white disabled:opacity-50"
            >
              No — needs redo
            </button>
          </div>
        </div>
      )}
    </section>
  )
}