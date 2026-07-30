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
// fallback for trackpads/mobile. Zooming keeps whatever point is under the
// cursor (or the container center, for the +/- buttons) fixed on screen,
// instead of always expanding from a static center. Once zoomed in, drag
// (mouse or touch) to pan/focus on a different part of the photo. Resets
// to 100% + centered on a new mask.
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
  const containerRef = useRef(null)
  const [error, setError] = useState(null)
  const [zoom, setZoom] = useState(1)
  const [pan, setPan] = useState({ x: 0, y: 0 })
  const [isDragging, setIsDragging] = useState(false)
  const dragRef = useRef(null)
  const imagesRef = useRef({ photo: null, mask: null })

  useEffect(() => {
    setZoom(1)
    setPan({ x: 0, y: 0 })
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

  // Keeps the photo from being dragged/zoomed fully out of view — allows
  // panning until the edge is `slack` px past the container edge, rather
  // than clamping tight to zero overlap.
  function clampPan(panX, panY, z) {
    const canvas = canvasRef.current
    const container = containerRef.current
    if (!canvas || !container) return { x: panX, y: panY }
    const slack = 80
    const maxX = Math.max(0, (canvas.width * z - container.clientWidth) / 2) + slack
    const maxY = Math.max(0, (canvas.height * z - container.clientHeight) / 2) + slack
    return {
      x: Math.min(maxX, Math.max(-maxX, panX)),
      y: Math.min(maxY, Math.max(-maxY, panY)),
    }
  }

  // Zooms to `nextZoom` while keeping the point at (containerX, containerY)
  // — coordinates relative to the container's top-left — fixed on screen.
  // The canvas is centered in the container at pan (0,0), so its center
  // (pre-pan) is always the container's own center.
  function zoomTowardPoint(nextZoom, containerX, containerY) {
    const canvas = canvasRef.current
    const container = containerRef.current
    if (!canvas || !container) {
      setZoom(nextZoom)
      return
    }
    const boxCenterX = container.clientWidth / 2
    const boxCenterY = container.clientHeight / 2
    const nativeX = (containerX - boxCenterX - pan.x) / zoom + canvas.width / 2
    const nativeY = (containerY - boxCenterY - pan.y) / zoom + canvas.height / 2
    const nextPan = clampPan(
      containerX - boxCenterX - nextZoom * (nativeX - canvas.width / 2),
      containerY - boxCenterY - nextZoom * (nativeY - canvas.height / 2),
      nextZoom
    )
    setZoom(nextZoom)
    setPan(nextPan)
  }

  function zoomBy(delta) {
    const container = containerRef.current
    const nextZoom = Math.min(4, Math.max(0.5, zoom + delta))
    zoomTowardPoint(nextZoom, container.clientWidth / 2, container.clientHeight / 2)
  }

  function resetView() {
    setZoom(1)
    setPan({ x: 0, y: 0 })
  }

  function onWheel(e) {
    e.preventDefault()
    const rect = containerRef.current.getBoundingClientRect()
    const nextZoom = Math.min(4, Math.max(0.5, zoom - e.deltaY * 0.001))
    zoomTowardPoint(nextZoom, e.clientX - rect.left, e.clientY - rect.top)
  }

  // Drag-to-pan — only active once zoomed in, since there's nothing to
  // reposition at 100%. Uses pointer capture so dragging still tracks the
  // photo even if the cursor leaves the container mid-drag.
  function onPointerDown(e) {
    if (zoom <= 1) return
    e.currentTarget.setPointerCapture(e.pointerId)
    dragRef.current = {
      pointerId: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      startPanX: pan.x,
      startPanY: pan.y,
    }
    setIsDragging(true)
  }

  function onPointerMove(e) {
    const drag = dragRef.current
    if (!drag || drag.pointerId !== e.pointerId) return
    setPan(
      clampPan(
        drag.startPanX + (e.clientX - drag.startX),
        drag.startPanY + (e.clientY - drag.startY),
        zoom
      )
    )
  }

  function endDrag(e) {
    if (dragRef.current && dragRef.current.pointerId === e.pointerId) {
      dragRef.current = null
      setIsDragging(false)
    }
  }

  if (error) return <p className="text-sm text-[#791F1F]">{error}</p>

  return (
    <div
      ref={containerRef}
      onWheel={onWheel}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      className="relative overflow-hidden rounded-lg border border-[#E5E4DF] bg-[#F1EFE8]"
      style={{ height: '60vh', cursor: zoom > 1 ? (isDragging ? 'grabbing' : 'grab') : 'default' }}
    >
      <div className="flex h-full w-full items-center justify-center p-2">
        <canvas
          ref={canvasRef}
          style={{
            transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
            transformOrigin: 'center',
          }}
          className="max-w-none touch-none"
        />
      </div>
      <div className="absolute bottom-2 right-2 flex gap-1 rounded-lg border border-[#E5E4DF] bg-white p-1">
        <button
          onClick={() => zoomBy(-0.25)}
          aria-label="Zoom out"
          className="flex h-7 w-7 items-center justify-center rounded-md hover:bg-[#F7F7F5]"
        >
          <i className="ti ti-minus text-sm" aria-hidden="true"></i>
        </button>
        <button onClick={resetView} className="rounded-md px-2 text-xs hover:bg-[#F7F7F5]">
          {Math.round(zoom * 100)}%
        </button>
        <button
          onClick={() => zoomBy(0.25)}
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