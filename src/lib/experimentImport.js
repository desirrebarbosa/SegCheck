// Parses and validates an experiment JSON file (one experiment per file).
//
// The contract lives in segcheck-md/experiment-module.md, and
// segcheck-md/experiment-import-template.json is a filled example of every
// field this accepts. exportExperimentJson() below writes the same shape
// back out, so export -> edit -> import round-trips.
//
// Like preflightCorrectionZip in correctionUpload.js, this COLLECTS every
// problem instead of throwing on the first one. Someone hand-writing a run
// log wants to hear about all four mistakes at once, not to fix one, re-pick
// the file, and be told about the next.

export const TASKS = ['object_detection', 'semantic_segmentation', 'instance_segmentation']

export const TASK_LABELS = {
  object_detection: 'Object Detection',
  semantic_segmentation: 'Semantic Segmentation',
  instance_segmentation: 'Instance Segmentation',
}

// JSON key -> experiments column, for the `performance` block.
export const PERFORMANCE_FIELDS = {
  mAP50: 'map_50',
  mAP75: 'map_75',
  mAP90: 'map_90',
  mAP95: 'map_95',
  mAP: 'map_avg',
  mIoU: 'miou',
  F1: 'f1',
}

const ARCHITECTURE_FIELDS = ['color_space', 'backbone', 'neck', 'heads']

const TOP_LEVEL_KEYS = [
  'schema',
  'title',
  'date',
  'tasks',
  'epochs',
  'added_by',
  'notes',
  'architecture',
  'metric_scale',
  'performance',
  'chart',
  'runs',
]

// "Object Detection", "object-detection", "objectDetection" all mean the
// same thing. Rejecting a human spelling of a value we can obviously read
// would just be rude.
function normaliseTask(raw) {
  if (typeof raw !== 'string') return null
  const key = raw.trim().toLowerCase().replace(/[\s-]+/g, '_')
  return TASKS.includes(key) ? key : null
}

