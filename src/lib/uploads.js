import { supabase } from './supabaseClient'
import { uploadFile } from './storage'
import { makeThumbnail } from './thumbnails'

// Commits ONE split's plan (from buildUploadPlanForSplit / the `plan` array
// inside a buildMultiSplitUploadPlan() result) to Supabase. Same behavior as
// before, plus: photos are now found/created scoped to project+split+
// filename (a filename can repeat across splits), and `split` is stored on
// the photo row.
async function commitSplitPlan({ projectId, split, userId, plan }) {
  const summary = { photosCreated: 0, photosVersioned: 0, masksCreated: 0, autoFailed: 0 }

  for (const item of plan) {
    const filename = item.photo.relativePath ?? item.photo.name

    const { data: existing, error: findErr } = await supabase
      .from('photos')
      .select('*')
      .eq('project_id', projectId)
      .eq('split', split)
      .eq('filename', filename)
      .maybeSingle()
    if (findErr) throw findErr

    let photo = existing
    const photoPath = `${projectId}/${split}/photos/${item.stem}-${item.photo.name}`

    if (!photo) {
      await uploadFile(photoPath, item.photo.blob ?? item.photo.file)

      let thumbnailPath = null
      try {
        const thumbBlob = await makeThumbnail(item.photo.blob ?? item.photo.file)
        thumbnailPath = `${projectId}/${split}/thumbs/${item.stem}.jpg`
        await uploadFile(thumbnailPath, thumbBlob)
      } catch (e) {
        // Non-fatal: the photo itself already uploaded fine. A missing
        // thumbnail just means the manage-photos list falls back to no
        // preview for this one row, not a failed upload.
        console.error('Thumbnail generation failed for', filename, e)
      }

      const { data: created, error: insErr } = await supabase
        .from('photos')
        .insert({
          project_id: projectId,
          split,
          filename,
          storage_path: photoPath,
          thumbnail_path: thumbnailPath,
          latest_version: 1,
          uploaded_by: userId,
        })
        .select()
        .single()
      if (insErr) throw insErr
      photo = created
      summary.photosCreated += 1
      await supabase.from('review_logs').insert({
        project_id: projectId,
        photo_id: photo.id,
        reviewer_id: userId,
        action: 'upload_photo',
        detail: { filename, split },
      })
    } else {
      const nextVersion = existing.latest_version + 1
      const { error: updErr } = await supabase
        .from('photos')
        .update({ latest_version: nextVersion })
        .eq('id', photo.id)
      if (updErr) throw updErr
      photo.latest_version = nextVersion
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
      continue
    }

    for (const inst of item.instances) {
      let maskPath = null
      if (inst.mask) {
        maskPath = `${projectId}/${split}/masks/${item.stem}/${inst.annotationId}-${inst.mask.name}`
        await uploadFile(maskPath, inst.mask.blob ?? inst.mask.file)
      }

      const { data: mask, error: mErr } = await supabase
        .from('masks')
        .insert({
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
        })
        .select()
        .single()
      if (mErr) throw mErr
      summary.masksCreated += 1

      if (inst.missing) {
        summary.autoFailed += 1
        await supabase.from('review_logs').insert({
          project_id: projectId,
          mask_id: mask.id,
          photo_id: photo.id,
          reviewer_id: userId,
          action: 'auto_fail_missing',
          status_after: 'fail',
          detail: { annotation_id: inst.annotationId, reason: 'no matching mask file', split },
        })
      }
    }
  }

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

  return { perSplit, total }
}