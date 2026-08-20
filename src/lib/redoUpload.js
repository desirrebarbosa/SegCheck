import { supabase } from './supabaseClient'
import { uploadFile } from './storage'
import { clipMaskToBbox } from './maskClip'
import { encodeCocoRLE } from './rle'
import { selectAllIn } from './paging'
import { closeCompletedBatches } from './redoBatches'

// Re-uploading corrected redo masks.
//
// The expected zip is exactly what Dashboard's "Download redo batch"
// produces, so a batch can be exported, edited in an image editor, and
// re-uploaded without rearranging anything:
//
//   masks/<photo_filename>/<annotationId>-<original name>.png
//
// The leading <annotationId> segment is the match key and equals
// masks.manifest_mask_id. Photos in the zip are ignored — the redo path is
// masks-only, since the photo from the original upload is the source of
// truth and nothing about re-annotation changes it.
//
// Same two-phase shape as the original upload: build a plan, show the user
// what it will do, then commit. Nothing here writes until commit.

const CONCURRENCY = 6

// Only files under masks/ with at least one path segment beneath it.
const MASK_PATH = /^masks\/[^/]+\/(.+)$/

// Leading digits before the first dash: "1234-whatever.png" -> "1234".
// Anchored and dash-terminated so a plain "whatever.png" is treated as
// unrecognised rather than silently matching some unrelated mask.
const ANNOTATION_ID = /^(\d+)-/

// Splits zip entries into the buckets the UI reports, WITHOUT touching the
// database yet.
export function parseRedoEntries(entries) {
  const masks = []
  const ignored = []
  for (const entry of entries) {
    const path = entry.relativePath ?? entry.name
    const underMasks = MASK_PATH.exec(path)
    if (!underMasks) {
      ignored.push(path)
      continue
    }
    const idMatch = ANNOTATION_ID.exec(underMasks[1].split('/').pop())
    if (!idMatch) {
      ignored.push(path)
      continue
    }
    masks.push({ entry, path, annotationId: idMatch[1] })
  }
  return { masks, ignored }
}

// Looks each parsed mask up against the project's CURRENT masks and sorts
// them into what will happen on commit.
//
// Reads through `active_masks` rather than `masks` so only the latest
// photo version is considered — re-uploading against a superseded version
// would write to a row nobody is reviewing.
export async function buildRedoUploadPlan(entries, { projectId }) {
  const { masks, ignored } = parseRedoEntries(entries)

  if (masks.length === 0) {
    return { matched: [], unmatched: [], wrongStatus: [], duplicates: [], ignored }
  }

  // One query per CHUNK of annotation ids, rather than per file — and
  // chunked rather than one big `.in()`, which was quietly breaking large
  // batches two ways: PostgREST caps a response at 1000 rows, and the id
  // list travels in the request URL, so a few thousand ids either came back
  // truncated or blew the URL length limit. Either way the masks that fell
  // off the end were reported to the user as "unmatched" — a redo zip of
  // several thousand masks would appear to mostly not belong to the
  // project, and the annotator's work would be silently dropped on commit.
  const ids = [...new Set(masks.map((m) => m.annotationId))]
  const rows = await selectAllIn(ids, (chunk) =>
    supabase
      .from('active_masks')
      .select('id, manifest_mask_id, status, bbox, storage_path, photo_id, photo_filename')
      .eq('project_id', projectId)
      .in('manifest_mask_id', chunk),
  )

  const byAnnotationId = new Map(rows.map((r) => [String(r.manifest_mask_id), r]))

  const matched = []
  const unmatched = []
  const wrongStatus = []
  const duplicates = []
  const seen = new Set()

  for (const item of masks) {
    const row = byAnnotationId.get(item.annotationId)
    if (!row) {
      unmatched.push(item)
    } else if (row.status !== 'fail') {
      // Only failed masks are awaiting re-annotation. Overwriting a passed
      // one would silently discard an accepted result.
      wrongStatus.push({ ...item, status: row.status })
    } else if (seen.has(item.annotationId)) {
      // Two files claiming the same annotation id — take neither rather
      // than let zip ordering decide which wins.
      duplicates.push(item)
    } else {
      seen.add(item.annotationId)
      matched.push({ ...item, mask: row })
    }
  }

  return { matched, unmatched, wrongStatus, duplicates, ignored }
}

