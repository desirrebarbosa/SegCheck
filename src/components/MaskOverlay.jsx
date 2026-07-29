import { useEffect, useMemo, useRef, useState } from 'react'
import { getSignedUrl } from '../lib/storage'
import { decodeCocoRLE, isRLE } from '../lib/rle'

// Draws, layered on one canvas at native photo resolution:
//   1. the photo (opacity: opacities.photo)
//   2. the raster mask file, if one was matched (opacity: opacities.mask)
//   3. the segmentation — RLE (decoded here, verified against pycocotools)
//      or a plain polygon array — filled with polygonColor (opacity:
//      opacities.polygon)
//   4. the bbox rectangle, stroked with bboxColor (opacity: opacities.bbox)
// Zoom: scroll to zoom (matches CVAT's own convention), buttons as a
// fallback for trackpads/mobile. Resets to 100% on a new mask.
export default function MaskOverlay({
  photoPath,
  maskPath,
  bbox,
  segmentation,
  opacities = { photo: 1, mask: 0.5, polygon: 0.35, bbox: 1 },
  bboxColor = '#D85A30',
  polygonColor = '#1D9E75',
}) {
  const canvasRef = useRef(null)
  const [error, setError] = useState(null)
  const [zoom, setZoom] = useState(1)
  const imagesRef = useRef({ photo: null, mask: null })

  useEffect(() => {
    setZoom(1)
  }, [photoPath, maskPath])

  const rle = useMemo(() => {
    if (!segmentation || !isRLE(segmentation)) return null
    try {
      return decodeCocoRLE(segmentation)
    } catch (e) {
      console.error('RLE decode failed:', e)
      return null
    }
  }, [segmentation])

  useEffect(() => {
    let alive = true

    async function draw() {
      try {
        let { photo, mask } = imagesRef.current
        if (!photo || photo.__path !== photoPath) {
          const url = await getSignedUrl(photoPath)
          photo = await loadImage(url)
          photo.__path = photoPath
        }
        if (maskPath && (!mask || mask.__path !== maskPath)) {
          const url = await getSignedUrl(maskPath)
          mask = await loadImage(url)
          mask.__path = maskPath
        } else if (!maskPath) {
          mask = null
        }
        imagesRef.current = { photo, mask }
        if (!alive) return

        const canvas = canvasRef.current
        const ctx = canvas.getContext('2d')
        canvas.width = photo.naturalWidth
        canvas.height = photo.naturalHeight
        ctx.clearRect(0, 0, canvas.width, canvas.height)

        ctx.globalAlpha = opacities.photo
        ctx.drawImage(photo, 0, 0)
        ctx.globalAlpha = 1

        if (mask) {
          ctx.globalAlpha = opacities.mask
          ctx.drawImage(mask, 0, 0, canvas.width, canvas.height)
          ctx.globalAlpha = 1
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
      } catch (e) {
        if (alive) setError(e.message)
      }
    }

    draw()
    return () => {
      alive = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [photoPath, maskPath, bbox, rle, segmentation, opacities, bboxColor, polygonColor])

  function onWheel(e) {
    e.preventDefault()
    setZoom((z) => Math.min(4, Math.max(0.5, z - e.deltaY * 0.001)))
  }

  if (error) return <p className="text-sm text-[#791F1F]">{error}</p>

  return (
    <div
      onWheel={onWheel}
      className="relative overflow-auto rounded-lg border border-[#E5E4DF] bg-[#F1EFE8]"
      style={{ height: '60vh' }}
    >
      <div className="flex min-h-full items-center justify-center p-2">
        <canvas
          ref={canvasRef}
          style={{ transform: `scale(${zoom})`, transformOrigin: 'center' }}
          className="max-w-none"
        />
      </div>
      <div className="absolute bottom-2 right-2 flex gap-1 rounded-lg border border-[#E5E4DF] bg-white p-1">
        <button
          onClick={() => setZoom((z) => Math.max(0.5, z - 0.25))}
          aria-label="Zoom out"
          className="flex h-7 w-7 items-center justify-center rounded-md hover:bg-[#F7F7F5]"
        >
          <i className="ti ti-minus text-sm" aria-hidden="true"></i>
        </button>
        <button onClick={() => setZoom(1)} className="rounded-md px-2 text-xs hover:bg-[#F7F7F5]">
          {Math.round(zoom * 100)}%
        </button>
        <button
          onClick={() => setZoom((z) => Math.min(4, z + 0.25))}
          aria-label="Zoom in"
          className="flex h-7 w-7 items-center justify-center rounded-md hover:bg-[#F7F7F5]"
        >
          <i className="ti ti-plus text-sm" aria-hidden="true"></i>
        </button>
      </div>
    </div>
  )
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.crossOrigin = 'anonymous'
    img.onload = () => resolve(img)
    img.onerror = reject
    img.src = src
  })
}

function hexToRgb(hex) {
  const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex)
  return m ? [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)] : [29, 158, 117]
}