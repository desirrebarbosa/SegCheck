import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link, useLocation, useNavigate, useOutletContext } from 'react-router-dom'
import {
  addAttachment,
  archiveExperiment,
  createExperiment,
  deleteExperiment,
  listExperiments,
  listModelFamilies,
  listRuns,
  replaceRuns,
  setModelFamily,
  updateExperiment,
} from '../lib/experiments'
import {
  PERFORMANCE_FIELDS,
  TASKS,
  TASK_LABELS,
  parseExperimentJson,
} from '../lib/experimentImport'
import { supabase } from '../lib/supabaseClient'
import { runSeriesKeys } from '../lib/runSeries'
import { useToast } from '../components/Toast'

// recharts is ~250 kB and only two screens need it, so it is split out of the
// main bundle rather than paid for on every page load.
const MetricChart = lazy(() => import('../components/MetricChart'))

// Column widths for the list. One string, used by both the header and the
// rows, so they cannot drift apart. Below md the grid collapses to one column
// and each cell prints its own label instead.
const GRID =
  'md:grid-cols-[3.5rem_minmax(0,1fr)_6.5rem_11rem_4.5rem_5rem_5rem_5rem_2.5rem]'

export default function Experiments() {
  const { projectId, isLead, isOwner } = useOutletContext()
  const { showError, showSuccess } = useToast()
  const location = useLocation()
  const navigate = useNavigate()

  const [rows, setRows] = useState(null) // null = loading
  const [families, setFamilies] = useState([])
  const [userId, setUserId] = useState(null)
  const [query, setQuery] = useState('')
  const [pill, setPill] = useState('') // '' = All, else a reviewer id
  const [showArchived, setShowArchived] = useState(false)
  const [editing, setEditing] = useState(null) // null | 'new' | experiment row
  const [openMenuId, setOpenMenuId] = useState(null)

  const refresh = useCallback(async () => {
    try {
      const [list, roster] = await Promise.all([
        listExperiments(projectId, { includeArchived: true }),
        listModelFamilies(projectId),
      ])
      setRows(list)
      setFamilies(roster)
    } catch (e) {
      console.error('Experiments refresh failed:', e)
      showError('Could not load experiments.')
    }
  }, [projectId, showError])

  useEffect(() => {
    refresh()
  }, [refresh])

  useEffect(() => {
    supabase.auth.getUser().then(({ data }) => setUserId(data.user?.id ?? null))
  }, [])

  // "Edit" on an experiment's own page navigates back here carrying its id.
  // Consumed once and then cleared off the history entry, so a browser
  // refresh or a Back into this page doesn't silently reopen the form.
  useEffect(() => {
    const editId = location.state?.editId
    if (!editId || !rows) return
    const row = rows.find((r) => r.id === editId)
    if (row) setEditing(row)
    navigate('.', { replace: true, state: null })
  }, [location.state, rows, navigate])

  // Close the row menu on any click that isn't inside it.
  useEffect(() => {
    if (!openMenuId) return
    const close = () => setOpenMenuId(null)
    document.addEventListener('click', close)
    return () => document.removeEventListener('click', close)
  }, [openMenuId])

  const visible = useMemo(() => {
    if (!rows) return null
    const q = query.trim().toLowerCase()
    return rows.filter((r) => {
      if (!showArchived && r.archived_at) return false
      if (pill && r.added_by !== pill) return false
      if (!q) return true
      return [r.title, r.backbone, r.neck, r.color_space, r.notes]
        .filter(Boolean)
        .some((v) => v.toLowerCase().includes(q))
    })
  }, [rows, query, pill, showArchived])

  const archivedCount = rows?.filter((r) => r.archived_at).length ?? 0

  async function handleArchive(row) {
    const on = !row.archived_at
    if (
      on &&
      !confirm(
        `Archive ${row.title}?\n\n` +
          'It leaves the list but nothing is deleted — the run log, the chart and any ' +
          'attachments stay exactly as they are, and "Show archived" brings it back.',
      )
    )
      return
    try {
      await archiveExperiment(row.id, on)
      await refresh()
      showSuccess(on ? 'Experiment archived.' : 'Experiment restored.')
    } catch (e) {
      showError('Could not archive — ' + e.message)
    }
  }

  async function handleDelete(row) {
    if (
      !confirm(
        `Delete ${row.title}?\n\n` +
          'This removes the experiment, its whole run log and every attached file. ' +
          'It cannot be undone — archive it instead if you only want it out of the way.',
      )
    )
      return
    try {
      await deleteExperiment(row.id)
      await refresh()
      showSuccess('Experiment deleted.')
    } catch (e) {
      showError('Could not delete — ' + e.message)
    }
  }

  async function handleRename(reviewerId, current) {
    const next = prompt('Model family for this member (blank to clear):', current ?? '')
    if (next === null) return
    try {
      await setModelFamily(projectId, reviewerId, next)
      await refresh()
      showSuccess('Model family updated.')
    } catch (e) {
      showError(e.message)
    }
  }

  return (
    <section>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-medium">Experiments</h2>
          <p className="mt-1 text-sm text-[#888780]">
            One row per training run — architecture, final metrics and the per-epoch log the
            chart is drawn from. Import a JSON file to fill the form in one go.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <div className="relative">
            <i
              className="ti ti-search pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-base text-[#888780]"
              aria-hidden="true"
            ></i>
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search"
              aria-label="Search experiments"
              className="w-48 rounded-lg border border-[#B4B2A9] py-2 pl-8 pr-3 text-sm"
            />
          </div>
          <button
            onClick={() => setEditing(editing === 'new' ? null : 'new')}
            aria-label="Add experiment"
            className="rounded-lg border border-[#B4B2A9] p-2 hover:bg-[#F7F7F5]"
          >
            <i className="ti ti-plus text-base" aria-hidden="true"></i>
          </button>
        </div>
      </div>

      {/* One model family per member — picking a pill filters on who added it. */}
      <div className="mt-4 flex flex-wrap items-center gap-2">
        <div className="flex items-center gap-1 overflow-x-auto rounded-full border border-[#E5E4DF] bg-white p-1 shadow-sm">
          <Pill active={pill === ''} onClick={() => setPill('')} label="All" />
          {families.map((f) => (
            <Pill
              key={f.reviewerId}
              active={pill === f.reviewerId}
              onClick={() => setPill(f.reviewerId)}
              label={f.label}
              onEdit={isLead ? () => handleRename(f.reviewerId, f.modelFamily) : null}
            />
          ))}
        </div>
        {archivedCount > 0 && (
          <label className="flex items-center gap-1.5 text-xs text-[#5F5E5A]">
            <input
              type="checkbox"
              checked={showArchived}
              onChange={(e) => setShowArchived(e.target.checked)}
            />
            Show archived ({archivedCount})
          </label>
        )}
      </div>

      {editing && (
        <ExperimentForm
          key={editing === 'new' ? 'new' : editing.id}
          projectId={projectId}
          userId={userId}
          members={families}
          experiment={editing === 'new' ? null : editing}
          onCancel={() => setEditing(null)}
          onSaved={async (message) => {
            setEditing(null)
            await refresh()
            showSuccess(message)
          }}
        />
      )}

      <div className="mt-5 divide-y divide-[#E5E4DF] rounded-xl border border-[#E5E4DF]">
        <div
          className={`hidden px-4 py-2 text-xs text-[#888780] md:grid ${GRID} md:items-center md:gap-3`}
        >
          <span>No.</span>
          <span>Title</span>
          <span>Date</span>
          <span>Task</span>
          <span>Epoch</span>
          <span>mAP.50</span>
          <span>mAP</span>
          <span>mIoU</span>
          <span className="sr-only">Actions</span>
        </div>

        {visible === null && <p className="p-4 text-sm text-[#888780]">Loading…</p>}
        {visible?.length === 0 && (
          <p className="p-4 text-sm text-[#888780]">
            {rows.length === 0
              ? 'No experiments yet — press + to add the first one.'
              : 'Nothing matches that search or filter.'}
          </p>
        )}

        {visible?.map((r) => (
          <div
            key={r.id}
            className={`grid grid-cols-1 gap-1 px-4 py-2.5 text-sm md:gap-3 ${GRID} md:items-center ${
              r.archived_at ? 'text-[#888780]' : ''
            }`}
          >
            <Cell label="No.">
              <span className="text-[#888780]">{String(r.seq).padStart(3, '0')}</span>
            </Cell>
            <Cell label="Title">
              <Link
                to={r.id}
                className="truncate font-medium text-[#1a1a1a] hover:underline"
                title={r.title}
              >
                {r.title}
              </Link>
              {r.archived_at && (
                <span className="ml-2 rounded-lg bg-[#F1EFE8] px-2 py-0.5 text-xs text-[#5F5E5A]">
                  archived
                </span>
              )}
            </Cell>
            <Cell label="Date">
              <span className="text-[#5F5E5A]">{r.run_date}</span>
            </Cell>
            <Cell label="Task">
              <span className="truncate text-[#5F5E5A]" title={r.tasks?.map(taskLabel).join(', ')}>
                {r.tasks?.map(taskLabel).join(', ')}
              </span>
            </Cell>
            <Cell label="Epoch">{num(r.epochs)}</Cell>
            <Cell label="mAP.50">{num(r.map_50)}</Cell>
            <Cell label="mAP">{num(r.map_avg)}</Cell>
            <Cell label="mIoU">{num(r.miou)}</Cell>

            <div className="relative flex justify-start md:justify-end">
              <button
                onClick={(e) => {
                  e.stopPropagation()
                  setOpenMenuId(openMenuId === r.id ? null : r.id)
                }}
                aria-label={`Actions for ${r.title}`}
                className="rounded-lg p-1 text-[#888780] hover:bg-[#F7F7F5] hover:text-[#1a1a1a]"
              >
                <i className="ti ti-dots-vertical text-base" aria-hidden="true"></i>
              </button>
              {openMenuId === r.id && (
                <div
                  onClick={(e) => e.stopPropagation()}
                  className="absolute right-0 top-8 z-10 w-40 overflow-hidden rounded-lg border border-[#E5E4DF] bg-white py-1 shadow-sm"
                >
                  <MenuLink to={r.id} icon="ti-eye" label="View" />
                  <MenuItem
                    icon="ti-pencil"
                    label="Edit"
                    onClick={() => {
                      setOpenMenuId(null)
                      setEditing(r)
                    }}
                  />
                  <MenuItem
                    icon={r.archived_at ? 'ti-archive-off' : 'ti-archive'}
                    label={r.archived_at ? 'Restore' : 'Archive'}
                    onClick={() => {
                      setOpenMenuId(null)
                      handleArchive(r)
                    }}
                  />
                  {isOwner && (
                    <MenuItem
                      icon="ti-trash"
                      label="Delete"
                      danger
                      onClick={() => {
                        setOpenMenuId(null)
                        handleDelete(r)
                      }}
                    />
                  )}
                </div>
              )}
            </div>
          </div>
        ))}
      </div>
    </section>
  )
}