// Runs `fn` over `items` with at most `limit` in flight. Mirrors the
// helper in uploads.js — same reason: parallel enough to be quick, bounded
// so we don't fire hundreds of simultaneous requests.
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

// Derives the next redo version for a storage path, so re-uploads never
// overwrite the previous attempt: ".../123-mask.png" -> ".../123-redo-1.png",
// and an existing "-redo-1" becomes "-redo-2".
export function nextRedoPath(storagePath, annotationId) {
  const lastSlash = storagePath.lastIndexOf('/')
  const dir = lastSlash === -1 ? '' : storagePath.slice(0, lastSlash + 1)
  const existing = /-redo-(\d+)\.png$/.exec(storagePath)
  const n = existing ? Number(existing[1]) + 1 : 1
  return `${dir}${annotationId}-redo-${n}.png`
}

// Commits a plan: clip each mask to its bbox, re-encode the segmentation
// from the clipped result, upload as a new versioned object, and put the
// mask back into the review queue.
//
// Status returns to 'pending' (decided): a human fixed it by hand, but the
// point of the tool is that a second pair of eyes confirms the fix, so it
// goes through QA again rather than straight to 'pass'. assigned_to is
// cleared at the same time so it leaves the annotator's My Redo list and
// gets redistributed as review work.
export async function commitRedoUploadPlan(plan, { userId, projectId, onProgress }) {
  const summary = { updated: 0, failed: [] }
  let done = 0

  await mapWithConcurrency(plan.matched, CONCURRENCY, async ({ entry, mask, annotationId }) => {
    try {
      // One decode produces both the PNG we store and the pixels we encode,
      // so the stored image and the stored segmentation can't disagree.
      const { blob, data, width, height } = await clipMaskToBbox(entry.blob, mask.bbox)
      const segmentation = encodeCocoRLE(data, width, height)

      const path = nextRedoPath(mask.storage_path ?? `${projectId}/masks/${annotationId}.png`, annotationId)
      await uploadFile(path, blob)

      const { error: updErr } = await supabase
        .from('masks')
        .update({
          storage_path: path,
          segmentation,
          status: 'pending',
          assigned_to: null,
          is_missing: false,
          reviewed_by: null,
          reviewed_at: null,
        })
        .eq('id', mask.id)
      if (updErr) throw updErr

      // Error CHECKED, unlike before: 'redo_upload' was missing from the
      // log_action enum, so every one of these inserts failed with 22P02
      // and nobody noticed — supabase-js returns { error }, it does not
      // throw, and this call ignored the result. The whole redo history was
      // lost that way. Non-fatal (the mask is already updated; losing the
      // audit row must not fail the re-upload) but no longer silent.
      const { error: logErr } = await supabase.from('review_logs').insert({
        project_id: projectId,
        mask_id: mask.id,
        photo_id: mask.photo_id,
        reviewer_id: userId,
        action: 'redo_upload',
        status_before: 'fail',
        status_after: 'pending',
        detail: { annotation_id: annotationId, storage_path: path },
      })
      if (logErr) console.error('review_logs insert failed for', annotationId, logErr)

      summary.updated += 1
    } catch (e) {
      // One bad file shouldn't abandon the rest of the batch — collect it
      // and report at the end.
      console.error('redo upload failed for', annotationId, e)
      summary.failed.push({ annotationId, message: e.message })
    } finally {
      done += 1
      onProgress?.(done, plan.matched.length)
    }
  })

  // A downloaded batch stays OPEN until every mask in it has come back, so
  // a partial re-upload never releases the remainder of someone's work
  // mid-annotation. Non-fatal: the masks are already updated, and a batch
  // closing late only delays that person becoming eligible for a re-level.
  try {
    await closeCompletedBatches(projectId, userId)
  } catch (e) {
    console.error('closeCompletedBatches failed:', e)
  }

  return summary
}
