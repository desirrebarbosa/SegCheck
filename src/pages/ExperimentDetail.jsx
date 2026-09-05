import { Suspense, lazy, useCallback, useEffect, useRef, useState } from 'react'
import { Link, useNavigate, useOutletContext, useParams } from 'react-router-dom'
import { toPng } from 'html-to-image'
import {
  attachmentUrl,
  getExperiment,
  listModelFamilies,
  removeAttachment,
} from '../lib/experiments'
import {
  PERFORMANCE_FIELDS,
  TASK_LABELS,
  experimentJsonFilename,
  exportExperimentJson,
} from '../lib/experimentImport'
import { defaultChartConfig } from '../lib/runSeries'
import { useToast } from '../components/Toast'
import { useDialog } from '../components/Dialog'

const MetricChart = lazy(() => import('../components/MetricChart'))

// The experiment as a DOCUMENT, not a dashboard.
//
// This is the screen the PDF marks "can be printed as PDF / imported as img",
// so it is laid out as a single printable page: one column at a fixed
// measure, section headings, label/value rows with dotted leaders, and the
// chart as a captioned figure. A grid of stat tiles was the wrong shape for
// that — it reads as a control panel, and prints like one.
export default function ExperimentDetail() {
  const { isOwner } = useOutletContext()
  const { experimentId } = useParams()
  const { showError, showSuccess } = useToast()
  const { confirm } = useDialog()
  const navigate = useNavigate()

  const [experiment, setExperiment] = useState(null) // null = loading
  const [family, setFamily] = useState(null)
  const [urls, setUrls] = useState({}) // attachment id -> signed url
  const [busy, setBusy] = useState(false)
  const pageRef = useRef(null)

  const refresh = useCallback(async () => {
    try {
      const data = await getExperiment(experimentId)
      setExperiment(data)

      // Signed URLs and the model family are fetched after the document is
      // on screen: the bucket is private and the roster is a second query,
      // and neither should be able to cost you the page if it fails.
      const entries = await Promise.all(
        data.attachments.map(async (a) => {
          try {
            return [a.id, await attachmentUrl(a.storage_path)]
          } catch (e) {
            console.error('Signed URL failed:', e)
            return [a.id, null]
          }
        }),
      )
      setUrls(Object.fromEntries(entries))

      try {
        const roster = await listModelFamilies(data.project_id)
        setFamily(roster.find((r) => r.reviewerId === data.added_by)?.modelFamily ?? null)
      } catch (e) {
        console.error('listModelFamilies failed:', e)
      }
    } catch (e) {
      console.error('getExperiment failed:', e)
      showError('Could not load this experiment.')
    }
  }, [experimentId, showError])

  useEffect(() => {
    refresh()
  }, [refresh])

  function handleExport() {
    const runs = experiment.runs
    const doc = exportExperimentJson(
      { ...experiment, added_by_email: experiment.reviewer?.email },
      runs,
      runs.length ? defaultChartConfig(runs) : null,
    )
    const blob = new Blob([JSON.stringify(doc, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = experimentJsonFilename(experiment)
    a.click()
    URL.revokeObjectURL(url)
  }

  async function handleSaveImage() {
    setBusy(true)
    try {
      // Explicit white background: the page is transparent over the app's
      // ground, and a PNG with an alpha background is unreadable pasted into
      // a light document.
      const dataUrl = await toPng(pageRef.current, {
        backgroundColor: '#ffffff',
        pixelRatio: 2,
      })
      const a = document.createElement('a')
      a.href = dataUrl
      a.download = experimentJsonFilename(experiment).replace(/\.json$/, '.png')
      a.click()
    } catch (e) {
      console.error('Save as img failed:', e)
      showError('Could not render the image — ' + e.message)
    } finally {
      setBusy(false)
    }
  }

  async function handleRemoveAttachment(a) {
    if (
      !(await confirm({
        title: `Remove ${a.original_filename}?`,
        message: 'The file is deleted from storage too.',
        confirmLabel: 'Remove',
        tone: 'danger',
      }))
    )
      return
    try {
      await removeAttachment(a)
      await refresh()
      showSuccess('Attachment removed.')
    } catch (e) {
      showError('Could not remove the attachment — ' + e.message)
    }
  }

  if (experiment === null) {
    return <p className="text-sm text-[#888780]">Loading…</p>
  }

  const runs = experiment.runs ?? []
  const author = experiment.reviewer?.display_name || experiment.reviewer?.email
  const meta = [
    experiment.run_date,
    experiment.tasks?.map((t) => TASK_LABELS[t] ?? t).join(' + '),
    family ? `${author} · ${family}` : author,
  ]
    .filter(Boolean)
    .join('  ·  ')

  // Figures are numbered across the whole document, chart first, so the
  // captions read the way they would in a paper.
  let figure = 0

  return (
    <section>
      <Link
        to=".."
        relative="path"
        className="no-print flex items-center gap-1.5 text-xs text-[#888780] hover:text-[#5F5E5A]"
      >
        <i className="ti ti-chevron-left text-sm" aria-hidden="true"></i>
        Experiments
      </Link>

      <article
        ref={pageRef}
        className="print-card mx-auto mt-3 max-w-3xl rounded-xl border border-[#E5E4DF] bg-white px-6 py-8 md:px-12 md:py-10"
      >
        <header className="border-b border-[#E5E4DF] pb-5">
          <div className="flex flex-wrap items-baseline gap-3">
            <h2 className="text-2xl font-medium">
              Experiment {String(experiment.seq).padStart(3, '0')}
            </h2>
            {experiment.archived_at && (
              <span className="rounded-lg bg-[#F1EFE8] px-2 py-0.5 text-xs text-[#5F5E5A]">
                archived
              </span>
            )}
          </div>
          <p className="mt-1 text-base text-[#5F5E5A]">{experiment.title}</p>
          <p className="mt-3 text-xs text-[#888780]">{meta}</p>
        </header>

        <Section title="Architecture">
          <Row label="Color space" value={experiment.color_space} />
          <Row label="Backbone" value={experiment.backbone} />
          <Row label="Neck" value={experiment.neck} />
          <Row label="Head(s)" value={experiment.heads?.join(', ')} />
        </Section>

        <Section title="Performance">
          <div className="gap-x-10 sm:columns-2">
            <Row label="Epochs" value={experiment.epochs} />
            {Object.entries(PERFORMANCE_FIELDS).map(([label, column]) => (
              <Row key={column} label={label} value={experiment[column]} suffix="%" />
            ))}
          </div>
        </Section>

        <Section title="Training curve">
          <figure>
            <Suspense fallback={<p className="text-sm text-[#888780]">Loading chart…</p>}>
              <MetricChart runs={runs} />
            </Suspense>
            {runs.length > 0 && (
              <figcaption className="mt-2 text-xs text-[#888780]">
                Figure {++figure} — per-epoch training log, {runs.length} epoch
                {runs.length === 1 ? '' : 's'} recorded.
              </figcaption>
            )}
          </figure>
        </Section>

        {experiment.notes && (
          <Section title="Notes">
            <p className="whitespace-pre-wrap text-sm leading-relaxed text-[#5F5E5A]">
              {experiment.notes}
            </p>
          </Section>
        )}

        {experiment.attachments?.length > 0 && (
          <Section title="Attachments">
            <div className="flex flex-wrap gap-4">
              {experiment.attachments.map((a) => (
                <figure key={a.id} className="w-52">
                  <div className="overflow-hidden rounded-lg border border-[#E5E4DF]">
                    {isImage(a) && urls[a.id] ? (
                      <img
                        src={urls[a.id]}
                        alt={a.original_filename}
                        className="h-36 w-full bg-[#F1EFE8] object-contain"
                      />
                    ) : (
                      <div className="flex h-36 items-center justify-center bg-[#F1EFE8] text-[#888780]">
                        <i className="ti ti-file text-2xl" aria-hidden="true"></i>
                      </div>
                    )}
                  </div>
                  <figcaption className="mt-1.5 flex items-baseline justify-between gap-1 text-xs text-[#888780]">
                    <a
                      href={urls[a.id] ?? undefined}
                      target="_blank"
                      rel="noreferrer"
                      className="truncate hover:underline"
                      title={a.original_filename}
                    >
                      Figure {++figure} — {a.original_filename}
                    </a>
                    <button
                      onClick={() => handleRemoveAttachment(a)}
                      aria-label={`Remove ${a.original_filename}`}
                      className="no-print flex-shrink-0 hover:text-[#791F1F]"
                    >
                      <i className="ti ti-x text-sm" aria-hidden="true"></i>
                    </button>
                  </figcaption>
                </figure>
              ))}
            </div>
          </Section>
        )}

        <footer className="mt-10 border-t border-[#E5E4DF] pt-3 text-xs text-[#B4B2A9]">
          SegCheck · experiment {String(experiment.seq).padStart(3, '0')} · recorded{' '}
          {experiment.created_at?.slice(0, 10)}
        </footer>
      </article>

      <div className="no-print mx-auto mt-4 flex max-w-3xl flex-wrap justify-end gap-2">
        <button
          onClick={() => navigate('edit')}
          className="rounded-lg bg-[#1a1a1a] px-4 py-2 text-sm font-medium text-white"
        >
          Edit
        </button>
        <button
          onClick={() => window.print()}
          className="flex items-center gap-1.5 rounded-lg border border-[#B4B2A9] px-3.5 py-2 text-sm hover:bg-[#F7F7F5]"
        >
          <i className="ti ti-printer text-base" aria-hidden="true"></i>
          Print
        </button>
        <button
          onClick={handleSaveImage}
          disabled={busy}
          className="flex items-center gap-1.5 rounded-lg border border-[#B4B2A9] px-3.5 py-2 text-sm hover:bg-[#F7F7F5] disabled:opacity-50"
        >
          <i className="ti ti-photo text-base" aria-hidden="true"></i>
          {busy ? 'Rendering…' : 'Save as img'}
        </button>
        <button
          onClick={handleExport}
          className="flex items-center gap-1.5 rounded-lg border border-[#B4B2A9] px-3.5 py-2 text-sm hover:bg-[#F7F7F5]"
        >
          <i className="ti ti-download text-base" aria-hidden="true"></i>
          Export JSON
        </button>
      </div>
      {!isOwner && (
        <p className="no-print mx-auto mt-2 max-w-3xl text-right text-xs text-[#888780]">
          Deleting an experiment is the project owner&rsquo;s call — archive it from the list
          instead.
        </p>
      )}
    </section>
  )
}

function Section({ title, children }) {
  return (
    <section className="mt-8">
      <h3 className="text-xs font-medium uppercase tracking-wider text-[#888780]">{title}</h3>
      <div className="mt-3">{children}</div>
    </section>
  )
}

// A label/value line with a dotted leader between them — the thing that makes
// a printed page read as a document rather than a form dump. break-inside
// keeps a row from splitting across the two columns in Performance.
function Row({ label, value, suffix = '' }) {
  const empty = value == null || value === ''
  return (
    <div className="flex items-baseline gap-2 break-inside-avoid py-1">
      <span className="flex-shrink-0 text-sm text-[#5F5E5A]">{label}</span>
      <span
        className="mb-1 min-w-4 flex-1 border-b border-dotted border-[#E5E4DF]"
        aria-hidden="true"
      />
      <span className={`flex-shrink-0 text-sm ${empty ? 'text-[#B4B2A9]' : 'text-[#1a1a1a]'}`}>
        {empty ? '—' : `${value}${suffix}`}
      </span>
    </div>
  )
}

function isImage(a) {
  return (
    a.content_type?.startsWith('image/') ||
    /\.(png|jpe?g|gif|webp|svg)$/i.test(a.original_filename)
  )
}