// ── Small pieces ──────────────────────────────────────────────────────────

function taskLabel(t) {
  return TASK_LABELS[t] ?? t
}

function num(v) {
  return v == null ? <span className="text-[#B4B2A9]">—</span> : String(v)
}

// On mobile the grid collapses to one column, so each value carries its own
// label; on md+ the header row provides them and this is hidden.
function Cell({ label, children }) {
  return (
    <div className="flex min-w-0 items-baseline gap-1.5">
      <span className="text-xs text-[#888780] md:hidden">{label}</span>
      <span className="min-w-0 truncate">{children}</span>
    </div>
  )
}

function Pill({ active, onClick, label, onEdit }) {
  return (
    <span className="flex flex-shrink-0 items-center">
      <button
        onClick={onClick}
        className={`rounded-full px-3 py-1 text-sm ${
          active ? 'bg-[#E6F1FB] text-[#0C447C]' : 'text-[#5F5E5A] hover:bg-[#F7F7F5]'
        }`}
      >
        {label}
      </button>
      {onEdit && (
        <button
          onClick={onEdit}
          aria-label={`Rename ${label}`}
          className="mr-1 rounded-full p-1 text-[#B4B2A9] hover:text-[#5F5E5A]"
        >
          <i className="ti ti-pencil text-xs" aria-hidden="true"></i>
        </button>
      )}
    </span>
  )
}

