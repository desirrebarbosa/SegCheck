import { useEffect, useRef, useState } from 'react'
import { useOutletContext } from 'react-router-dom'
import { supabase } from '../lib/supabaseClient'
import { fetchMyRedoAssignments, fetchMyCorrectionCount } from '../lib/projects'
import { getSignedUrl } from '../lib/storage'
import { fetchGuide, isGuideApiConfigured } from '../lib/guideApi'
import { exportRedoBatch, exportOverallPercent, exportPhaseLabel } from '../lib/exportRedo'
import { uploadCorrectionZip } from '../lib/correctionUpload'
import { useToast } from '../components/Toast'
import ProgressBar from '../components/ProgressBar'

// Phase labels shown in the upload progress bar.
const UPLOAD_PHASE_LABELS = {
  parse: 'Reading ZIP…',
  checksum: 'Verifying files…',
  upload: 'Uploading corrections…',
  record: 'Recording corrections…',
}

function uploadOverallPercent(progress) {
  if (!progress) return 0
  // Rough weights: parse=5%, checksum=10%, upload=75%, record=10%
  const weights = { parse: 0.05, checksum: 0.1, upload: 0.75, record: 0.1 }
  const w = weights[progress.phase] ?? 0
  const prior = Object.entries(weights)
    .filter(([k]) => {
      const order = ['parse', 'checksum', 'upload', 'record']
      return order.indexOf(k) < order.indexOf(progress.phase)
    })
    .reduce((sum, [, v]) => sum + v, 0)
  const fraction = progress.total ? progress.done / progress.total : 0
  return Math.min(100, Math.round((prior + w * fraction) * 100))
}

