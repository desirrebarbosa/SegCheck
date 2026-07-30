// Generates a small JPEG thumbnail (max 160px on the long edge) from an
// image File/Blob, entirely client-side via canvas — used so the "Manage
// photos" list can show a quick visual without loading full-resolution
// images (which is what the review canvas needs, but a list of hundreds of
// rows does not).
export async function makeThumbnail(fileOrBlob, maxSize = 160) {
  const bitmap = await createImageBitmap(fileOrBlob)
  const scale = Math.min(1, maxSize / Math.max(bitmap.width, bitmap.height))
  const w = Math.round(bitmap.width * scale)
  const h = Math.round(bitmap.height * scale)

  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d')
  ctx.drawImage(bitmap, 0, 0, w, h)

  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error('Thumbnail encode failed'))),
      'image/jpeg',
      0.7,
    )
  })
}