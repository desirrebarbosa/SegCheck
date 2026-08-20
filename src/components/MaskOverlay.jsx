import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { getSignedUrl } from '../lib/storage'
import { decodeCocoRLE, isRLE } from '../lib/rle'

const MAX_HEIGHT_VH = 0.65 // container never taller than 65% of viewport height
const MAX_ZOOM = 4 // multiplier ON TOP of fit — i.e. 4x more zoomed in than fit

// Draws, layered on one canvas at native photo resolution:
//   1. the photo (opacity: opacities.photo)
//   2. the raster mask file, if one was matched (opacity: opacities.mask)
//   3. the segmentation — RLE (decoded here, verified against pycocotools)
//      or a plain polygon array — filled with polygonColor (opacity:
//      opacities.polygon)
//   4. the bbox rectangle, stroked with bboxColor (opacity: opacities.bbox)
//
// Sizing: `fitScale` is computed from the photo's natural dimensions vs the
// available container width and a max-height budget, so the container's
// rendered size actually matches the image's aspect ratio instead of a
// fixed box the image floats around in. `zoom` is a multiplier ON TOP of
// that fit — zoom=1 always means "fully visible, correctly proportioned",
// so zooming out below that is disallowed (there's nothing useful past
// fully-visible) and zooming in goes up to MAX_ZOOM beyond fit.
//
// Panning: once zoomed in beyond fit, drag (mouse or touch) to reposition.
// Zoom (scroll or +/- buttons) keeps whatever point is under the cursor (or
// the container center, for the buttons) fixed on screen.
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
  const wrapperRef = useRef(null) // outer, full-width element used to measure available space
  // `error` is fatal (no photo = nothing to review). `warning` is not: the
  // raster mask failing still leaves the photo, the RLE/polygon overlay
  // and the bbox, which is usually enough to make a call.
  const [error, setError] = useState(null)
  const [warning, setWarning] = useState(null)
  const [retryNonce, setRetryNonce] = useState(0)
  const [zoom, setZoom] = useState(1)
  const [pan, setPan] = useState({ x: 0, y: 0 })
  const [isDragging, setIsDragging] = useState(false)
  const [naturalSize, setNaturalSize] = useState(null) // { width, height } of the loaded photo
  const [availableWidth, setAvailableWidth] = useState(0)
  const dragRef = useRef(null)
  const imagesRef = useRef({ photo: null, mask: null })

  useEffect(() => {
    setZoom(1)
    setPan({ x: 0, y: 0 })
  }, [photoPath, maskPath])

  // Measure available width so fitScale reflects the actual layout, not a
  // guess — updates on window resize / sidebar toggles too.
  useLayoutEffect(() => {
    const el = wrapperRef.current
    if (!el) return
    const observer = new ResizeObserver((entries) => {
      setAvailableWidth(entries[0].contentRect.width)
    })
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  const fitScale = useMemo(() => {
    if (!naturalSize || availableWidth === 0) return 1
    const maxHeightPx = window.innerHeight * MAX_HEIGHT_VH
    const scale = Math.min(availableWidth / naturalSize.width, maxHeightPx / naturalSize.height, 1)
    return scale > 0 ? scale : 1
  }, [naturalSize, availableWidth])

  const baseWidth = naturalSize ? naturalSize.width * fitScale : 0
  const baseHeight = naturalSize ? naturalSize.height * fitScale : 0

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
      // Reset both every time. Without this a single bad file used to
      // stick: `error` was set but never cleared, so the component's
      // early-return kept showing that one failure for every subsequent
      // mask in the queue, and only a full page reload cleared it.
      setError(null)
      setWarning(null)
      try {
        let { photo, mask } = imagesRef.current
        if (!photo || photo.__path !== photoPath) {
          // Thrown, not wrapped: there's no underlying failure to report,
          // the row simply has no photo path.
          if (!photoPath) throw new Error('This mask has no photo on file.')
          try {
            photo = await loadImage(await getSignedUrl(photoPath))
            photo.__path = photoPath
          } catch (e) {
            throw new Error(`Couldn’t load the photo — ${e.message}`)
          }
        }
        if (maskPath && (!mask || mask.__path !== maskPath)) {
          // Non-fatal on purpose: fall through and draw everything else.
          try {
            mask = await loadImage(await getSignedUrl(maskPath))
            mask.__path = maskPath
          } catch (e) {
            mask = null
            if (alive) {
              setWarning(`Mask image unavailable — ${e.message} Showing the outline only.`)
            }
          }
        } else if (!maskPath) {
          mask = null
        }
        imagesRef.current = { photo, mask }
        if (!alive) return

        setNaturalSize({ width: photo.naturalWidth, height: photo.naturalHeight })

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
  }, [
    photoPath,
    maskPath,
    bbox,
    rle,
    segmentation,
    opacities,
    bboxColor,
    polygonColor,
    retryNonce,
  ])

  // Drops whatever was cached so a retry re-signs the URL and refetches,
  // rather than replaying the same failure against a stale entry. Also
  // covers the one genuinely recoverable case: a signed URL that expired
  // while the tab sat open (they last an hour).
  function retry() {
    imagesRef.current = { photo: null, mask: null }
    setRetryNonce((n) => n + 1)
  }

  // Keeps the photo from being dragged/zoomed fully out of view — allows
  // panning until the edge is `slack` px past the container edge, rather
  // than clamping tight to zero overlap. Uses baseWidth/baseHeight (the
  // fit-scaled size) rather than the canvas's raw pixel buffer size, since
  // those are no longer the same thing now that fitScale exists.
  function clampPan(panX, panY, z) {
    const container = containerRef.current
    if (!container || !naturalSize) return { x: panX, y: panY }
    const slack = 80
    const maxX = Math.max(0, (baseWidth * z - container.clientWidth) / 2) + slack
    const maxY = Math.max(0, (baseHeight * z - container.clientHeight) / 2) + slack
    return {
      x: Math.min(maxX, Math.max(-maxX, panX)),
      y: Math.min(maxY, Math.max(-maxY, panY)),
    }
  }

  // Zooms to `nextZoom` while keeping the point at (containerX, containerY)
  // — coordinates relative to the container's top-left — fixed on screen.
  function zoomTowardPoint(nextZoom, containerX, containerY) {
    const container = containerRef.current
    if (!container || !naturalSize) {
      setZoom(nextZoom)
      return
    }
    const boxCenterX = container.clientWidth / 2
    const boxCenterY = container.clientHeight / 2
    const localX = (containerX - boxCenterX - pan.x) / zoom + baseWidth / 2
    const localY = (containerY - boxCenterY - pan.y) / zoom + baseHeight / 2
    const nextPan = clampPan(
      containerX - boxCenterX - nextZoom * (localX - baseWidth / 2),
      containerY - boxCenterY - nextZoom * (localY - baseHeight / 2),
      nextZoom,
    )
    setZoom(nextZoom)
    setPan(nextPan)
  }

  function zoomBy(delta) {
    const container = containerRef.current
    // Minimum is 1 (= fully fit, nothing useful past that), not an
    // arbitrary small fraction — this is the actual fix for "there should
    // be a minimum to zooming out".
    const nextZoom = Math.min(MAX_ZOOM, Math.max(1, zoom + delta))
    zoomTowardPoint(nextZoom, container.clientWidth / 2, container.clientHeight / 2)
  }

  function resetView() {
    setZoom(1)
    setPan({ x: 0, y: 0 })
  }

  // Native (non-passive) wheel listener. React's onWheel prop is attached
  // as a passive listener, so calling preventDefault() inside it throws
  // "Unable to preventDefault inside passive event listener invocation" —
  // this is the actual fix, not just moving the same call elsewhere.
  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    function handleWheel(e) {
      e.preventDefault()
      const rect = el.getBoundingClientRect()
      const nextZoom = Math.min(MAX_ZOOM, Math.max(1, zoom - e.deltaY * 0.001))
      zoomTowardPoint(nextZoom, e.clientX - rect.left, e.clientY - rect.top)
    }
    el.addEventListener('wheel', handleWheel, { passive: false })
    return () => el.removeEventListener('wheel', handleWheel)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [zoom, pan, baseWidth, baseHeight])

  // Drag-to-pan — only active once zoomed in, since there's nothing to
  // reposition at fit. Uses pointer capture so dragging still tracks the
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
        zoom,
      ),
    )
  }

  function endDrag(e) {
    if (dragRef.current && dragRef.current.pointerId === e.pointerId) {
      dragRef.current = null
      setIsDragging(false)
    }
  }

  if (error) {
    return (
      <div className="rounded-lg border border-[#E5C4C4] bg-[#FCEBEB] p-4 text-sm">
        <p className="font-medium text-[#791F1F]">{error}</p>
        <p className="mt-1 text-xs text-[#791F1F]">
          Only this mask is affected — Skip moves to the next one.
        </p>
        <button
          onClick={retry}
          className="mt-3 rounded-lg border border-[#B4B2A9] bg-white px-3 py-1.5 text-xs hover:bg-[#F7F7F5]"
        >
          Try again
        </button>
      </div>
    )
  }

  return (
    <div ref={wrapperRef} className="flex w-full flex-col items-center gap-2">
      {warning && (
        <p className="w-full rounded-lg bg-[#FBF3E4] px-3 py-2 text-xs text-[#7A4F1D]">{warning}</p>
      )}
      <div
        ref={containerRef}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        className="relative overflow-hidden rounded-lg border border-[#E5E4DF] bg-[#F1EFE8]"
        style={{
          width: baseWidth || '100%',
          height: baseHeight || 320,
          cursor: zoom > 1 ? (isDragging ? 'grabbing' : 'grab') : 'default',
        }}
      >
        <div className="flex h-full w-full items-center justify-center">
          <canvas
            ref={canvasRef}
            style={{
              width: baseWidth,
              height: baseHeight,
              transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
              transformOrigin: 'center',
            }}
            className="touch-none"
          />
        </div>
      </div>

      {/* Zoom controls live BELOW the image, not overlaid on top of it —
          they were obstructing the actual content being reviewed. */}
      <div className="flex items-center gap-1 rounded-lg border border-[#E5E4DF] bg-white p-1">
        <button
          onClick={() => zoomBy(-0.25)}
          disabled={zoom <= 1}
          aria-label="Zoom out"
          className="flex h-7 w-7 items-center justify-center rounded-md hover:bg-[#F7F7F5] disabled:opacity-40"
        >
          <i className="ti ti-minus text-sm" aria-hidden="true"></i>
        </button>
        <button onClick={resetView} className="w-14 rounded-md px-2 text-xs hover:bg-[#F7F7F5]">
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
    // `onerror` hands back a DOM Event, which has no `.message` — passing
    // it straight to reject meant the UI rendered an empty error box and
    // told you nothing. The browser deliberately withholds the real cause
    // here (it's the same opaque event for a 404, a CORS rejection, and a
    // corrupt file), so name the realistic candidates instead.
    img.onerror = () =>
      reject(new Error('the file is missing, blocked by CORS, or not a valid image.'))
    img.src = src
  })
}

function hexToRgb(hex) {
  const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex)
  return m ? [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)] : [29, 158, 117]
}