export default function MyRedo() {
  const { projectId, project } = useOutletContext()
  const { showError, showSuccess } = useToast()
  const [items, setItems] = useState(null) // null = loading
  const [me, setMe] = useState(null) // { id, email }
  const [correctionCount, setCorrectionCount] = useState(null) // null = loading

  // ── Download state ──────────────────────────────────────────────────────
  const [downloading, setDownloading] = useState(false)
  const [downloadProgress, setDownloadProgress] = useState(null)
  const [downloadController, setDownloadController] = useState(null)

  // ── Upload state ────────────────────────────────────────────────────────
  const [uploading, setUploading] = useState(false)
  const [uploadProgress, setUploadProgress] = useState(null)
  const [uploadController, setUploadController] = useState(null)
  const [preflightErrors, setPreflightErrors] = useState(null) // string[] | null
  const [uploadResult, setUploadResult] = useState(null) // { fixed, duplicate } | null
  const fileInputRef = useRef(null)

  useEffect(() => {
    let alive = true
    async function load() {
      const {
        data: { user },
      } = await supabase.auth.getUser()
      if (alive) setMe(user ? { id: user.id, email: user.email } : null)
      try {
        const rows = await fetchMyRedoAssignments(projectId, user.id)
        if (alive) setItems(rows)
      } catch (e) {
        console.error('fetchMyRedoAssignments failed:', e)
        if (alive) {
          setItems([])
          showError('Could not load your redo assignments.')
        }
      }
      try {
        const count = await fetchMyCorrectionCount(projectId, user.id)
        if (alive) setCorrectionCount(count)
      } catch (e) {
        console.error('fetchMyCorrectionCount failed:', e)
        if (alive) setCorrectionCount(0)
      }
    }
    load()
    return () => {
      alive = false
    }
  }, [projectId, showError])

  // ── Download handler ────────────────────────────────────────────────────
  async function handleDownload() {
    const abortController = new AbortController()
    setDownloadController(abortController)
    setDownloading(true)
    setDownloadProgress(null)
    try {
      const membersById = me ? new Map([[me.id, { email: me.email }]]) : undefined
      await exportRedoBatch({
        rows: items,
        filenamePrefix: `${project?.name ?? 'my'}-redo`,
        membersById,
        projectId,
        onProgress: setDownloadProgress,
        signal: abortController.signal,
      })
      showSuccess('Redo batch downloaded.')
    } catch (e) {
      if (abortController.signal.aborted) {
        showSuccess('Redo batch download cancelled.')
      } else {
        console.error('exportRedoBatch failed:', e)
        showError('Could not build your redo batch.')
      }
    } finally {
      setDownloading(false)
      setDownloadProgress(null)
      setDownloadController(null)
    }
  }

  // ── Upload handler ──────────────────────────────────────────────────────
  function handleUploadClick() {
    setPreflightErrors(null)
    setUploadResult(null)
    fileInputRef.current?.click()
  }

  async function handleFileSelected(e) {
    const file = e.target.files?.[0]
    // Reset the input so selecting the same file again triggers onChange.
    e.target.value = ''
    if (!file || !me?.id) return

    const abortController = new AbortController()
    setUploadController(abortController)
    setUploading(true)
    setUploadProgress(null)
    setPreflightErrors(null)
    setUploadResult(null)

    try {
      const result = await uploadCorrectionZip({
        zipFile: file,
        projectId,
        userId: me.id,
        onProgress: setUploadProgress,
        signal: abortController.signal,
      })

      if (!result.ok) {
        setPreflightErrors(result.errors)
      } else {
        setUploadResult({ fixed: result.fixed, duplicate: result.duplicate })
        // Refresh the redo list so fixed masks disappear, and the count so
        // it reflects what just got submitted.
        const [rows, count] = await Promise.all([
          fetchMyRedoAssignments(projectId, me.id),
          fetchMyCorrectionCount(projectId, me.id),
        ])
        setItems(rows)
        setCorrectionCount(count)
        if (result.fixed > 0) {
          showSuccess(
            `${result.fixed} correction${result.fixed !== 1 ? 's' : ''} submitted successfully.`,
          )
        } else if (result.duplicate > 0) {
          showSuccess('Corrections already recorded — no duplicates created.')
        }
      }
    } catch (e) {
      if (abortController.signal.aborted) {
        showSuccess('Upload cancelled.')
      } else {
        console.error('uploadCorrectionZip failed:', e)
        showError(e.message ?? 'Could not upload your corrections.')
      }
    } finally {
      setUploading(false)
      setUploadProgress(null)
      setUploadController(null)
    }
  }

  const busy = downloading || uploading

  return (
    <section>
      {/* ── Header ── */}
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h2 className="text-lg font-medium">My Redo</h2>
          <p className="mt-1 text-sm text-[#888780]">
            Failed Masks from QA Review, manually annotate them and upload again.
          </p>
          {correctionCount !== null && (
            <p className="mt-1.5 flex items-center gap-1 text-sm text-[#5F5E5A]">
              <i className="ti ti-circle-check-filled text-base text-emerald-600" aria-hidden="true" />
              <span className="font-medium text-[#1a1a1a]">{correctionCount}</span>
              corrected mask{correctionCount !== 1 ? 's' : ''} uploaded
            </p>
          )}
        </div>

        <div className="flex flex-wrap gap-2">
          {/* Download button */}
          <button
            onClick={handleDownload}
            disabled={busy || !items?.length}
            className="flex items-center gap-1.5 rounded-lg border border-[#B4B2A9] px-3.5 py-2 text-sm font-medium disabled:opacity-50"
          >
            <i className="ti ti-package text-base" aria-hidden="true" />
            {downloading ? 'Working…' : `Download my redo batch (${items?.length ?? 0})`}
          </button>

          {/* Upload button */}
          <button
            onClick={handleUploadClick}
            disabled={busy}
            className="flex items-center gap-1.5 rounded-lg bg-[#D85A30] px-3.5 py-2 text-sm font-medium text-white disabled:opacity-50"
          >
            <i className="ti ti-upload text-base" aria-hidden="true" />
            {uploading ? 'Uploading…' : 'Upload corrections'}
          </button>
          {/* Hidden file input — only accepts .zip */}
          <input
            ref={fileInputRef}
            type="file"
            accept=".zip,application/zip"
            className="hidden"
            onChange={handleFileSelected}
          />
        </div>
      </div>

      {/* ── Download progress ── */}
      {downloadProgress && (
        <ProgressBar
          percent={exportOverallPercent(downloadProgress)}
          label={`${exportPhaseLabel(downloadProgress)}…`}
          onCancel={() => downloadController?.abort()}
        />
      )}

      {/* ── Upload progress ── */}
      {uploadProgress && (
        <ProgressBar
          percent={uploadOverallPercent(uploadProgress)}
          label={UPLOAD_PHASE_LABELS[uploadProgress.phase] ?? 'Working…'}
          onCancel={() => uploadController?.abort()}
        />
      )}

      {/* ── Preflight errors ── */}
      {preflightErrors && (
        <div className="mt-4 rounded-xl border border-red-200 bg-red-50 p-4">
          <p className="mb-2 text-sm font-medium text-red-700">
            The ZIP was rejected before any upload started. Fix the following errors and try again:
          </p>
          <ul className="list-inside list-disc space-y-1 text-xs text-red-600">
            {preflightErrors.map((err, i) => (
              <li key={i}>{err}</li>
            ))}
          </ul>
        </div>
      )}

      {/* ── Upload success summary ── */}
      {uploadResult && !preflightErrors && (
        <div className="mt-4 rounded-xl border border-green-200 bg-green-50 p-4 text-sm text-green-800">
          {uploadResult.fixed > 0 && (
            <p>
              ✓ <strong>{uploadResult.fixed}</strong> mask
              {uploadResult.fixed !== 1 ? 's' : ''} corrected and recorded.
            </p>
          )}
          {uploadResult.duplicate > 0 && (
            <p className="mt-1 text-xs text-green-600">
              {uploadResult.duplicate} already recorded (idempotent re-upload).
            </p>
          )}
        </div>
      )}

      {!isGuideApiConfigured() && (
        <p className="mt-3 rounded-lg bg-[#F1EFE8] px-3 py-2 text-xs text-[#5F5E5A]">
          We are working on it.
        </p>
      )}

      {items === null && <p className="mt-6 text-sm text-[#888780]">Loading…</p>}
      {items?.length === 0 && (
        <p className="mt-6 text-sm text-[#888780]">Nothing assigned to you right now.</p>
      )}

      <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2">
        {items?.map((item) => (
          <RedoItemCard key={item.id} item={item} />
        ))}
      </div>
    </section>
  )
}

