import { useCallback, useEffect, useState } from 'react'
import { useOutletContext, useNavigate } from 'react-router-dom'
import { supabase } from '../lib/supabaseClient'
import { downloadBlob, getSignedUrl } from '../lib/storage'
import { downloadZip } from '../lib/zipHelpers'
import { listPhotosForManagement, deletePhotosWithStorage, deleteProject } from '../lib/admin'
import { useToast } from '../components/Toast'

// Count-only queries (head: true) instead of fetching every active_masks
// row just to tally them — cheap regardless of project size. Full rows are
// only fetched on demand, when the person actually clicks export.
async function fetchStatusCounts(projectId) {
  const statuses = ['pending', 'pass', 'fail']
  const counts = {}
  await Promise.all(
    statuses.map(async (status) => {
      const { count, error } = await supabase
        .from('active_masks')
        .select('id', { count: 'exact', head: true })
        .eq('project_id', projectId)
        .eq('status', status)
      if (error) throw error
      counts[status] = count ?? 0
    }),
  )
  return counts
}

async function fetchAllActiveMasks(projectId) {
  const { data, error } = await supabase
    .from('active_masks')
    .select(
      `id, status, is_missing, category, storage_path,
       photo_id, photo_filename, photo_storage_path`,
    )
    .eq('project_id', projectId)
  if (error) throw error
  return data
}

