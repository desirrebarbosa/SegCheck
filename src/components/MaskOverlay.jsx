import { useEffect, useRef, useState } from 'react'
import { getSignedUrl } from '../lib/storage'

// Draws, layered on one canvas:
//   1. the photo
//   2. the raster mask file, if one was matched (50% alpha)
//   3. the segmentation polygon, filled + outlined (skipped for RLE/is_crowd
//      — RLE decoding isn't implemented, this dataset mostly won't use it)
//   4. the bbox rectangle
// Assumption (flagged, easy to change): all three of raster mask, polygon,
// and bbox are shown together so the reviewer has full context.
export default function MaskOverlay({ photoPath, maskPath, bbox, segmentation, isCrowd }) {
  const canvasRef = useRef(null)
  const [error, setError] = useState(null)

  useEffect(() => {
    let alive = true

    async function draw() {
      try {
        const photoUrl = await getSignedUrl(photoPath)
        const maskUrl = maskPath ? await getSignedUrl(maskPath) : null
        const [photoImg, maskImg] = await Promise.all([
          loadImage(photoUrl),
          maskUrl ? loadImage(maskUrl) : Promise.resolve(null),
        ])
        if (!alive) return

        const canvas = canvasRef.current
        const ctx = canvas.getContext('2d')
        canvas.width = photoImg.naturalWidth
        canvas.height = photoImg.naturalHeight
        ctx.clearRect(0, 0, canvas.width, canvas.height)
        ctx.drawImage(photoImg, 0, 0)

        if (maskImg) {
          ctx.globalAlpha = 0.5
          ctx.drawImage(maskImg, 0, 0, canvas.width, canvas.height)
          ctx.globalAlpha = 1
        }

        if (!isCrowd && Array.isArray(segmentation)) {
          ctx.strokeStyle = '#22d3ee'
          ctx.lineWidth = 2
          ctx.fillStyle = 'rgba(34, 211, 238, 0.18)'
          for (const poly of segmentation) {
            ctx.beginPath()
            for (let i = 0; i < poly.length; i += 2) {
              const x = poly[i]
              const y = poly[i + 1]
              if (i === 0) ctx.moveTo(x, y)
              else ctx.lineTo(x, y)
            }
            ctx.closePath()
            ctx.fill()
            ctx.stroke()
          }
        }

        if (bbox) {
          const [x, y, w, h] = bbox
          ctx.strokeStyle = '#f43f5e'
          ctx.lineWidth = 2
          ctx.strokeRect(x, y, w, h)
        }
      } catch (e) {
        if (alive) setError(e.message)
      }
    }

    draw()
    return () => {
      alive = false
    }
  }, [photoPath, maskPath, bbox, segmentation, isCrowd])

  if (error) return <p className="text-sm text-rose-600">{error}</p>
  return <canvas ref={canvasRef} className="max-h-[65vh] w-auto rounded border border-slate-200" />
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