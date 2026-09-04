import { openBatch } from './redoBatches'
import { collectPhotoMaskEntries, downloadZip } from './zipHelpers'
import { renderInstancePreview } from './instanceRender'

function csvField(value) {
  const s = String(value ?? '')
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

// Weighted phases of an export, in order — lets a UI turn the per-phase
// progress below into one 0-100 number for a progress bar. Weights are a
// rough split (network fetches and per-instance rendering dominate;
// zipping a batch of already-small images is comparatively quick), not a
// measured one.
export const EXPORT_PHASES = [
  { key: 'download', label: 'Downloading photos & masks', weight: 0.45 },
  { key: 'render', label: 'Rendering instance previews', weight: 0.45 },
  { key: 'zip', label: 'Compressing zip', weight: 0.1 },
]

export function exportOverallPercent(progress) {
  if (!progress) return 0
  let pct = 0
  for (const phase of EXPORT_PHASES) {
    if (phase.key === progress.phase) {
      const fraction = progress.total ? progress.done / progress.total : 0
      pct += phase.weight * 100 * fraction
      break
    }
    pct += phase.weight * 100
  }
  return Math.min(100, Math.round(pct))
}

export function exportPhaseLabel(progress) {
  return EXPORT_PHASES.find((p) => p.key === progress?.phase)?.label ?? ''
}

// Renders one flattened preview PNG per failed instance (photo + mask +
// bbox baked into a single image) and builds the full redo zip file list:
// the raw photo, the raw mask file, and `previews/<photo>/<instance>.png`.
// The preview is what actually answers "which object in this photo is the
// problem" — a bare same-size mask raster file next to the photo doesn't,
// on its own, show a human where it sits without manually overlaying it.
//
// `onProgress({ phase, done, total })` fires once per row in each of the
// 'download' and 'render' phases — an export over a slow connection or a
// large batch can take a while, and this is what lets a caller show real
// progress instead of a bar that just sits there.
//
// `signal`, if given, cancels the export — checked between rows in both
// phases, and passed down so in-flight downloads abort immediately rather
// than finishing out the batch first.
export async function buildRedoZipFiles(
  rows,
  { membersById = new Map(), projectId = '', batchId = '', split = '' } = {},
  onProgress,
  signal,
) {
  const { files, photoBlobs, maskBlobs } = await collectPhotoMaskEntries(
    rows,
    {},
    (done, total) => {
      onProgress?.({ phase: 'download', done, total })
    },
    signal,
  )

  const manifestRows = []
  for (let i = 0; i < rows.length; i++) {
    signal?.throwIfAborted()
    const r = rows[i]
    const instanceKey = r.manifest_mask_id ?? r.id
    const photoBlob = photoBlobs.get(r.photo_id)
    const maskBlob = maskBlobs.get(r.id) ?? null
    const previewPath = `previews/${r.photo_filename}/${instanceKey}.png`

    // Derive the format from the existing mask's storage path, falling back
    // to 'png' (the most common raster format). Callers that produce COCO
    // JSON corrections should still place a .json file under corrections/.
    const existingExt = r.storage_path ? r.storage_path.split('.').pop().toLowerCase() : ''
    const format = existingExt === 'json' ? 'coco_json' : 'png'

    try {
      const previewBlob = await renderInstancePreview({
        photoBlob,
        maskBlob,
        bbox: r.bbox,
        segmentation: r.segmentation,
      })
      files.push({ path: previewPath, blob: previewBlob })
    } catch (e) {
      console.error(`renderInstancePreview failed for mask ${r.id}:`, e)
    }

    const member = membersById.get(r.assigned_to)
    // The correction_path tells the importer exactly where to look for the
    // corrected file inside the corrections/ folder of the uploaded ZIP.
    const correctionPath = `corrections/${r.id}.${format === 'coco_json' ? 'json' : 'png'}`
    manifestRows.push({
      photo_filename: r.photo_filename,
      instance_id: r.id,
      manifest_mask_id: r.manifest_mask_id ?? '',
      category: r.category ?? '(uncategorized)',
      reason: r.is_missing ? 'missing' : 'rejected',
      bbox: r.bbox ?? [],
      assigned_to_email: member?.email ?? '',
      preview_path: previewPath,
      mask_path: r.storage_path ? `masks/${r.photo_filename}/${r.storage_path.split('/').pop()}` : '',
      // Correction metadata — used by the correction ZIP importer to verify
      // provenance and locate each corrected file inside the upload.
      project_id: projectId,
      batch_id: batchId,
      split,
      correction_path: correctionPath,
      format,
    })

    onProgress?.({ phase: 'render', done: i + 1, total: rows.length })
  }

  return { files, manifestRows }
}

// One row per failed instance: which photo, which object, why it failed,
// where its bbox is, who it's assigned to, and where its files live in the
// zip. Replaces a category-count-only summary — the recipient can map any
// file in the zip back to a specific object without opening SegCheck.
export function buildInstanceManifestCsv(manifestRows) {
  const totalMissing = manifestRows.filter((r) => r.reason === 'missing').length
  const totalRejected = manifestRows.length - totalMissing

  const header = [
    'photo_filename',
    'instance_id',
    'manifest_mask_id',
    'category',
    'reason',
    'bbox_x',
    'bbox_y',
    'bbox_w',
    'bbox_h',
    'assigned_to_email',
    'preview_path',
    'mask_path',
    // Correction metadata — read by the correction ZIP importer.
    'project_id',
    'batch_id',
    'split',
    'correction_path',
    'format',
  ]

  const lines = [
    csvField('This zip contains photos and masks that failed QA review and need re-annotation.'),
    csvField('reason=missing: no mask was ever produced for this object (do it from scratch).'),
    csvField('reason=rejected: a mask existed but a reviewer rejected it (redo/fix it).'),
    csvField('preview_path is a flattened image showing exactly which object is flagged.'),
    csvField('correction_path: place your corrected file at this path inside the corrections/ folder.'),
    '',
    header.map(csvField).join(','),
    ...manifestRows.map((r) => {
      const [x, y, w, h] = r.bbox.length === 4 ? r.bbox : ['', '', '', '']
      return [
        r.photo_filename,
        r.instance_id,
        r.manifest_mask_id,
        r.category,
        r.reason,
        x,
        y,
        w,
        h,
        r.assigned_to_email,
        r.preview_path,
        r.mask_path,
        r.project_id ?? '',
        r.batch_id ?? '',
        r.split ?? '',
        r.correction_path ?? '',
        r.format ?? '',
      ]
        .map(csvField)
        .join(',')
    }),
    '',
    csvField(`TOTAL: ${manifestRows.length} (missing: ${totalMissing}, rejected: ${totalRejected})`),
  ]

  return new Blob([lines.join('\n')], { type: 'text/csv' })
}

// Filters to fail rows, builds photos/masks/previews/manifest.csv, and
// triggers the browser download. The single entry point shared by
// Dashboard's global export, Dashboard's per-member export, and MyRedo's
// self-export — one implementation instead of three copies of the same
// zip-building loop.
export async function exportRedoBatch({
  rows,
  filenamePrefix,
  membersById,
  projectId = '',
  batchId = '',
  split = '',
  onProgress,
  signal,
  // Passing reviewerId (alongside projectId) OPENS a batch over exactly what
  // was exported, locking those masks to that person until they re-upload.
  // Omit it for a read-only export that should not claim the work (an owner
  // pulling a copy to look at, say) — the zip is identical either way.
  reviewerId,
}) {
  const failed = rows.filter((r) => r.status === 'fail')
  const { files, manifestRows } = await buildRedoZipFiles(
    failed,
    { membersById, projectId, batchId, split },
    onProgress,
    signal,
  )
  files.push({ path: 'manifest.csv', blob: buildInstanceManifestCsv(manifestRows) })
  await downloadZip(
    `${filenamePrefix}-redo.zip`,
    files,
    (percent) => {
      onProgress?.({ phase: 'zip', done: percent, total: 100 })
    },
    signal,
  )

  // Only after the download actually succeeds. Opening the batch first would
  // lock the work to someone whose download then failed or was cancelled,
  // and nothing would release it until they submitted a batch they never got.
  if (projectId && reviewerId) {
    await openBatch(
      projectId,
      reviewerId,
      failed.map((r) => r.id),
      { note: `${filenamePrefix}-redo.zip` },
    )
  }
}
