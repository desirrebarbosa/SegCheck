// Clips a manually re-annotated mask so nothing outside its bounding box
// survives. Hand-edited masks routinely bleed a few pixels past the bbox
// (a brush stroke that overshoots, a stray click), and those strays would
// otherwise end up in the RLE we encode from this image.
//
// Split into a pure core and a canvas wrapper on purpose: the core is
// plain array arithmetic and is unit tested under Vitest with no browser
// environment, while only the thin wrapper needs a real DOM.

// A pixel counts as foreground when its average channel value clears the
// halfway point. NOT an exact 255/0 equality test: masks exported from
// image editors are routinely anti-aliased, so edge pixels land on values
// like 250 or 6 and a strict test would treat a soft edge as background.
//
// Assumes the mask is encoded in RGB. If real masks turn out to carry the
// mask in the alpha channel instead, this is the line to revisit — it's
// been verified against synthetic fixtures, not against a corpus of real
// anti-aliased exports.
export function isForegroundPixel(r, g, b) {
  return (r + g + b) / 3 > 127
}

// Zeroes the colour channels of every foreground pixel lying outside
// `bbox`, in place, and returns the same array for convenience.
//
// `rgba` is a flat RGBA byte array (canvas ImageData.data layout).
// `bbox` is COCO's [x, y, w, h], and may extend past the image bounds or
// sit entirely outside it — both are clamped rather than treated as errors,
// since a bbox is authored against the photo and nothing guarantees the
// mask PNG shares its dimensions.
//
// ALPHA IS NEVER TOUCHED. Mask PNGs are commonly fully opaque with the
// shape carried in RGB; rewriting alpha here would silently change how the
// file composites everywhere else it's drawn.
export function clipForegroundOutsideBbox(rgba, width, height, bbox) {
  if (!bbox) return rgba
  const [bx, by, bw, bh] = bbox

  // Half-open [min, max): a pixel at exactly x + w is outside the box.
  const minX = Math.max(0, Math.floor(bx))
  const minY = Math.max(0, Math.floor(by))
  const maxX = Math.min(width, Math.ceil(bx + bw))
  const maxY = Math.min(height, Math.ceil(by + bh))

  for (let y = 0; y < height; y++) {
    const insideRow = y >= minY && y < maxY
    for (let x = 0; x < width; x++) {
      if (insideRow && x >= minX && x < maxX) continue
      const i = (y * width + x) * 4
      if (isForegroundPixel(rgba[i], rgba[i + 1], rgba[i + 2])) {
        rgba[i] = 0
        rgba[i + 1] = 0
        rgba[i + 2] = 0
      }
    }
  }
  return rgba
}

// Flattens RGBA bytes to one byte per pixel, 1 for foreground and 0 for
// background, row-major — exactly the layout encodeCocoRLE consumes.
export function binarize(rgba, width, height) {
  const data = new Uint8Array(width * height)
  for (let p = 0; p < data.length; p++) {
    const i = p * 4
    data[p] = isForegroundPixel(rgba[i], rgba[i + 1], rgba[i + 2]) ? 1 : 0
  }
  return data
}

// Browser wrapper: decode -> clip -> re-encode.
//
// Returns { blob, data, width, height } rather than just the PNG, because
// the redo pipeline needs both halves and they come from the same decode:
// `blob` is uploaded to storage, while `data`/`width`/`height` feed
// encodeCocoRLE. Splitting these into two calls would mean decoding the
// same image twice and risking the stored PNG disagreeing with the stored
// segmentation.
//
// PNG, never JPEG. JPEG is lossy and its artifacts cluster around exactly
// the high-contrast edges this function exists to clean up, so round-
// tripping through it would reintroduce stray near-white pixels at the
// bbox boundary — the precise thing being removed.
export async function clipMaskToBbox(fileOrBlob, bbox) {
  const bitmap = await createImageBitmap(fileOrBlob)
  try {
    const canvas = document.createElement('canvas')
    canvas.width = bitmap.width
    canvas.height = bitmap.height
    const ctx = canvas.getContext('2d')
    ctx.drawImage(bitmap, 0, 0)

    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height)
    clipForegroundOutsideBbox(imageData.data, canvas.width, canvas.height, bbox)
    ctx.putImageData(imageData, 0, 0)

    const blob = await new Promise((resolve, reject) =>
      canvas.toBlob(
        (b) => (b ? resolve(b) : reject(new Error('Could not re-encode the mask PNG.'))),
        'image/png',
      ),
    )
    return {
      blob,
      data: binarize(imageData.data, canvas.width, canvas.height),
      width: canvas.width,
      height: canvas.height,
    }
  } finally {
    bitmap.close()
  }
}
