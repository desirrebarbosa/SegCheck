import { useEffect, useState } from 'react'
import { useOutletContext } from 'react-router-dom'
import { supabase } from '../lib/supabaseClient'
import { fetchMyRedoAssignments } from '../lib/projects'
import { getSignedUrl } from '../lib/storage'
import { fetchGuide, isGuideApiConfigured } from '../lib/apiHelper'
import { useToast } from '../components/Toast'

// 3x3 on the widest layout, so a page is always a full grid.
const PAGE_SIZE = 9

export default function MyRedo() {
  const { projectId } = useOutletContext()
  const { showError } = useToast()
  const [items, setItems] = useState(null) // null = loading
  const [page, setPage] = useState(0)

  useEffect(() => {
    let alive = true
    async function load() {
      const {
        data: { user },
      } = await supabase.auth.getUser()
      try {
        const rows = await fetchMyRedoAssignments(projectId, user.id)
        if (alive) {
          setItems(rows)
          setPage(0)
        }
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

  // Paged client-side: fetchMyRedoAssignments already returns the whole
  // (per-reviewer, so bounded) list in one query, and slicing it here keeps
  // page changes instant with no refetch. Worth revisiting only if one
  // person's share ever grows past a few hundred.
  const pageCount = items ? Math.ceil(items.length / PAGE_SIZE) : 0
  const pageItems = items ? items.slice(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE) : []
  const rangeStart = items?.length ? page * PAGE_SIZE + 1 : 0
  const rangeEnd = Math.min((page + 1) * PAGE_SIZE, items?.length ?? 0)

  return (
    <section>
      <h2 className="text-lg font-medium">My Redo</h2>
      <p className="mt-1 text-sm text-[#888780]">
        Failed Masks from QA Review, manually annotate them and upload again.
      </p>

      {!isGuideApiConfigured() && (
        <p className="mt-3 rounded-lg bg-[#F1EFE8] px-3 py-2 text-xs text-[#5F5E5A]">
          We are working on it.
        </p>
      )}

      {items === null && <p className="mt-6 text-sm text-[#888780]">Loading…</p>}
      {items?.length === 0 && (
        <p className="mt-6 text-sm text-[#888780]">Nothing assigned to you right now.</p>
      )}

      {items?.length > 0 && (
        <>
          <p className="mt-4 text-xs text-[#888780]">
            Showing {rangeStart}–{rangeEnd} of {items.length}
          </p>

          <div className="mt-2 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {pageItems.map((item) => (
              <RedoItemCard key={item.id} item={item} />
            ))}
          </div>

          {pageCount > 1 && (
            <div className="mt-5 flex items-center justify-center gap-1">
              <PageButton
                onClick={() => setPage((p) => p - 1)}
                disabled={page === 0}
                label="Previous page"
                icon="ti-chevron-left"
              />
              {Array.from({ length: pageCount }, (_, i) => (
                <button
                  key={i}
                  onClick={() => setPage(i)}
                  aria-label={`Page ${i + 1}`}
                  aria-current={i === page ? 'page' : undefined}
                  className={
                    i === page
                      ? 'h-8 min-w-8 rounded-lg bg-[#1a1a1a] px-2 text-xs font-medium text-white'
                      : 'h-8 min-w-8 rounded-lg border border-[#E5E4DF] px-2 text-xs hover:bg-[#F7F7F5]'
                  }
                >
                  {i + 1}
                </button>
              ))}
              <PageButton
                onClick={() => setPage((p) => p + 1)}
                disabled={page >= pageCount - 1}
                label="Next page"
                icon="ti-chevron-right"
              />
            </div>
          )}
        </>
      )}
    </section>
  )
}

function PageButton({ onClick, disabled, label, icon }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      className="flex h-8 w-8 items-center justify-center rounded-lg border border-[#E5E4DF] text-[#5F5E5A] hover:bg-[#F7F7F5] disabled:cursor-not-allowed disabled:opacity-30"
    >
      <i className={`ti ${icon} text-base`} aria-hidden="true"></i>
    </button>
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