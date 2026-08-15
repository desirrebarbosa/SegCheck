import { decodeCocoRLE, isRLE } from './rle'

// Paints, onto an already-sized canvas context, at native photo resolution:
//   1. the photo (opacity: opacities.photo)
//   2. the raster mask file, if provided (opacity: opacities.mask)
//   3. the segmentation — RLE (decoded here) or a plain polygon array —
//      filled with polygonColor (opacity: opacities.polygon)
//   4. the bbox rectangle, stroked with bboxColor (opacity: opacities.bbox)
//
// `ctx.canvas` must already be sized to match `photoImg`'s natural
// dimensions — this function only paints, it doesn't size the canvas, so
// the same painter works for both an on-screen <canvas> (MaskOverlay) and
// an offscreen one (renderInstancePreview).
export function drawInstanceLayers(
  ctx,
  {
    photoImg,
    maskImg = null,
    bbox = null,
    segmentation = null,
    opacities = { photo: 1, mask: 0.5, polygon: 0.35, bbox: 1 },
    bboxColor = '#D85A30',
    polygonColor = '#1D9E75',
  },
) {
  const canvas = ctx.canvas
  ctx.clearRect(0, 0, canvas.width, canvas.height)

  ctx.globalAlpha = opacities.photo
  ctx.drawImage(photoImg, 0, 0, canvas.width, canvas.height)
  ctx.globalAlpha = 1

  if (maskImg) {
    ctx.globalAlpha = opacities.mask
    ctx.drawImage(maskImg, 0, 0, canvas.width, canvas.height)
    ctx.globalAlpha = 1
  }

  let rle = null
  if (segmentation && isRLE(segmentation)) {
    try {
      rle = decodeCocoRLE(segmentation)
    } catch (e) {
      console.error('RLE decode failed:', e)
      rle = null
    }
  }

  if (rle) {
    const off = document.createElement('canvas')
    off.width = rle.width
    off.height = rle.height
    const octx = off.getContext('2d')
    const imgData = octx.createImageData(rle.width, rle.height)
    const [r, g, b] = hexToRgb(polygonColor)
    for (let i = 0; i < rle.data.length; i++) {
      if (rle.data[i]) {
        imgData.data[i * 4] = r
        imgData.data[i * 4 + 1] = g
        imgData.data[i * 4 + 2] = b
        imgData.data[i * 4 + 3] = 255
      }
    }
    octx.putImageData(imgData, 0, 0)
    ctx.globalAlpha = opacities.polygon
    ctx.drawImage(off, 0, 0, canvas.width, canvas.height)
    ctx.globalAlpha = 1
  } else if (Array.isArray(segmentation)) {
    ctx.globalAlpha = opacities.polygon
    ctx.fillStyle = polygonColor
    ctx.strokeStyle = polygonColor
    ctx.lineWidth = 2
    for (const poly of segmentation) {
      ctx.beginPath()
      for (let i = 0; i < poly.length; i += 2) {
        if (i === 0) ctx.moveTo(poly[i], poly[i + 1])
        else ctx.lineTo(poly[i], poly[i + 1])
      }
      ctx.closePath()
      ctx.fill()
      ctx.stroke()
    }
    ctx.globalAlpha = 1
  }

  if (bbox) {
    const [x, y, w, h] = bbox
    ctx.globalAlpha = opacities.bbox
    ctx.strokeStyle = bboxColor
    ctx.lineWidth = 2
    ctx.strokeRect(x, y, w, h)
    ctx.globalAlpha = 1
  }
}

export function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.crossOrigin = 'anonymous'
    img.onload = () => resolve(img)
    img.onerror = reject
    img.src = src
  })
}

export function hexToRgb(hex) {
  const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex)
  return m ? [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)] : [29, 158, 117]
}

// Flattens a photo + mask + segmentation + bbox into a single PNG blob —
// "here is exactly which instance failed, highlighted, on the full photo."
// Used by the redo export so a downloaded file is self-explanatory without
// opening the app, unlike a bare same-size raster mask file on its own.
export async function renderInstancePreview({
  photoBlob,
  maskBlob = null,
  bbox = null,
  segmentation = null,
  opacities = { photo: 1, mask: 0.5, polygon: 0.35, bbox: 1 },
  bboxColor = '#D85A30',
  polygonColor = '#1D9E75',
}) {
  const photoUrl = URL.createObjectURL(photoBlob)
  const maskUrl = maskBlob ? URL.createObjectURL(maskBlob) : null
  try {
    const photoImg = await loadImage(photoUrl)
    const maskImg = maskUrl ? await loadImage(maskUrl) : null

    const canvas = document.createElement('canvas')
    canvas.width = photoImg.naturalWidth
    canvas.height = photoImg.naturalHeight
    const ctx = canvas.getContext('2d')

    drawInstanceLayers(ctx, {
      photoImg,
      maskImg,
      bbox,
      segmentation,
      opacities,
      bboxColor,
      polygonColor,
    })

    return await new Promise((resolve, reject) => {
      canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('toBlob failed'))), 'image/png')
    })
  } finally {
    URL.revokeObjectURL(photoUrl)
    if (maskUrl) URL.revokeObjectURL(maskUrl)
  }
}
