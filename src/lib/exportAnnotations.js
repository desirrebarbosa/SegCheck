// Builds a single COCO-style annotations JSON — the same images/annotations/
// categories shape parseManifest() reads back on upload (see manifest.js) —
// containing ONLY masks a reviewer has accepted (`pass`) or a correction has
// replaced (`fixed`), across every assignee. This is the dataset a
// downstream consumer training on SegCheck's output actually wants: no
// pending or rejected instances mixed in.
//
// Every included instance carries a compressed COCO RLE segmentation:
//   - `pass` instances already carry RLE segmentation from the original
//     SAM-assisted import (masks.segmentation) — used as-is.
//   - `fixed` instances were corrected via the "Upload corrections" flow
//     (correctionUpload.js), which records the corrected file's Storage path
//     in mask_corrections but does NOT touch masks.segmentation — so the
//     corrected file is fetched here and converted to RLE fresh.
//
// Neither the original numeric image_id nor category_id survive import
// (masks keep only the photo's UUID and the category NAME — see
// uploads.js), so this mints fresh ids for both: image ids are
// sequential, ordered by filename, so re-running the export is
// deterministic; category ids are fixed by each name's position in
// JODD_CLASSES (joddClasses.js), so category_id is identical across
// every split's JSON regardless of which classes that split actually
// contains. Any category name outside the 20 known classes (including
// the legacy '(uncategorized)' fallback below) is appended afterward,
// sorted alphabetically among itself, with ids continuing past 20.

import { supabase } from './supabaseClient'
import { selectAll, selectAllIn } from './paging'
import { downloadBlob } from './storage'
import { encodeCocoRLE, decodeCocoRLE, isRLE } from './rle'
import { clipForegroundOutsideBbox, binarize } from './maskClip'
import { JODD_CLASSES } from './joddClasses'

export const ANNOTATION_STATUSES = ['pass', 'fixed']

const CORRECTION_FETCH_CONCURRENCY = 6

async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length)
  let next = 0
  async function worker() {
    while (next < items.length) {
      const i = next++
      results[i] = await fn(items[i], i)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return results
}

// ---------------------------------------------------------------------------
// Pure assembly (unit-tested — no network, no DOM)
// ---------------------------------------------------------------------------

// Counts foreground pixels in a decoded row-major mask — the COCO `area`
// field. Cheap relative to the decode/encode this always runs alongside.
export function countArea(data) {
  let area = 0
  for (let i = 0; i < data.length; i++) if (data[i]) area++
  return area
}

// Accepts a bare segmentation (RLE object or polygon array) or one nested
// under a `segmentation` key, as either shape shows up in a correction's
// coco_json file. Only an already-RLE segmentation is usable here —
// rasterizing an arbitrary polygon needs the image's pixel dimensions, and
// collect_annotated_masks.py's coco_json format doesn't carry any.
export function resolveJsonSegmentation(parsed) {
  const seg =
    parsed && typeof parsed === 'object' && !Array.isArray(parsed) && 'segmentation' in parsed
      ? parsed.segmentation
      : parsed
  return isRLE(seg) ? seg : null
}

// Takes already-resolved instances — one per included mask, each already
// carrying its final RLE segmentation, pixel dimensions, and area — and
// assembles the { categories, images, annotations } payload. This is the
// part that must strictly match the coco.json / seg_coco.json convention
// parseManifest() expects back on the next upload.
//
// `instances`: [{ photoId, photoFilename, category, bbox, isCrowd,
//                  manifestMaskId, segmentation, area, width, height }]
export function assembleCocoAnnotations(instances) {
  const photoMeta = new Map() // photoId -> { fileName, width, height }
  for (const inst of instances) {
    if (!photoMeta.has(inst.photoId)) {
      photoMeta.set(inst.photoId, { fileName: inst.photoFilename, width: inst.width, height: inst.height })
    }
  }
  const photoIds = [...photoMeta.keys()].sort((a, b) =>
    photoMeta.get(a).fileName.localeCompare(photoMeta.get(b).fileName),
  )
  const imageIdByPhotoId = new Map(photoIds.map((id, i) => [id, i + 1]))

  const knownNames = new Set(JODD_CLASSES)
  const unknownNames = [...new Set(instances.map((inst) => inst.category ?? '(uncategorized)'))]
    .filter((name) => !knownNames.has(name))
    .sort()
  const categoryNames = [...JODD_CLASSES, ...unknownNames]
  const categoryIdByName = new Map(categoryNames.map((name, i) => [name, i + 1]))

  const images = photoIds.map((id) => {
    const m = photoMeta.get(id)
    return { id: imageIdByPhotoId.get(id), file_name: m.fileName, width: m.width, height: m.height }
  })

  const categories = categoryNames.map((name) => ({ id: categoryIdByName.get(name), name }))

  const annotations = instances
    .map((inst) => {
      const numericId = Number(inst.manifestMaskId)
      return {
        id: Number.isFinite(numericId) ? numericId : inst.manifestMaskId,
        image_id: imageIdByPhotoId.get(inst.photoId),
        category_id: categoryIdByName.get(inst.category ?? '(uncategorized)'),
        bbox: inst.bbox ?? [],
        area: inst.area,
        iscrowd: inst.isCrowd ? 1 : 0,
        segmentation: inst.segmentation,
      }
    })
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))

  return { categories, images, annotations }
}