function RedoItemCard({ item }) {
  const { showError } = useToast()
  const [thumbUrl, setThumbUrl] = useState(null)
  const [guide, setGuide] = useState(null) // { guide_type, image_url }
  const [guideBusy, setGuideBusy] = useState(false)

  useEffect(() => {
    let alive = true
    getSignedUrl(item.photo_storage_path)
      .then((url) => alive && setThumbUrl(url))
      .catch((e) => console.error('getSignedUrl failed:', e))
    return () => {
      alive = false
    }
  }, [item.photo_storage_path])

  async function loadGuide() {
    setGuideBusy(true)
    try {
      const photoUrl = thumbUrl ?? (await getSignedUrl(item.photo_storage_path))
      const maskUrl = item.storage_path ? await getSignedUrl(item.storage_path) : null
      const result = await fetchGuide({
        maskUrl,
        photoUrl,
        bbox: item.bbox,
        category: item.category,
      })
      setGuide(result)
    } catch (e) {
      showError(e.message)
    } finally {
      setGuideBusy(false)
    }
  }

  return (
    <div className="rounded-xl border border-[#E5E4DF] p-3">
      <div className="mb-2 flex items-center justify-between">
        <span className="truncate text-sm font-medium">{item.photo_filename}</span>
        {item.category && (
          <span className="rounded-lg bg-[#F1EFE8] px-2 py-0.5 text-xs text-[#5F5E5A]">
            {item.category}
          </span>
        )}
      </div>

      {thumbUrl ? (
        <img src={thumbUrl} alt="" className="mb-2 h-32 w-full rounded-lg object-cover" />
      ) : (
        <div className="mb-2 h-32 w-full rounded-lg bg-[#F1EFE8]" />
      )}

      {guide ? (
        <div className="space-y-1">
          <p className="text-xs text-[#888780]">
            Guide: <span className="font-medium text-[#1a1a1a]">{guide.guide_type}</span>
          </p>
          <img src={guide.image_url} alt="Annotation guide" className="w-full rounded-lg" />
        </div>
      ) : (
        <button
          onClick={loadGuide}
          disabled={guideBusy || !isGuideApiConfigured()}
          className="w-full rounded-lg border border-[#B4B2A9] py-1.5 text-xs disabled:opacity-40"
        >
          {guideBusy ? 'Loading guide…' : 'Load guide'}
        </button>
      )}
    </div>
  )
}