export default function Dashboard() {
  const { projectId, project, isOwner } = useOutletContext()
  const { showError, showSuccess } = useToast()
  const navigate = useNavigate()
  const [counts, setCounts] = useState(null)
  const [busy, setBusy] = useState(false)

  const loadCounts = useCallback(async () => {
    try {
      setCounts(await fetchStatusCounts(projectId))
    } catch (e) {
      console.error('Dashboard loadCounts failed:', e)
      showError('Could not load dashboard stats.')
    }
  }, [projectId, showError])

  useEffect(() => {
    loadCounts()
  }, [loadCounts])

  async function exportCsv() {
    setBusy(true)
    try {
      const rows = await fetchAllActiveMasks(projectId)
      const header = 'photo_filename,mask_id,category,status,auto_failed_missing\n'
      const body = rows
        .map((r) => [r.photo_filename, r.id, r.category ?? '', r.status, r.is_missing].join(','))
        .join('\n')
      const blob = new Blob([header + body], { type: 'text/csv' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `${project?.name ?? 'segcheck'}-review-log.csv`
      a.click()
      URL.revokeObjectURL(url)
    } catch (e) {
      console.error('exportCsv failed:', e)
      showError('Could not export the CSV.')
    } finally {
      setBusy(false)
    }
  }

  async function exportRedoZip() {
    setBusy(true)
    try {
      const rows = await fetchAllActiveMasks(projectId)
      const failed = rows.filter((r) => r.status === 'fail')
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
          disabled={busy}
          className="flex items-center gap-1.5 rounded-lg border border-[#B4B2A9] px-3.5 py-2 text-sm hover:bg-[#F7F7F5] disabled:opacity-50"
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
          {busy ? 'Working…' : `Download redo batch (${counts?.fail ?? 0})`}
        </button>
      </div>

      {isOwner && (
        <>
          <ManagePhotos projectId={projectId} onChanged={loadCounts} />
          <DangerZone
            projectId={projectId}
            projectName={project?.name}
            onDeleted={() => navigate('/')}
          />
        </>
      )}
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

const PAGE_SIZE = 50

// Owner-only. Paginated list (50/page) with thumbnails; "Delete selected"
// removes the DB rows (versions/masks cascade) AND their Storage files
// across every version — plain SQL can't clean up Storage, so this goes
// through the Storage API via lib/admin.js.
function ManagePhotos({ projectId, onChanged }) {
  const { showError, showSuccess } = useToast()
  const [open, setOpen] = useState(false)
  const [page, setPage] = useState(0)
  const [result, setResult] = useState(null) // { photos, total, page, pageSize }
  const [thumbUrls, setThumbUrls] = useState({})
  const [selected, setSelected] = useState(new Set())
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    try {
      const r = await listPhotosForManagement(projectId, { page, pageSize: PAGE_SIZE })
      setResult(r)
      const urls = {}
      await Promise.all(
        r.photos.map(async (p) => {
          if (p.thumbnail_path) {
            try {
              urls[p.photo_id] = await getSignedUrl(p.thumbnail_path)
            } catch {
              /* no preview for this row, not fatal */
            }
          }
        }),
      )
      setThumbUrls(urls)
    } catch (e) {
      console.error('listPhotosForManagement failed:', e)
      showError('Could not load photos.')
    }
  }, [projectId, page, showError])

  useEffect(() => {
    if (open) load()
  }, [open, load])

  function toggle(id) {
    setSelected((s) => {
      const next = new Set(s)
      next.has(id) ? next.delete(id) : next.add(id)
      return next
    })
  }

  async function handleDelete() {
    const chosen = result.photos.filter((p) => selected.has(p.photo_id))
    if (chosen.length === 0) return
    if (
      !confirm(`Delete ${chosen.length} photo(s) and all their masks/files? This can't be undone.`)
    )
      return
    setBusy(true)
    try {
      await deletePhotosWithStorage(projectId, chosen)
      setSelected(new Set())
      await load()
      onChanged?.()
      showSuccess(`Deleted ${chosen.length} photo(s).`)
    } catch (e) {
      console.error('deletePhotosWithStorage failed:', e)
      showError('Could not delete the selected photos.')
    } finally {
      setBusy(false)
    }
  }

  const totalPages = result ? Math.ceil(result.total / PAGE_SIZE) : 1

  return (
    <div className="mt-8 border-t border-[#E5E4DF] pt-4">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1.5 text-sm font-medium text-[#1a1a1a]"
      >
        <i className={`ti ti-chevron-${open ? 'down' : 'right'} text-base`} aria-hidden="true"></i>
        Manage photos
        {result && <span className="text-xs font-normal text-[#888780]">({result.total})</span>}
      </button>

      {open && (
        <div className="mt-3">
          {result === null && <p className="text-sm text-[#888780]">Loading…</p>}
          {result?.photos.length === 0 && <p className="text-sm text-[#888780]">No photos yet.</p>}

          {result && result.photos.length > 0 && (
            <>
              <div className="mb-2 flex items-center justify-between">
                <span className="text-xs text-[#888780]">{selected.size} selected</span>
                <button
                  onClick={handleDelete}
                  disabled={busy || selected.size === 0}
                  className="rounded-lg bg-[#791F1F] px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50"
                >
                  {busy ? 'Deleting…' : 'Delete selected'}
                </button>
              </div>
              <div className="max-h-96 divide-y divide-[#E5E4DF] overflow-y-auto rounded-xl border border-[#E5E4DF]">
                {result.photos.map((p) => (
                  <label
                    key={p.photo_id}
                    className="flex items-center gap-2.5 px-3 py-2 text-sm hover:bg-[#F7F7F5]"
                  >
                    <input
                      type="checkbox"
                      checked={selected.has(p.photo_id)}
                      onChange={() => toggle(p.photo_id)}
                    />
                    {thumbUrls[p.photo_id] ? (
                      <img
                        src={thumbUrls[p.photo_id]}
                        alt=""
                        className="h-8 w-8 rounded object-cover"
                      />
                    ) : (
                      <span className="flex h-8 w-8 items-center justify-center rounded bg-[#F1EFE8] text-[#B4B2A9]">
                        <i className="ti ti-photo text-sm" aria-hidden="true"></i>
                      </span>
                    )}
                    <span className="flex-1 truncate">{p.filename}</span>
                    {p.split && (
                      <span className="rounded bg-[#F1EFE8] px-1.5 py-0.5 text-xs text-[#888780]">
                        {p.split}
                      </span>
                    )}
                    <span className="text-xs text-[#888780]">v{p.latest_version}</span>
                  </label>
                ))}
              </div>

              {totalPages > 1 && (
                <div className="mt-2 flex items-center justify-between text-xs text-[#888780]">
                  <button
                    onClick={() => setPage((p) => Math.max(0, p - 1))}
                    disabled={page === 0}
                    className="rounded-lg border border-[#B4B2A9] px-2.5 py-1 disabled:opacity-40"
                  >
                    Prev
                  </button>
                  <span>
                    Page {page + 1} of {totalPages}
                  </span>
                  <button
                    onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))}
                    disabled={page >= totalPages - 1}
                    className="rounded-lg border border-[#B4B2A9] px-2.5 py-1 disabled:opacity-40"
                  >
                    Next
                  </button>
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  )
}

// Owner-only. Deletes the project's DB rows (cascade) + every Storage file
// under its path prefix (explicit — Storage isn't cascade-cleaned by the DB).
function DangerZone({ projectId, projectName, onDeleted }) {
  const { showError } = useToast()
  const [busy, setBusy] = useState(false)

  async function handleDelete() {
    if (
      !confirm(
        `Permanently delete "${projectName}" — all photos, masks, review history, and files? This cannot be undone.`,
      )
    )
      return
    setBusy(true)
    try {
      await deleteProject(projectId)
      onDeleted?.()
    } catch (e) {
      console.error('deleteProject failed:', e)
      showError('Could not delete the project.')
      setBusy(false)
    }
  }

  return (
    <div className="mt-6 rounded-xl border border-[#791F1F]/30 bg-[#FCEBEB] p-4">
      <p className="text-sm font-medium text-[#791F1F]">Danger zone</p>
      <p className="mt-1 text-xs text-[#791F1F]/80">
        Deleting this project removes every photo, mask, and file permanently.
      </p>
      <button
        onClick={handleDelete}
        disabled={busy}
        className="mt-2.5 rounded-lg bg-[#791F1F] px-3.5 py-1.5 text-xs font-medium text-white disabled:opacity-50"
      >
        {busy ? 'Deleting…' : 'Delete project'}
      </button>
    </div>
  )
}