// yyyy-mm-dd, in the caller's local timezone — matches what someone reading
// the filename on the day they downloaded it would expect. `date` is
// injectable for tests; defaults to now.
export function correctedAnnotationsFilename(split, date = new Date()) {
  const label = split === '(no split)' ? 'default' : split
  const pad = (n) => String(n).padStart(2, '0')
  const stamp = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
  return `${label}_corrected_${stamp}.json`
}

// ---------------------------------------------------------------------------
// DB reads
// ---------------------------------------------------------------------------

// Every split with at least one pass/fixed mask, with counts — mirrors
// Dashboard's fetchPassedSplitCounts but spans both qualifying statuses.
export async function fetchCorrectedSplitCounts(projectId) {
  const rows = await selectAll(() =>
    supabase
      .from('active_masks')
      .select('id, photo_split')
      .eq('project_id', projectId)
      .in('status', ANNOTATION_STATUSES),
  )
  const counts = new Map()
  for (const row of rows) {
    const key = row.photo_split ?? '(no split)'
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  return counts
}

async function fetchQualifyingMasks(projectId, split) {
  return selectAll(() => {
    const q = supabase
      .from('active_masks')
      .select(
        'id, manifest_mask_id, category, bbox, segmentation, is_crowd, status, photo_id, photo_filename, photo_split',
      )
      .eq('project_id', projectId)
      .in('status', ANNOTATION_STATUSES)
    return split === '(no split)' ? q.is('photo_split', null) : q.eq('photo_split', split)
  })
}

// Latest correction per mask (by created_at) — a mask can have more than one
// mask_corrections row if it was re-corrected, and only the newest one is
// what's actually reflected by the mask's current 'fixed' status.
async function fetchLatestCorrections(maskIds) {
  if (maskIds.length === 0) return new Map()
  const rows = await selectAllIn(maskIds, (chunk) =>
    supabase
      .from('mask_corrections')
      .select('mask_id, storage_path, format, created_at')
      .in('mask_id', chunk)
      .order('created_at', { ascending: false }),
  )
  const byMaskId = new Map()
  for (const r of rows) {
    // First hit per mask_id wins — the ORDER BY above puts the newest first.
    if (!byMaskId.has(r.mask_id)) byMaskId.set(r.mask_id, r)
  }
  return byMaskId
}

// ---------------------------------------------------------------------------
// Segmentation resolution (DOM + network — not unit-tested, mirrors
// maskClip.js's split between pure core and canvas wrapper)
// ---------------------------------------------------------------------------

// `bbox` clips foreground pixels lying outside it before encoding — the
// same guard commitRedoUploadPlan applies via clipMaskToBbox (maskClip.js).
// A hand-corrected mask_final.png routinely bleeds a few stray pixels past
// the object it's meant to cover (an overshooting brush stroke, a stray
// click); without this, those strays would silently inflate the encoded
// RLE (and its `area`) for whichever instance happens to be exported.
async function decodePngMaskToRLE(blob, bbox) {
  const bitmap = await createImageBitmap(blob)
  try {
    const canvas = document.createElement('canvas')
    canvas.width = bitmap.width
    canvas.height = bitmap.height
    const ctx = canvas.getContext('2d')
    ctx.drawImage(bitmap, 0, 0)
    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height)
    clipForegroundOutsideBbox(imageData.data, canvas.width, canvas.height, bbox)

    const data = binarize(imageData.data, canvas.width, canvas.height)
    return {
      segmentation: encodeCocoRLE(data, canvas.width, canvas.height),
      area: countArea(data),
      width: canvas.width,
      height: canvas.height,
    }
  } finally {
    bitmap.close()
  }
}

