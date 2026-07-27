import JSZip from 'jszip'

// Reads a .zip File into a flat list of { name, relativePath, blob } entries.
// Skips directory entries and common OS junk (__MACOSX, .DS_Store).
export async function readZipEntries(zipFile) {
  const zip = await JSZip.loadAsync(zipFile)
  const entries = []
  for (const path of Object.keys(zip.files)) {
    const entry = zip.files[path]
    if (entry.dir) continue
    if (path.startsWith('__MACOSX/') || path.split('/').pop() === '.DS_Store') continue
    const blob = await entry.async('blob')
    entries.push({ name: path.split('/').pop(), relativePath: path, blob })
  }
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