const MENU_ITEM =
  'flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm hover:bg-[#F7F7F5]'

function MenuItem({ icon, label, onClick, danger }) {
  return (
    <button onClick={onClick} className={`${MENU_ITEM} ${danger ? 'text-[#791F1F]' : ''}`}>
      <i className={`ti ${icon} text-base`} aria-hidden="true"></i>
      {label}
    </button>
  )
}

function MenuLink({ to, icon, label }) {
  return (
    <Link to={to} className={MENU_ITEM}>
      <i className={`ti ${icon} text-base`} aria-hidden="true"></i>
      {label}
    </Link>
  )
}

// ── The add / edit form ───────────────────────────────────────────────────

const BLANK = {
  title: '',
  run_date: todayIso(),
  tasks: [],
  epochs: '',
  added_by: '',
  color_space: '',
  backbone: '',
  neck: '',
  heads: '',
  map_50: '',
  map_75: '',
  map_90: '',
  map_95: '',
  map_avg: '',
  miou: '',
  f1: '',
  notes: '',
}

function toFormState(experiment, userId) {
  if (!experiment) return { ...BLANK, added_by: userId ?? '' }
  const out = { ...BLANK }
  for (const key of Object.keys(BLANK)) {
    const v = experiment[key]
    out[key] = v == null ? '' : v
  }
  out.tasks = experiment.tasks ?? []
  out.heads = (experiment.heads ?? []).join(', ')
  return out
}

