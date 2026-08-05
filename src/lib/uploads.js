import { supabase } from './supabaseClient'
import { uploadFile } from './storage'
import { makeThumbnail } from './thumbnails'
import { rebalanceRedoAssignments } from './projects'

// How many photos (and, separately, how many mask files within one photo)
// are processed at once. Bounded rather than unbounded `Promise.all` so we
// get the speed-up from parallelizing without flooding Supabase / the
// browser with hundreds of simultaneous requests at once.
const CONCURRENCY = 6

// Runs `fn` over `items` with at most `limit` running at once. Results are
// returned in the same order as `items`, regardless of completion order.
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

// Commits ONE split's plan (from buildUploadPlanForSplit / the `plan` array
// inside a buildMultiSplitUploadPlan() result) to Supabase.
//
// Same end result as before, but restructured for speed:
//   - one query up front for every photo that might already exist in this
//     split, instead of one `select` per photo inside the loop
//   - photos (and, within a photo, mask files) are processed in bounded
//     parallel batches instead of one strictly-sequential loop
//   - all of one photo's mask rows are inserted in a single batched
//     `insert([...])` instead of one insert per mask
//   - thumbnail generation/upload no longer blocks the rest of that
//     photo's processing (it was already treated as non-fatal on failure,
//     so there's no reason to wait on it before moving on)
//
// `onProgress`, if given, is called as `onProgress(done, total)` once per
// photo that finishes — since photos now complete out of order (bounded
// concurrency, not strictly sequential), `done` only ever counts finished
// work, it doesn't correspond to `plan`'s original index order.
export async function commitSplitPlan({ projectId, split, userId, plan, onProgress }) {
  const summary = { photosCreated: 0, photosVersioned: 0, masksCreated: 0, autoFailed: 0 }

  // Pre-fetch every existing photo for this project+split in one query,
  // instead of one `select` per photo in the loop below.
  const { data: existingPhotos, error: existErr } = await supabase
    .from('photos')
    .select('*')
    .eq('project_id', projectId)
    .eq('split', split)
  if (existErr) throw existErr
  const existingByFilename = new Map(existingPhotos.map((p) => [p.filename, p]))

  let done = 0

  await mapWithConcurrency(plan, CONCURRENCY, async (item) => {
    const filename = item.photo.relativePath ?? item.photo.name
    let photo = existingByFilename.get(filename) ?? null
    const photoPath = `${projectId}/${split}/photos/${item.stem}-${item.photo.name}`

    if (!photo) {
      await uploadFile(photoPath, item.photo.blob ?? item.photo.file)

      const { data: created, error: insErr } = await supabase
        .from('photos')
        .insert({
          project_id: projectId,
          split,
          filename,
          storage_path: photoPath,
          thumbnail_path: null,
          latest_version: 1,
          uploaded_by: userId,
        })
        .select()
        .single()
      if (insErr) throw insErr
      photo = created
      summary.photosCreated += 1

      // Fire-and-forget: non-fatal on failure (same as before), and
      // doesn't need to hold up this photo's masks/version or the next
      // photo in the batch. Patches the row with the thumbnail path once
      // it's ready.
      makeThumbnail(item.photo.blob ?? item.photo.file)
        .then(async (thumbBlob) => {
          const thumbnailPath = `${projectId}/${split}/thumbs/${item.stem}.jpg`
          await uploadFile(thumbnailPath, thumbBlob)
          const { error } = await supabase
            .from('photos')
            .update({ thumbnail_path: thumbnailPath })
            .eq('id', photo.id)
          if (error) throw error
        })
        .catch((e) => console.error('Thumbnail generation failed for', filename, e))

      await supabase.from('review_logs').insert({
        project_id: projectId,
        photo_id: photo.id,
        reviewer_id: userId,
        action: 'upload_photo',
        detail: { filename, split },
      })
    } else {
      const nextVersion = photo.latest_version + 1
      const { error: updErr } = await supabase
        .from('photos')
        .update({ latest_version: nextVersion })
        .eq('id', photo.id)
      if (updErr) throw updErr
      photo = { ...photo, latest_version: nextVersion }
      summary.photosVersioned += 1
    }

    const { data: version, error: vErr } = await supabase
      .from('photo_versions')
      .insert({
        photo_id: photo.id,
        project_id: projectId,
        version_number: photo.latest_version,
        uploaded_by: userId,
      })
      .select()
      .single()
    if (vErr) throw vErr
    await supabase.from('review_logs').insert({
      project_id: projectId,
      photo_id: photo.id,
      reviewer_id: userId,
      action: 'upload_version',
      detail: { version_number: version.version_number, split },
    })

    if (item.missingWhole) {
      const { error: mErr } = await supabase.from('masks').insert({
        photo_version_id: version.id,
        project_id: projectId,
        is_missing: true,
        status: 'fail',
      })
      if (mErr) throw mErr
      summary.masksCreated += 1
      summary.autoFailed += 1
      await supabase.from('review_logs').insert({
        project_id: projectId,
        photo_id: photo.id,
        reviewer_id: userId,
        action: 'auto_fail_missing',
        status_after: 'fail',
        detail: { reason: 'photo not present in SAM-assisted manifest', split },
      })
    } else if (item.instances.length > 0) {
      // Upload every instance's mask FILE in parallel (bounded)...
      const withPaths = await mapWithConcurrency(item.instances, CONCURRENCY, async (inst) => {
        let maskPath = null
        if (inst.mask) {
          maskPath = `${projectId}/${split}/masks/${item.stem}/${inst.annotationId}-${inst.mask.name}`
          await uploadFile(maskPath, inst.mask.blob ?? inst.mask.file)
        }
        return { inst, maskPath }
      })

      // ...then insert all resulting mask ROWS in a single batched insert,
      // instead of one insert per instance.
      const maskRows = withPaths.map(({ inst, maskPath }) => ({
        photo_version_id: version.id,
        project_id: projectId,
        manifest_mask_id: String(inst.annotationId),
        storage_path: maskPath,
        is_missing: inst.missing,
        status: inst.missing ? 'fail' : 'pending',
        category: inst.category,
        bbox: inst.bbox,
        segmentation: inst.segmentation,
        is_crowd: !!inst.isCrowd,
      }))

      const { data: insertedMasks, error: mErr } = await supabase
        .from('masks')
        .insert(maskRows)
        .select()
      if (mErr) throw mErr
      summary.masksCreated += insertedMasks.length

      // Matched back up by manifest_mask_id (not array position) since a
      // batched insert's response row order isn't a contract worth relying on.
      const insertedByAnnotationId = new Map(insertedMasks.map((m) => [m.manifest_mask_id, m]))
      const failLogs = withPaths
        .filter(({ inst }) => inst.missing)
        .map(({ inst }) => ({
          project_id: projectId,
          mask_id: insertedByAnnotationId.get(String(inst.annotationId))?.id,
          photo_id: photo.id,
          reviewer_id: userId,
          action: 'auto_fail_missing',
          status_after: 'fail',
          detail: { annotation_id: inst.annotationId, reason: 'no matching mask file', split },
        }))
      summary.autoFailed += failLogs.length
      if (failLogs.length > 0) {
        const { error: logErr } = await supabase.from('review_logs').insert(failLogs)
        if (logErr) throw logErr
      }
    }

    done += 1
    onProgress?.(done, plan.length)
  })

  return summary
}

// Commits every split in a buildMultiSplitUploadPlan() result. Returns
// summaries keyed by split, plus a combined total for a quick top-line
// number in the UI.
export async function commitMultiSplitPlan({ projectId, userId, bySplit }) {
  const perSplit = {}
  const total = { photosCreated: 0, photosVersioned: 0, masksCreated: 0, autoFailed: 0 }

  for (const [split, { plan }] of bySplit) {
    const summary = await commitSplitPlan({ projectId, split, userId, plan })
    perSplit[split] = summary
    for (const key of Object.keys(total)) total[key] += summary[key]
  }

  // New fail masks (just created above) split evenly across current
  // members — same "unassigned pool only, never steal existing work"
  // rebalance used at member-add time, so a fresh upload's redo backlog
  // doesn't require any manual step to get routed.
  try {
    await rebalanceRedoAssignments(projectId)
  } catch (e) {
    console.error('rebalanceRedoAssignments after upload failed:', e)
  }

  return { perSplit, total }
}