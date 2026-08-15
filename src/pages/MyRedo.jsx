import { useEffect, useState } from 'react'
import { useOutletContext } from 'react-router-dom'
import { supabase } from '../lib/supabaseClient'
import { fetchMyRedoAssignments } from '../lib/projects'
import { getSignedUrl } from '../lib/storage'
import { fetchGuide, isGuideApiConfigured } from '../lib/guideApi'
import { exportRedoBatch, exportOverallPercent, exportPhaseLabel } from '../lib/exportRedo'
import { useToast } from '../components/Toast'
import ProgressBar from '../components/ProgressBar'

export default function MyRedo() {
  const { projectId, project } = useOutletContext()
  const { showError, showSuccess } = useToast()
  const [items, setItems] = useState(null) // null = loading
  const [me, setMe] = useState(null) // { id, email }
  const [downloading, setDownloading] = useState(false)
  const [progress, setProgress] = useState(null) // { phase, done, total }

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
    }
    load()
    return () => {
      alive = false
    }
  }, [projectId, showError])

  async function handleDownload() {
    setDownloading(true)
    setProgress(null)
    try {
      const membersById = me ? new Map([[me.id, { email: me.email }]]) : undefined
      await exportRedoBatch({
        rows: items,
        filenamePrefix: `${project?.name ?? 'my'}-redo`,
        membersById,
        onProgress: setProgress,
      })
      showSuccess('Redo batch downloaded.')
    } catch (e) {
      console.error('exportRedoBatch failed:', e)
      showError('Could not build your redo batch.')
    } finally {
      setDownloading(false)
      setProgress(null)
    }
  }

  return (
    <section>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h2 className="text-lg font-medium">My Redo</h2>
          <p className="mt-1 text-sm text-[#888780]">
            Failed Masks from QA Review, manually annotate them and upload again.
          </p>
        </div>
        <button
          onClick={handleDownload}
          disabled={downloading || !items?.length}
          className="flex items-center gap-1.5 rounded-lg bg-[#D85A30] px-3.5 py-2 text-sm font-medium text-white disabled:opacity-50"
        >
          <i className="ti ti-package text-base" aria-hidden="true"></i>
          {downloading ? 'Working…' : `Download my redo batch (${items?.length ?? 0})`}
        </button>
      </div>

      {progress && (
        <ProgressBar
          percent={exportOverallPercent(progress)}
          label={`${exportPhaseLabel(progress)}…`}
        />
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