// Resolves the final RLE segmentation (+ area + pixel dims) for one 'fixed'
// mask from its correction file, or null if it can't be resolved — reported
// to the caller as a skip rather than silently dropped.
async function resolveFixedSegmentation(correction, bbox) {
  if (!correction) return null
  const blob = await downloadBlob(correction.storage_path)

  if (correction.format === 'png') return decodePngMaskToRLE(blob, bbox)

  let parsed
  try {
    parsed = JSON.parse(await blob.text())
  } catch {
    return null
  }
  const segmentation = resolveJsonSegmentation(parsed)
  if (!segmentation) return null
  const { data, width, height } = decodeCocoRLE(segmentation)
  return { segmentation, area: countArea(data), width, height }
}

// Resolves the final RLE segmentation (+ area + pixel dims) for one 'pass'
// mask directly from masks.segmentation, already RLE from the original
// SAM-assisted import.
function resolvePassSegmentation(row) {
  if (!isRLE(row.segmentation)) return null
  const { data, width, height } = decodeCocoRLE(row.segmentation)
  return { segmentation: row.segmentation, area: countArea(data), width, height }
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

// Builds the { categories, images, annotations } payload for one split, plus
// a `skipped` list for any qualifying mask whose segmentation couldn't be
// resolved (missing/corrupt correction file, or a 'pass' mask that somehow
// never got a stored RLE segmentation) — reported to the caller rather than
// either failing the whole export or silently shrinking it.
//
// `onProgress(done, total)` fires once per qualifying mask processed.
export async function buildCorrectedAnnotationsForSplit({ projectId, split, onProgress, signal }) {
  const rows = await fetchQualifyingMasks(projectId, split)
  const fixedRows = rows.filter((r) => r.status === 'fixed')
  const correctionsByMaskId = await fetchLatestCorrections(fixedRows.map((r) => r.id))

  const resolved = new Array(rows.length)
  let done = 0

  const passIndexes = []
  const fixedIndexes = []
  rows.forEach((r, i) => (r.status === 'pass' ? passIndexes : fixedIndexes).push(i))

  // 'pass' rows need no network — resolve them synchronously first so the
  // progress bar moves immediately instead of sitting at 0 during the
  // (usually much smaller) batch of correction-file downloads.
  for (const i of passIndexes) {
    resolved[i] = resolvePassSegmentation(rows[i])
    onProgress?.(++done, rows.length)
  }

  await mapWithConcurrency(fixedIndexes, CORRECTION_FETCH_CONCURRENCY, async (i) => {
    signal?.throwIfAborted()
    try {
      resolved[i] = await resolveFixedSegmentation(correctionsByMaskId.get(rows[i].id), rows[i].bbox)
    } catch (e) {
      console.error('resolveFixedSegmentation failed for mask', rows[i].id, e)
      resolved[i] = null
    }
    onProgress?.(++done, rows.length)
  })

  const instances = []
  const skipped = []
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]
    if (resolved[i]) {
      instances.push({
        photoId: row.photo_id,
        photoFilename: row.photo_filename,
        category: row.category,
        bbox: row.bbox,
        isCrowd: row.is_crowd,
        manifestMaskId: row.manifest_mask_id,
        ...resolved[i],
      })
    } else {
      skipped.push({
        maskId: row.id,
        manifestMaskId: row.manifest_mask_id,
        photoFilename: row.photo_filename,
        reason: row.status === 'fixed' ? 'correction file missing or unusable' : 'no RLE segmentation stored',
      })
    }
  }

  return { ...assembleCocoAnnotations(instances), skipped }
}
