import JSZip from 'jszip'
import { downloadBlob } from './storage'

const READ_CONCURRENCY = 8

// Reads a .zip File into a flat list of { name, relativePath, blob } entries.
// Skips directory entries and common OS junk (__MACOSX, .DS_Store).
// Entries are extracted in bounded-parallel batches rather than one at a
// time — for zips with hundreds of files this is a meaningful chunk of
// total upload time on its own.
export async function readZipEntries(zipFile) {
  const zip = await JSZip.loadAsync(zipFile)
  const paths = Object.keys(zip.files).filter((path) => {
    const entry = zip.files[path]
    if (entry.dir) return false
    if (path.startsWith('__MACOSX/') || path.split('/').pop() === '.DS_Store') return false
    return true
  })

  const entries = new Array(paths.length)
  let next = 0
  async function worker() {
    while (next < paths.length) {
      const i = next++
      const path = paths[i]
      const blob = await zip.files[path].async('blob')
      entries[i] = { name: path.split('/').pop(), relativePath: path, blob }
    }
  }
  await Promise.all(Array.from({ length: Math.min(READ_CONCURRENCY, paths.length) }, worker))
  return entries
}

// Downloads the photo + mask files referenced by a set of active_masks
// rows, deduping photos (fetched once even when several masks share one
// photo). Shared by every export that ships photos/masks as a zip
// (redo batches, per-split annotated exports) so the dedupe-and-fetch loop
// lives in one place instead of being copied per caller.
//
// Returns both the flat `files` list (ready for downloadZip) and the raw
// blobs keyed by photo_id / row.id, since callers that also need to render
// something derived from those blobs (e.g. a flattened instance preview)
// would otherwise have to re-download the same files a second time.
//
// `onProgress(done, total)`, if given, fires once per row processed — the
// natural unit callers already show counts in ("12 failed masks"), rather
// than one per individual blob fetch (photos are deduped and skip-fetched,
// so that count wouldn't line up with anything the UI displays).
export async function collectPhotoMaskEntries(
  rows,
  { photoDir = 'photos', maskDir = 'masks' } = {},
  onProgress,
) {
  const photoBlobs = new Map() // photo_id -> blob
  const maskBlobs = new Map() // row.id -> blob
  const photoFetches = new Map() // photo_id -> in-flight/-completed fetch, for dedup
  const photoFiles = new Map() // photo_id -> file entry, first occurrence wins
  const maskFiles = new Array(rows.length)

  let done = 0
  let next = 0
  async function worker() {
    while (next < rows.length) {
      const i = next++
      const r = rows[i]

      // Synchronous check-and-set below the first `await` dedupes photo
      // fetches even when multiple workers hit the same photo_id at once.
      let fetch = photoFetches.get(r.photo_id)
      if (!fetch) {
        fetch = downloadBlob(r.photo_storage_path)
        photoFetches.set(r.photo_id, fetch)
        photoFiles.set(r.photo_id, { path: `${photoDir}/${r.photo_filename}`, blob: null })
      }
      const photoBlob = await fetch
      photoBlobs.set(r.photo_id, photoBlob)
      photoFiles.get(r.photo_id).blob = photoBlob

      if (r.storage_path) {
        const maskBlob = await downloadBlob(r.storage_path)
        maskBlobs.set(r.id, maskBlob)
        const maskName = r.storage_path.split('/').pop()
        maskFiles[i] = { path: `${maskDir}/${r.photo_filename}/${maskName}`, blob: maskBlob }
      }

      onProgress?.(++done, rows.length)
    }
  }
  await Promise.all(Array.from({ length: Math.min(READ_CONCURRENCY, rows.length) }, worker))

  const files = [...photoFiles.values(), ...maskFiles.filter(Boolean)]
  return { files, photoBlobs, maskBlobs }
}

// Builds a zip from [{ path, blob }] entries and triggers a browser
// download. `onProgress(percent)` mirrors JSZip's own compression progress
// (0-100) — the last leg of an export, after files are already collected.
export async function downloadZip(filename, files, onProgress) {
  const zip = new JSZip()
  for (const f of files) zip.file(f.path, f.blob)
  // These entries are already-compressed photos/masks/previews (plus a
  // small CSV manifest), so DEFLATE just burns CPU for no size benefit —
  // store them uncompressed instead.
  const blob = await zip.generateAsync({ type: 'blob', compression: 'STORE' }, (metadata) => {
    onProgress?.(metadata.percent)
  })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}