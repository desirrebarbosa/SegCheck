import { useCallback, useEffect, useState } from 'react'
import { useOutletContext } from 'react-router-dom'
import { supabase } from '../lib/supabaseClient'
import { downloadBlob } from '../lib/storage'
import { downloadZip } from '../lib/zipHelpers'

export default function Dashboard() {
  const { projectId, project } = useOutletContext()
  const [rows, setRows] = useState(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)

  const load = useCallback(async () => {
    const { data, error } = await supabase
      .from('active_masks')
      .select(
        `id, status, is_missing, category, storage_path,
         photo_id, photo_filename, photo_storage_path`,
      )
      .eq('project_id', projectId)
    if (error) setError(error.message)
    else setRows(data)
  }, [projectId])

  useEffect(() => {
    load()
  }, [load])

  const counts = rows?.reduce(
    (c, r) => {
      c[r.status] = (c[r.status] ?? 0) + 1
      return c
    },
    { pending: 0, pass: 0, fail: 0 },
  )

  function exportCsv() {
    const header = 'photo_filename,mask_id,category,status,auto_failed_missing\n'
    const body = (rows ?? [])
      .map((r) => [r.photo_filename, r.id, r.category ?? '', r.status, r.is_missing].join(','))
      .join('\n')
    const blob = new Blob([header + body], { type: 'text/csv' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `${project?.name ?? 'segcheck'}-review-log.csv`
    a.click()
    URL.revokeObjectURL(url)
  }

  // Redo bundle: the failed photos + their rejected masks (for reference),
  // per your answer earlier — not just the bare photos.
  async function exportRedoZip() {
    setBusy(true)
    setError(null)
    try {
      const failed = (rows ?? []).filter((r) => r.status === 'fail')
      const files = []
      const seenPhotos = new Set()
      for (const r of failed) {
        if (!seenPhotos.has(r.photo_id)) {
          seenPhotos.add(r.photo_id)
          const photoBlob = await downloadBlob(r.photo_storage_path)
          files.push({ path: `photos/${r.photo_filename}`, blob: photoBlob })
        }
        if (r.storage_path) {
          const maskBlob = await downloadBlob(r.storage_path)
          const maskName = r.storage_path.split('/').pop()
          files.push({ path: `masks/${r.photo_filename}/${maskName}`, blob: maskBlob })
        }
      }
      await downloadZip(`${project?.name ?? 'segcheck'}-redo.zip`, files)
    } catch (e) {
      setError(e.message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <section>
      <h2 className="text-xl font-semibold">Dashboard</h2>

      {error && <p className="mt-3 text-sm text-rose-600">{error}</p>}

      {counts && (
        <div className="mt-4 flex gap-4">
          <Stat label="Pending" value={counts.pending} />
          <Stat label="Pass" value={counts.pass} tone="emerald" />
          <Stat label="Fail" value={counts.fail} tone="rose" />
        </div>
      )}

      <div className="mt-6 flex gap-3">
        <button
          onClick={exportCsv}
          className="rounded border border-slate-300 px-4 py-2 text-sm hover:bg-slate-100"
        >
          Export CSV
        </button>
        <button
          onClick={exportRedoZip}
          disabled={busy || !counts?.fail}
          className="rounded bg-rose-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
        >
          {busy ? 'Building zip…' : `Download redo batch (${counts?.fail ?? 0})`}
        </button>
      </div>
    </section>
  )
}

function Stat({ label, value, tone }) {
  const toneClass =
    tone === 'emerald' ? 'text-emerald-600' : tone === 'rose' ? 'text-rose-600' : 'text-slate-800'
  return (
    <div className="rounded-lg border border-slate-200 bg-white px-4 py-3">
      <div className={`text-2xl font-bold ${toneClass}`}>{value ?? '…'}</div>
      <div className="text-xs text-slate-400">{label}</div>
    </div>
  )
}