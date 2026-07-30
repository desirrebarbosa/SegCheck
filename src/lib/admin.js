import { supabase } from './supabaseClient'

const BUCKET = 'segcheck'

// Photos for the "manage photos" bulk-delete list, each with EVERY mask
// storage path across ALL its versions (not just the latest) — deleting a
// photo should clean up every version's files, not just the active one.
// Paginated: large projects can have thousands of photos, so this fetches
// one page at a time rather than the whole table.
export async function listPhotosForManagement(projectId, { page = 0, pageSize = 50 } = {}) {
  const from = page * pageSize
  const to = from + pageSize - 1

  const {
    data: photos,
    error: pErr,
    count,
  } = await supabase
    .from('photos')
    .select('id, split, filename, storage_path, thumbnail_path, latest_version, created_at', {
      count: 'exact',
    })
    .eq('project_id', projectId)
    .order('created_at', { ascending: false })
    .range(from, to)
  if (pErr) throw pErr

  const photoIds = photos.map((p) => p.id)
  const maskPathsByPhoto = new Map()
  if (photoIds.length > 0) {
    const { data: masks, error: mErr } = await supabase
      .from('masks')
      .select('storage_path, photo_version:photo_versions!inner(photo_id)')
      .eq('project_id', projectId)
      .not('storage_path', 'is', null)
      .in('photo_version.photo_id', photoIds)
    if (mErr) throw mErr
    for (const m of masks) {
      const photoId = m.photo_version.photo_id
      if (!maskPathsByPhoto.has(photoId)) maskPathsByPhoto.set(photoId, [])
      maskPathsByPhoto.get(photoId).push(m.storage_path)
    }
  }

  return {
    photos: photos.map((p) => ({
      photo_id: p.id,
      split: p.split,
      filename: p.filename,
      photo_storage_path: p.storage_path,
      thumbnail_path: p.thumbnail_path,
      mask_storage_paths: maskPathsByPhoto.get(p.id) ?? [],
      latest_version: p.latest_version,
    })),
    total: count ?? 0,
    page,
    pageSize,
  }
}

// Lists every Storage object under a project's path prefix. Supabase's list
// API is per-folder (not recursive), so this walks photos/ and masks/ (and
// their per-split/per-stem subfolders) explicitly rather than assuming a
// flat structure.
export async function listProjectStorageObjects(projectId) {
  const paths = []

  async function walk(prefix) {
    const { data, error } = await supabase.storage.from(BUCKET).list(prefix, { limit: 1000 })
    if (error) throw error
    for (const entry of data ?? []) {
      const full = `${prefix}/${entry.name}`
      // Supabase Storage represents folders as entries with id === null.
      if (entry.id === null) {
        await walk(full)
      } else {
        paths.push(full)
      }
    }
  }

  await walk(projectId)
  return paths
}

// Deletes many Storage paths in batches (Supabase's remove() accepts an
// array, but very large projects can exceed practical request size).
export async function deleteStoragePaths(paths, { batchSize = 500 } = {}) {
  for (let i = 0; i < paths.length; i += batchSize) {
    const batch = paths.slice(i, i + batchSize)
    const { error } = await supabase.storage.from(BUCKET).remove(batch)
    if (error) throw error
  }
}

// Deletes a project entirely: DB rows cascade automatically via existing
// foreign keys, but Storage objects do NOT — Supabase Storage is managed
// through a separate API, so they're listed and removed explicitly here
// before the DB row is dropped.
export async function deleteProject(projectId) {
  const paths = await listProjectStorageObjects(projectId)
  if (paths.length > 0) await deleteStoragePaths(paths)

  const { error } = await supabase.from('projects').delete().eq('id', projectId)
  if (error) throw error
}

// Deletes a specific set of photos (and, via cascade, their versions/masks)
// plus their Storage files — for the "select some rows, delete them" bulk
// action in the UI, as opposed to wiping the whole project.
export async function deletePhotosWithStorage(projectId, photoRows) {
  const paths = []
  for (const p of photoRows) {
    if (p.photo_storage_path) paths.push(p.photo_storage_path)
    if (p.mask_storage_paths) paths.push(...p.mask_storage_paths)
  }
  if (paths.length > 0) await deleteStoragePaths(paths)

  const photoIds = photoRows.map((p) => p.photo_id)
  const { error } = await supabase.from('photos').delete().in('id', photoIds).eq('project_id', projectId)
  if (error) throw error
}