function isPlainObject(v) {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

// A member is addressable by email, display name, or uuid — whichever the
// person writing the file has to hand.
function matchMember(raw, members) {
  const needle = String(raw).trim().toLowerCase()
  return (
    members.find((m) => m.id?.toLowerCase() === needle) ??
    members.find((m) => m.email?.toLowerCase() === needle) ??
    members.find((m) => m.display_name?.toLowerCase() === needle) ??
    null
  )
}

// Metrics are stored on ONE scale (percent, 0-100) so nothing downstream has
// to guess. `metric_scale: "unit"` says the file logs 0-1 and gets multiplied
// on the way in. This is declared rather than inferred because a mAP of 0.40
// is genuinely ambiguous — it could be 0.4% or 40%, and picking wrong makes a
// chart that looks fine and says the wrong thing.
function scaleFactor(metricScale) {
  return metricScale === 'unit' ? 100 : 1
}

/**
 * @param {string|object} raw   The file's text, or an already-parsed object.
 * @param {object} opts
 * @param {Array}  opts.members Project roster: [{ id, email, display_name }]
 * @param {string} [opts.defaultAddedBy] Reviewer id used when `added_by` is absent.
 * @returns {{ ok: false, errors: string[] }
 *          |{ ok: true, experiment: object, runs: object[], chart: object|null, warnings: string[] }}
 */
export function parseExperimentJson(raw, { members = [], defaultAddedBy = null } = {}) {
  let doc
  if (typeof raw === 'string') {
    try {
      doc = JSON.parse(raw)
    } catch (e) {
      // A syntax error is the one case worth stopping on: there is no
      // document left to collect further problems from.
      return { ok: false, errors: [`Not valid JSON — ${e.message}`] }
    }
  } else {
    doc = raw
  }

  if (!isPlainObject(doc)) {
    return {
      ok: false,
      errors: ['The file must contain a single JSON object — one experiment per file.'],
    }
  }

  const errors = []
  const warnings = []

  if (doc.schema && doc.schema !== 'segcheck.experiment/v1') {
    warnings.push(
      `Unknown "schema" value ${JSON.stringify(doc.schema)} — read as segcheck.experiment/v1 anyway.`,
    )
  }

  for (const key of Object.keys(doc)) {
    if (!TOP_LEVEL_KEYS.includes(key)) {
      warnings.push(`Ignored unknown top-level key "${key}".`)
    }
  }

  // ── title ──────────────────────────────────────────────────────────────
  const title = typeof doc.title === 'string' ? doc.title.trim() : ''
  if (!title) errors.push('"title" is required and must be a non-empty string.')

  // ── date ───────────────────────────────────────────────────────────────
  let runDate = null
  if (doc.date != null) {
    if (typeof doc.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(doc.date.trim())) {
      runDate = doc.date.trim()
    } else {
      errors.push(`"date" must be YYYY-MM-DD — got ${JSON.stringify(doc.date)}.`)
    }
  }

  // ── tasks ──────────────────────────────────────────────────────────────
  let tasks = []
  if (!Array.isArray(doc.tasks) || doc.tasks.length === 0) {
    errors.push(`"tasks" is required — one or two of: ${TASKS.join(', ')}.`)
  } else if (doc.tasks.length > 2) {
    errors.push(`"tasks" can hold at most two values — got ${doc.tasks.length}.`)
  } else {
    for (const t of doc.tasks) {
      const norm = normaliseTask(t)
      if (!norm) errors.push(`Unknown task ${JSON.stringify(t)} — must be one of: ${TASKS.join(', ')}.`)
      else if (tasks.includes(norm)) warnings.push(`Task "${norm}" listed twice — kept once.`)
      else tasks.push(norm)
    }
  }

  // ── epochs ─────────────────────────────────────────────────────────────
  let epochs = null
  if (doc.epochs != null) {
    if (Number.isInteger(doc.epochs) && doc.epochs > 0) epochs = doc.epochs
    else errors.push(`"epochs" must be a positive whole number — got ${JSON.stringify(doc.epochs)}.`)
  }

  // ── added_by ───────────────────────────────────────────────────────────
  let addedBy = defaultAddedBy
  if (doc.added_by != null) {
    const match = matchMember(doc.added_by, members)
    if (match) {
      addedBy = match.id
    } else {
      const known = members.map((m) => m.email).filter(Boolean)
      errors.push(
        `"added_by" ${JSON.stringify(doc.added_by)} is not a member of this project.` +
          (known.length ? ` Members are: ${known.join(', ')}.` : ''),
      )
    }
  }
  if (!addedBy) errors.push('"added_by" is required — no signed-in user to fall back to.')

  // ── architecture ───────────────────────────────────────────────────────
  const architecture = { color_space: null, backbone: null, neck: null, heads: [] }
  if (doc.architecture != null) {
    if (!isPlainObject(doc.architecture)) {
      errors.push('"architecture" must be an object.')
    } else {
      for (const [key, value] of Object.entries(doc.architecture)) {
        if (!ARCHITECTURE_FIELDS.includes(key)) {
          warnings.push(`Ignored unknown architecture key "${key}".`)
          continue
        }
        if (key === 'heads') {
          // Accept a bare string too — "Head(s)" is one field in the form.
          const list = Array.isArray(value) ? value : [value]
          architecture.heads = list
            .filter((h) => h != null && String(h).trim() !== '')
            .map((h) => String(h).trim())
        } else if (value != null && String(value).trim() !== '') {
          architecture[key] = String(value).trim()
        }
      }
    }
  }

  // ── metric_scale + performance ─────────────────────────────────────────
  let metricScale = 'percent'
  if (doc.metric_scale != null) {
    if (doc.metric_scale === 'percent' || doc.metric_scale === 'unit') {
      metricScale = doc.metric_scale
    } else {
      errors.push(`"metric_scale" must be "percent" or "unit" — got ${JSON.stringify(doc.metric_scale)}.`)
    }
  }
  const factor = scaleFactor(metricScale)
  const max = metricScale === 'unit' ? 1 : 100

  const performance = {}
  if (doc.performance != null) {
    if (!isPlainObject(doc.performance)) {
      errors.push('"performance" must be an object.')
    } else {
      for (const [key, value] of Object.entries(doc.performance)) {
        const column = PERFORMANCE_FIELDS[key]
        if (!column) {
          warnings.push(
            `Ignored unknown performance key "${key}" — accepted: ${Object.keys(PERFORMANCE_FIELDS).join(', ')}.`,
          )
          continue
        }
        if (value == null) continue
        if (typeof value !== 'number' || !Number.isFinite(value)) {
          errors.push(`performance.${key} must be a number — got ${JSON.stringify(value)}.`)
        } else if (value < 0 || value > max) {
          errors.push(
            `performance.${key} is ${value}, outside 0–${max} for metric_scale "${metricScale}".`,
          )
        } else {
          performance[column] = round4(value * factor)
        }
      }
    }
  }

  // ── runs ───────────────────────────────────────────────────────────────
  // The per-epoch log the chart is built from. Optional: an experiment with
  // only final numbers is a perfectly good record, it just has no curve.
  const runs = []
  const seenEpochs = new Set()
  const droppedKeys = new Set()
  if (doc.runs != null) {
    if (!Array.isArray(doc.runs)) {
      errors.push('"runs" must be an array of per-epoch objects.')
    } else {
      doc.runs.forEach((row, i) => {
        const where = `runs[${i}]`
        if (!isPlainObject(row)) {
          errors.push(`${where} must be an object.`)
          return
        }
        if (!Number.isInteger(row.epoch)) {
          errors.push(`${where}.epoch is required and must be a whole number.`)
          return
        }
        if (seenEpochs.has(row.epoch)) {
          errors.push(`${where} repeats epoch ${row.epoch} — each epoch may appear once.`)
          return
        }
        seenEpochs.add(row.epoch)

        const metrics = {}
        for (const [key, value] of Object.entries(row)) {
          if (key === 'epoch') continue
          if (value == null) continue
          if (typeof value === 'number' && Number.isFinite(value)) {
            metrics[key] = value
          } else {
            // A warning, not an error: a stray "note" column in an exported
            // training log should not block the whole import.
            droppedKeys.add(key)
          }
        }
        runs.push({ epoch: row.epoch, metrics })
      })
    }
  }
  if (droppedKeys.size) {
    warnings.push(
      `Dropped non-numeric run column(s): ${[...droppedKeys].join(', ')} — only numbers can be charted.`,
    )
  }
  runs.sort((a, b) => a.epoch - b.epoch)

  // Every numeric key actually present across the log.
  const runKeys = [...new Set(runs.flatMap((r) => Object.keys(r.metrics)))]

  // ── chart ──────────────────────────────────────────────────────────────
  let chart = null
  if (doc.chart != null) {
    if (!isPlainObject(doc.chart)) {
      errors.push('"chart" must be an object.')
    } else {
      if (doc.chart.x != null && doc.chart.x !== 'epoch') {
        warnings.push(`"chart.x" is always "epoch" — ignored ${JSON.stringify(doc.chart.x)}.`)
      }
      chart = { left: readAxis('left'), right: readAxis('right') }
      if (!chart.left.series.length && !chart.right.series.length) chart = null
    }
  }

  function readAxis(side) {
    const axis = doc.chart[side]
    if (axis == null) return { label: '', series: [] }
    if (!isPlainObject(axis)) {
      errors.push(`"chart.${side}" must be an object with "label" and "series".`)
      return { label: '', series: [] }
    }
    const series = []
    const list = Array.isArray(axis.series) ? axis.series : []
    if (axis.series != null && !Array.isArray(axis.series)) {
      errors.push(`"chart.${side}.series" must be an array of run column names.`)
    }
    for (const name of list) {
      if (runKeys.includes(name)) series.push(name)
      else warnings.push(`chart.${side} names "${name}", which no run row has — dropped.`)
    }
    return { label: typeof axis.label === 'string' ? axis.label : '', series }
  }

  if (errors.length) return { ok: false, errors, warnings }

  return {
    ok: true,
    warnings,
    chart,
    runs,
    experiment: {
      title,
      run_date: runDate ?? todayIso(),
      tasks,
      epochs: epochs ?? (runs.length ? Math.max(...runs.map((r) => r.epoch)) : null),
      added_by: addedBy,
      color_space: architecture.color_space,
      backbone: architecture.backbone,
      neck: architecture.neck,
      heads: architecture.heads,
      map_50: performance.map_50 ?? null,
      map_75: performance.map_75 ?? null,
      map_90: performance.map_90 ?? null,
      map_95: performance.map_95 ?? null,
      map_avg: performance.map_avg ?? null,
      miou: performance.miou ?? null,
      f1: performance.f1 ?? null,
      notes: typeof doc.notes === 'string' ? doc.notes.trim() || null : null,
    },
  }
}

// The inverse: an experiment row (+ its runs) back to the import shape, so a
// downloaded file can be edited and fed straight back in.
export function exportExperimentJson(experiment, runs = [], chart = null) {
  const performance = {}
  for (const [key, column] of Object.entries(PERFORMANCE_FIELDS)) {
    if (experiment[column] != null) performance[key] = Number(experiment[column])
  }

  const doc = {
    schema: 'segcheck.experiment/v1',
    title: experiment.title,
    date: experiment.run_date,
    tasks: experiment.tasks ?? [],
    epochs: experiment.epochs ?? undefined,
    added_by: experiment.added_by_email ?? experiment.added_by,
    notes: experiment.notes ?? undefined,
    architecture: {
      color_space: experiment.color_space ?? null,
      backbone: experiment.backbone ?? null,
      neck: experiment.neck ?? null,
      heads: experiment.heads ?? [],
    },
    metric_scale: 'percent',
    performance,
  }

  if (chart && (chart.left?.series?.length || chart.right?.series?.length)) {
    doc.chart = { x: 'epoch', left: chart.left, right: chart.right }
  }
  doc.runs = runs.map((r) => ({ epoch: r.epoch, ...(r.metrics ?? {}) }))

  // Drop the keys we set to undefined above rather than shipping `null`s the
  // importer would then have to special-case.
  return JSON.parse(JSON.stringify(doc))
}

export function experimentJsonFilename(experiment, date = new Date()) {
  const pad = (n) => String(n).padStart(2, '0')
  const stamp = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
  const slug =
    (experiment?.title ?? 'experiment')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '') || 'experiment'
  return `${slug}_${stamp}.json`
}

function round4(n) {
  return Math.round(n * 10000) / 10000
}

function todayIso() {
  const d = new Date()
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}
