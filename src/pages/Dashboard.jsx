import { useCallback, useEffect, useState } from 'react'
import { useOutletContext } from 'react-router-dom'
import { supabase } from '../lib/supabaseClient'
import { downloadBlob } from '../lib/storage'
import { downloadZip } from '../lib/zipHelpers'
import { useToast } from '../components/Toast'

export default function Dashboard() {
  const { projectId, project } = useOutletContext()
  const { showError, showSuccess } = useToast()
  const [rows, setRows] = useState(null)
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    const { data, error } = await supabase
      .from('active_masks')
      .select(
        `id, status, is_missing, category, storage_path,
         photo_id, photo_filename, photo_storage_path`,
      )
      .eq('project_id', projectId)
    if (error) {
      console.error('Dashboard load failed:', error)
      showError('Could not load dashboard stats.')
    } else {
      setRows(data)
    }
  }, [projectId, showError])

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

  async function exportRedoZip() {
    setBusy(true)
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
      showSuccess('Redo batch downloaded.')
    } catch (e) {
      console.error('exportRedoZip failed:', e)
      showError('Could not build the redo batch.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <section>
      <h2 className="text-lg font-medium">Dashboard</h2>

      {counts && (
        <div className="mt-4 grid grid-cols-3 gap-3 sm:max-w-md">
          <Stat label="Pending" value={counts.pending} />
          <Stat label="Pass" value={counts.pass} tone="success" />
          <Stat label="Fail" value={counts.fail} tone="danger" />
        </div>
      )}

      <div className="mt-5 flex flex-wrap gap-2">
        <button
          onClick={exportCsv}
          className="flex items-center gap-1.5 rounded-lg border border-[#B4B2A9] px-3.5 py-2 text-sm hover:bg-[#F7F7F5]"
        >
          <i className="ti ti-download text-base" aria-hidden="true"></i>
          Export CSV
        </button>
        <button
          onClick={exportRedoZip}
          disabled={busy || !counts?.fail}
          className="flex items-center gap-1.5 rounded-lg bg-[#D85A30] px-3.5 py-2 text-sm font-medium text-white disabled:opacity-50"
        >
          <i className="ti ti-package text-base" aria-hidden="true"></i>
          {busy ? 'Building zip…' : `Download redo batch (${counts?.fail ?? 0})`}
        </button>
      </div>
    </section>
  )
}

function Stat({ label, value, tone }) {
  const styles =
    tone === 'success'
      ? 'bg-[#EAF3DE] text-[#27500A]'
      : tone === 'danger'
        ? 'bg-[#FCEBEB] text-[#791F1F]'
        : 'bg-[#F7F7F5] text-[#1a1a1a]'
  return (
    <div className={`rounded-xl px-3 py-2.5 ${styles}`}>
      <p className="text-xl font-medium">{value ?? '…'}</p>
      <p className="text-xs opacity-70">{label}</p>
    </div>
  )
}