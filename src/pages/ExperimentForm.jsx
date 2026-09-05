import { Suspense, lazy, useCallback, useEffect, useRef, useState } from 'react'
import { Link, useNavigate, useOutletContext, useParams } from 'react-router-dom'
import {
  addAttachment,
  createExperiment,
  getExperiment,
  listModelFamilies,
  replaceRuns,
  updateExperiment,
} from '../lib/experiments'
import {
  PERFORMANCE_FIELDS,
  TASKS,
  TASK_LABELS,
  parseExperimentJson,
} from '../lib/experimentImport'
import { runSeriesKeys } from '../lib/runSeries'
import { supabase } from '../lib/supabaseClient'
import { useToast } from '../components/Toast'

const MetricChart = lazy(() => import('../components/MetricChart'))

// Add Experiment / Edit Experiment — a page of its own, as the wireframe
// draws them, still nested under /projects/:projectId/experiments so the
// sidebar stays on Experiments. One component serves both routes; on the
// Add route there is no :experimentId.
export default function ExperimentForm() {
  const { projectId } = useOutletContext()
  const { experimentId } = useParams()
  const { showError, showSuccess } = useToast()
  const navigate = useNavigate()
  const fileRef = useRef(null)
  const jsonRef = useRef(null)

  const editing = !!experimentId

  const [form, setForm] = useState(BLANK)
  const [members, setMembers] = useState([])
  const [userId, setUserId] = useState(null)
  const [runs, setRuns] = useState([])
  const [chart, setChart] = useState(null)
  const [pendingFiles, setPendingFiles] = useState([])
  const [importErrors, setImportErrors] = useState(null)
  const [importWarnings, setImportWarnings] = useState(null)
  const [busy, setBusy] = useState(false)
  const [loading, setLoading] = useState(true)
  const [notFound, setNotFound] = useState(false)

  const backToList = useCallback(() => {
    navigate(editing ? '../..' : '..', { relative: 'path' })
  }, [navigate, editing])

  useEffect(() => {
    supabase.auth.getUser().then(({ data }) => setUserId(data.user?.id ?? null))
  }, [])

  // The roster, and when editing the experiment plus its run log. The run log
  // matters for more than display: Save calls replaceRuns(), which deletes
  // every epoch the submitted list does not mention, so `runs` must be the
  // real log before Save is allowed to fire. That is why one `loading` flag
  // covers the whole page and gates the Save button.
  useEffect(() => {
    let alive = true
    async function load() {
      try {
        const roster = await listModelFamilies(projectId)
        if (!alive) return
        setMembers(roster)

        if (editing) {
          // getExperiment() already returns the run log, so there is no
          // second query for it here.
          const experiment = await getExperiment(experimentId)
          if (!alive) return
          setForm(toFormState(experiment))
          setRuns(experiment.runs.map((r) => ({ epoch: r.epoch, metrics: r.metrics ?? {} })))
        }
      } catch (e) {
        console.error('Experiment form load failed:', e)
        if (!alive) return
        showError(editing ? 'Could not load this experiment.' : 'Could not load the members list.')
        if (editing) setNotFound(true)
      } finally {
        if (alive) setLoading(false)
      }
    }
    load()
    return () => {
      alive = false
    }
  }, [projectId, experimentId, editing, showError])

  // A new experiment defaults to whoever is adding it.
  useEffect(() => {
    if (!editing && userId) setForm((f) => (f.added_by ? f : { ...f, added_by: userId }))
  }, [editing, userId])

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
      members: members.map((m) => ({
        id: m.reviewerId,
        email: m.email,
        display_name: m.displayName,
      })),
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
      if (editing) {
        saved = await updateExperiment(experimentId, fields)
        await replaceRuns(experimentId, projectId, runs)
      } else {
        saved = await createExperiment(projectId, fields, runs)
      }

      // Attachments are uploaded after the row exists, because the storage
      // path is keyed on the experiment id.
      for (const file of pendingFiles) {
        await addAttachment({ experimentId: saved.id, projectId, userId, file })
      }

      showSuccess(
        editing ? 'Experiment updated.' : `Experiment ${String(saved.seq).padStart(3, '0')} added.`,
      )
      backToList()
    } catch (e) {
      console.error('Save experiment failed:', e)
      showError('Could not save — ' + e.message)
    } finally {
      setBusy(false)
    }
  }

  if (notFound) {
    return (
      <section className="mx-auto max-w-4xl">
        <p className="text-sm text-[#888780]">
          That experiment could not be loaded.{' '}
          <Link to="../.." relative="path" className="underline">
            Back to experiments
          </Link>
        </p>
      </section>
    )
  }

  return (
    <section className="mx-auto max-w-4xl">
      {/* inline-flex, not flex: a bare `flex` on an <a> makes it a block that
          spans the container, turning the whole page width into a click
          target. Editing walks up two URL segments (…/:id/edit), adding one. */}
      <Link
        to={editing ? '../..' : '..'}
        relative="path"
        className="inline-flex items-center gap-1.5 rounded-lg border border-[#B4B2A9] px-3.5 py-2 text-sm hover:bg-[#F7F7F5]"
      >
        <i className="ti ti-chevron-left text-base" aria-hidden="true"></i>
        Experiments
      </Link>

      <form onSubmit={handleSubmit} className="mt-5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-lg font-medium">
            {editing ? 'Edit experiment' : 'Add experiment'}
          </h2>
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
        <p className="mt-1 text-sm text-[#888780]">
          Import a JSON file to fill every field at once, or type it in. The chart on the
          experiment&rsquo;s page is drawn from the run log below.
        </p>

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

        <div className="mt-5 grid grid-cols-1 gap-4 sm:grid-cols-2">
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
            <input
              type="number"
              min="1"
              value={form.epochs}
              onChange={set('epochs')}
              className={INPUT}
            />
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
          <Field label="Date">
            <input type="date" value={form.run_date} onChange={set('run_date')} className={INPUT} />
          </Field>
        </div>

        <h3 className="mt-8 text-sm font-medium">Architecture</h3>
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

        {/* Grouped the way the wireframe groups them: the mAP-at-threshold
            family on one row, overall mAP on its own, then the segmentation
            pair. A flat four-up grid loses that reading. */}
        <h3 className="mt-8 text-sm font-medium">Performance</h3>
        <p className="mt-1 text-xs text-[#888780]">Percent, 0–100.</p>
        <div className="mt-2 grid grid-cols-2 gap-4 sm:grid-cols-4">
          <MetricField label="mAP50" form={form} set={set} />
          <MetricField label="mAP75" form={form} set={set} />
          <MetricField label="mAP90" form={form} set={set} />
          <MetricField label="mAP95" form={form} set={set} />
        </div>
        <div className="mt-4 grid grid-cols-2 gap-4 sm:grid-cols-4">
          <MetricField label="mAP" form={form} set={set} />
        </div>
        <div className="mt-4 grid grid-cols-2 gap-4 sm:grid-cols-4">
          <MetricField label="mIoU" form={form} set={set} />
          <MetricField label="F1" form={form} set={set} />
        </div>

        <h3 className="mt-8 text-sm font-medium">Run log</h3>
        <p className="mt-1 text-xs text-[#888780]">
          One row per epoch. Normally filled by Import JSON, but editable here.
        </p>
        {loading ? (
          <p className="mt-2 text-sm text-[#888780]">Loading run log…</p>
        ) : (
          <RunLogEditor runs={runs} onChange={setRuns} />
        )}
        <div className="mt-3">
          <Suspense fallback={<p className="text-sm text-[#888780]">Loading chart…</p>}>
            <MetricChart runs={runs} chart={chart} height={240} />
          </Suspense>
        </div>

        <h3 className="mt-8 text-sm font-medium">Attachments</h3>
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
              Uploaded when you press Save. Existing files are managed on the
              experiment&rsquo;s page.
            </span>
          )}
        </div>

        <Field label="Notes" className="mt-8">
          <textarea rows={3} value={form.notes} onChange={set('notes')} className={INPUT} />
        </Field>

        <div className="mt-8 flex justify-end gap-2">
          <button
            type="button"
            onClick={backToList}
            className="rounded-lg border border-[#B4B2A9] px-3.5 py-2 text-sm hover:bg-[#F7F7F5]"
          >
            Cancel
          </button>
          {/* Disabled while loading, not just while saving: until the run log
              has arrived `runs` is [], and replaceRuns() would read that as
              "delete every epoch" and wipe the chart. */}
          <button
            type="submit"
            disabled={busy || loading}
            className="rounded-lg bg-[#1a1a1a] px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
          >
            {loading ? 'Loading…' : busy ? 'Saving…' : 'Save'}
          </button>
        </div>
      </form>
    </section>
  )
}

// ── Form state ────────────────────────────────────────────────────────────

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

// One performance number. `label` is the JSON key (mAP50, mIoU, …); the
// column it writes to comes from PERFORMANCE_FIELDS, so the form and the
// importer cannot disagree about which field is which.
function MetricField({ label, form, set }) {
  const column = PERFORMANCE_FIELDS[label]
  return (
    <Field label={label}>
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