function ExperimentForm({ projectId, userId, members, experiment, onCancel, onSaved }) {
  const { showError } = useToast()
  const fileRef = useRef(null)
  const jsonRef = useRef(null)

  const [form, setForm] = useState(() => toFormState(experiment, userId))
  const [runs, setRuns] = useState([])
  const [chart, setChart] = useState(null)
  const [pendingFiles, setPendingFiles] = useState([])
  const [importErrors, setImportErrors] = useState(null)
  const [importWarnings, setImportWarnings] = useState(null)
  const [busy, setBusy] = useState(false)
  const [loadingRuns, setLoadingRuns] = useState(!!experiment)

  // A new form gets added_by as soon as we know who is signed in.
  useEffect(() => {
    if (!experiment && userId) setForm((f) => (f.added_by ? f : { ...f, added_by: userId }))
  }, [experiment, userId])

  // Editing: pull the existing run log in so Save doesn't wipe it.
  useEffect(() => {
    if (!experiment) return
    let alive = true
    listRuns(experiment.id)
      .then((r) => {
        if (!alive) return
        setRuns(r.map((x) => ({ epoch: x.epoch, metrics: x.metrics ?? {} })))
        setLoadingRuns(false)
      })
      .catch((e) => {
        console.error('listRuns failed:', e)
        if (alive) setLoadingRuns(false)
      })
    return () => {
      alive = false
    }
  }, [experiment])

  const set = (key) => (e) => setForm((f) => ({ ...f, [key]: e.target.value }))

  function toggleTask(task) {
    setForm((f) => {
      if (f.tasks.includes(task)) return { ...f, tasks: f.tasks.filter((t) => t !== task) }
      // "can be two but no more than two" — the third click is a no-op rather
      // than a silent swap, so nothing disappears without being asked for.
      if (f.tasks.length >= 2) return f
      return { ...f, tasks: [...f.tasks, task] }
    })
  }

  async function handleImport(e) {
    const file = e.target.files?.[0]
    // Reset so picking the same file again still fires onChange.
    e.target.value = ''
    if (!file) return
    setImportErrors(null)
    setImportWarnings(null)

    const result = parseExperimentJson(await file.text(), {
      members: members.map((m) => ({ id: m.reviewerId, email: m.email, display_name: m.displayName })),
      defaultAddedBy: userId,
    })
    if (!result.ok) {
      setImportErrors(result.errors)
      setImportWarnings(result.warnings?.length ? result.warnings : null)
      return
    }
    setForm(toFormState(result.experiment, userId))
    setRuns(result.runs)
    setChart(result.chart)
    setImportWarnings(result.warnings.length ? result.warnings : null)
  }

  async function handleSubmit(e) {
    e.preventDefault()
    if (!form.title.trim()) return showError('Give the experiment a title.')
    if (form.tasks.length === 0) return showError('Pick at least one task.')
    if (!form.added_by) return showError('Pick who this experiment belongs to.')

    setBusy(true)
    try {
      const fields = {
        title: form.title.trim(),
        run_date: form.run_date,
        tasks: form.tasks,
        epochs: toNumber(form.epochs),
        added_by: form.added_by,
        color_space: blankToNull(form.color_space),
        backbone: blankToNull(form.backbone),
        neck: blankToNull(form.neck),
        heads: form.heads
          .split(',')
          .map((h) => h.trim())
          .filter(Boolean),
        map_50: toNumber(form.map_50),
        map_75: toNumber(form.map_75),
        map_90: toNumber(form.map_90),
        map_95: toNumber(form.map_95),
        map_avg: toNumber(form.map_avg),
        miou: toNumber(form.miou),
        f1: toNumber(form.f1),
        notes: blankToNull(form.notes),
      }

      let saved
      if (experiment) {
        saved = await updateExperiment(experiment.id, fields)
        await replaceRuns(experiment.id, projectId, runs)
      } else {
        saved = await createExperiment(projectId, fields, runs)
      }

      // Attachments are uploaded after the row exists, because the storage
      // path is keyed on the experiment id.
      for (const file of pendingFiles) {
        await addAttachment({ experimentId: saved.id, projectId, userId, file })
      }

      onSaved(experiment ? 'Experiment updated.' : `Experiment ${String(saved.seq).padStart(3, '0')} added.`)
    } catch (e) {
      console.error('Save experiment failed:', e)
      showError('Could not save — ' + e.message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <form
      onSubmit={handleSubmit}
      className="mt-5 rounded-xl border border-[#E5E4DF] p-4 md:p-5"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-base font-medium">
          {experiment ? `Edit ${experiment.title}` : 'Add experiment'}
        </h3>
        <button
          type="button"
          onClick={() => jsonRef.current?.click()}
          className="flex items-center gap-1.5 rounded-lg border border-[#B4B2A9] px-3 py-1.5 text-sm hover:bg-[#F7F7F5]"
        >
          <i className="ti ti-file-import text-base" aria-hidden="true"></i>
          Import JSON
        </button>
        <input
          ref={jsonRef}
          type="file"
          accept=".json,application/json"
          className="hidden"
          onChange={handleImport}
        />
      </div>

      {importErrors && (
        <div className="mt-3 rounded-lg bg-[#FCEBEB] p-3 text-xs text-[#791F1F]">
          <p className="font-medium">Nothing was imported — {importErrors.length} problem(s):</p>
          <ul className="mt-1 list-disc pl-4">
            {importErrors.map((m, i) => (
              <li key={i}>{m}</li>
            ))}
          </ul>
        </div>
      )}
      {importWarnings && (
        <div className="mt-3 rounded-lg bg-[#FDF3E7] p-3 text-xs text-[#7A4A12]">
          <p className="font-medium">Imported, with notes:</p>
          <ul className="mt-1 list-disc pl-4">
            {importWarnings.map((m, i) => (
              <li key={i}>{m}</li>
            ))}
          </ul>
        </div>
      )}

      <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Field label="Title">
          <input value={form.title} onChange={set('title')} className={INPUT} required />
        </Field>
        <Field label="Task" hint="One or two." group>
          <div className="flex flex-wrap gap-1.5">
            {TASKS.map((t) => (
              <button
                key={t}
                type="button"
                onClick={() => toggleTask(t)}
                className={`rounded-lg px-2.5 py-1.5 text-xs ${
                  form.tasks.includes(t)
                    ? 'bg-[#E6F1FB] text-[#0C447C]'
                    : 'border border-[#B4B2A9] text-[#5F5E5A] hover:bg-[#F7F7F5]'
                }`}
              >
                {TASK_LABELS[t]}
              </button>
            ))}
          </div>
        </Field>
        <Field label="Epoch" hint="Epochs run in this experiment.">
          <input type="number" min="1" value={form.epochs} onChange={set('epochs')} className={INPUT} />
        </Field>
        <Field label="Date">
          <input type="date" value={form.run_date} onChange={set('run_date')} className={INPUT} />
        </Field>
        <Field label="Added by">
          <select value={form.added_by} onChange={set('added_by')} className={INPUT}>
            <option value="">Select a member…</option>
            {members.map((m) => (
              <option key={m.reviewerId} value={m.reviewerId}>
                {m.label}
                {m.modelFamily ? ` — ${m.displayName || m.email}` : ''}
              </option>
            ))}
          </select>
        </Field>
      </div>

      <h4 className="mt-6 text-sm font-medium">Architecture</h4>
      <div className="mt-2 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Field label="Color space">
          <input value={form.color_space} onChange={set('color_space')} className={INPUT} />
        </Field>
        <Field label="Backbone">
          <input value={form.backbone} onChange={set('backbone')} className={INPUT} />
        </Field>
        <Field label="Neck">
          <input value={form.neck} onChange={set('neck')} className={INPUT} />
        </Field>
        <Field label="Head(s)" hint="Comma-separated.">
          <input value={form.heads} onChange={set('heads')} className={INPUT} />
        </Field>
      </div>

      <h4 className="mt-6 text-sm font-medium">Performance</h4>
      <p className="mt-1 text-xs text-[#888780]">Percent, 0–100.</p>
      <div className="mt-2 grid grid-cols-2 gap-4 sm:grid-cols-4">
        {Object.entries(PERFORMANCE_FIELDS).map(([label, column]) => (
          <Field key={column} label={label}>
            <input
              type="number"
              step="any"
              min="0"
              max="100"
              value={form[column]}
              onChange={set(column)}
              className={INPUT}
            />
          </Field>
        ))}
      </div>

      <h4 className="mt-6 text-sm font-medium">Run log</h4>
      <p className="mt-1 text-xs text-[#888780]">
        One row per epoch. The chart on the experiment&rsquo;s page is drawn from these —
        normally filled by Import JSON, but editable here.
      </p>
      {loadingRuns ? (
        <p className="mt-2 text-sm text-[#888780]">Loading run log…</p>
      ) : (
        <RunLogEditor runs={runs} onChange={setRuns} />
      )}
      <div className="mt-3">
        <Suspense fallback={<p className="text-sm text-[#888780]">Loading chart…</p>}>
          <MetricChart runs={runs} chart={chart} height={240} />
        </Suspense>
      </div>

      <h4 className="mt-6 text-sm font-medium">Attachments</h4>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => fileRef.current?.click()}
          className="flex items-center gap-1.5 rounded-lg border border-[#B4B2A9] px-3.5 py-2 text-sm hover:bg-[#F7F7F5]"
        >
          <i className="ti ti-photo text-base" aria-hidden="true"></i>
          Select files
        </button>
        <input
          ref={fileRef}
          type="file"
          multiple
          className="hidden"
          onChange={(e) => {
            setPendingFiles((p) => [...p, ...Array.from(e.target.files ?? [])])
            e.target.value = ''
          }}
        />
        {pendingFiles.map((f, i) => (
          <span
            key={`${f.name}-${i}`}
            className="flex items-center gap-1.5 rounded-lg bg-[#F1EFE8] px-2 py-1 text-xs text-[#5F5E5A]"
          >
            {f.name}
            <button
              type="button"
              aria-label={`Remove ${f.name}`}
              onClick={() => setPendingFiles((p) => p.filter((_, j) => j !== i))}
              className="text-[#888780] hover:text-[#791F1F]"
            >
              <i className="ti ti-x text-xs" aria-hidden="true"></i>
            </button>
          </span>
        ))}
        {pendingFiles.length === 0 && (
          <span className="text-xs text-[#888780]">
            Uploaded when you press Save. Existing files are managed on the experiment&rsquo;s page.
          </span>
        )}
      </div>

      <Field label="Notes" className="mt-6">
        <textarea rows={3} value={form.notes} onChange={set('notes')} className={INPUT} />
      </Field>

      <div className="mt-6 flex justify-end gap-2">
        <button
          type="button"
          onClick={onCancel}
          className="rounded-lg border border-[#B4B2A9] px-3.5 py-2 text-sm hover:bg-[#F7F7F5]"
        >
          Cancel
        </button>
        <button
          type="submit"
          disabled={busy}
          className="rounded-lg bg-[#1a1a1a] px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
        >
          {busy ? 'Saving…' : 'Save'}
        </button>
      </div>
    </form>
  )
}

const INPUT = 'w-full rounded-lg border border-[#B4B2A9] px-3 py-2 text-sm'

// `group` renders a div instead of a label. A <label> forwards a click to its
// first labelable descendant, and <button> is labelable — so wrapping the
// three Task toggles in a label would make clicking the second or third one
// also fire the first. Anything holding buttons rather than a single input
// has to opt out.
function Field({ label, hint, group, className = '', children }) {
  const Tag = group ? 'div' : 'label'
  return (
    <Tag className={`block ${className}`}>
      <span className="text-sm text-[#5F5E5A]">{label}</span>
      {hint && <span className="ml-1.5 text-xs text-[#888780]">{hint}</span>}
      <div className="mt-1">{children}</div>
    </Tag>
  )
}

// The run log as an editable grid: one row per epoch, one column per metric.
// Columns are the union of every key present, so an imported log keeps its
// own shape rather than being forced into a fixed set.
function RunLogEditor({ runs, onChange }) {
  const [newColumn, setNewColumn] = useState('')
  const columns = runSeriesKeys(runs)

  function setCell(i, key, raw) {
    const next = runs.map((r, j) => {
      if (j !== i) return r
      const metrics = { ...r.metrics }
      if (raw === '') delete metrics[key]
      else metrics[key] = Number(raw)
      return { ...r, metrics }
    })
    onChange(next)
  }

  function setEpoch(i, raw) {
    onChange(runs.map((r, j) => (j === i ? { ...r, epoch: Number(raw) } : r)))
  }

  function addRow() {
    const nextEpoch = runs.length ? Math.max(...runs.map((r) => r.epoch)) + 1 : 1
    onChange([...runs, { epoch: nextEpoch, metrics: {} }])
  }

  function addColumn(e) {
    e.preventDefault()
    const name = newColumn.trim()
    if (!name || columns.includes(name)) return setNewColumn('')
    // A column exists once some row has the key, so seed it on the first row.
    onChange(
      runs.length
        ? runs.map((r, i) => (i === 0 ? { ...r, metrics: { ...r.metrics, [name]: 0 } } : r))
        : [{ epoch: 1, metrics: { [name]: 0 } }],
    )
    setNewColumn('')
  }

  return (
    <div className="mt-2">
      {runs.length > 0 && (
        <div className="max-h-64 overflow-auto rounded-xl border border-[#E5E4DF]">
          <table className="w-full text-sm">
            <thead className="sticky top-0 bg-white text-xs text-[#888780]">
              <tr>
                <th className="px-2 py-1.5 text-left font-normal">epoch</th>
                {columns.map((c) => (
                  <th key={c} className="px-2 py-1.5 text-left font-normal">
                    {c}
                  </th>
                ))}
                <th className="w-8"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[#E5E4DF]">
              {runs.map((r, i) => (
                <tr key={i}>
                  <td className="px-2 py-1">
                    <input
                      type="number"
                      value={r.epoch}
                      onChange={(e) => setEpoch(i, e.target.value)}
                      className="w-16 rounded border border-[#E5E4DF] px-1.5 py-0.5 text-sm"
                    />
                  </td>
                  {columns.map((c) => (
                    <td key={c} className="px-2 py-1">
                      <input
                        type="number"
                        step="any"
                        value={r.metrics[c] ?? ''}
                        onChange={(e) => setCell(i, c, e.target.value)}
                        className="w-20 rounded border border-[#E5E4DF] px-1.5 py-0.5 text-sm"
                      />
                    </td>
                  ))}
                  <td className="px-2 py-1 text-right">
                    <button
                      type="button"
                      aria-label={`Remove epoch ${r.epoch}`}
                      onClick={() => onChange(runs.filter((_, j) => j !== i))}
                      className="text-[#888780] hover:text-[#791F1F]"
                    >
                      <i className="ti ti-x text-sm" aria-hidden="true"></i>
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="mt-2 flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={addRow}
          className="flex items-center gap-1.5 rounded-lg border border-[#B4B2A9] px-3 py-1.5 text-sm hover:bg-[#F7F7F5]"
        >
          <i className="ti ti-plus text-base" aria-hidden="true"></i>
          Add epoch
        </button>
        <input
          value={newColumn}
          onChange={(e) => setNewColumn(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && addColumn(e)}
          placeholder="new metric (e.g. val_loss)"
          className="w-48 rounded-lg border border-[#B4B2A9] px-3 py-1.5 text-sm"
        />
        <button
          type="button"
          onClick={addColumn}
          className="rounded-lg border border-[#B4B2A9] px-3 py-1.5 text-sm hover:bg-[#F7F7F5]"
        >
          Add metric
        </button>
        {runs.length > 0 && (
          <button
            type="button"
            onClick={() => onChange([])}
            className="text-sm text-[#888780] hover:text-[#791F1F]"
          >
            Clear log
          </button>
        )}
      </div>
    </div>
  )
}

function toNumber(v) {
  if (v === '' || v == null) return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

function blankToNull(v) {
  return v?.trim() ? v.trim() : null
}

function todayIso() {
  const d = new Date()
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}
