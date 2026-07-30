import JSZip from 'jszip'

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

// Builds a zip from [{ path, blob }] entries and triggers a browser download.
export async function downloadZip(filename, files) {
  const zip = new JSZip()
  for (const f of files) zip.file(f.path, f.blob)
  const blob = await zip.generateAsync({ type: 'blob' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}