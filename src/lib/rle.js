// Decodes COCO's *compressed* RLE segmentation format — confirmed against
// your real seg_coco.json: segmentation.counts is a string (not a plain
// integer array), e.g. "[\\U24R;3M3M3@?L4N2..." — this is the same
// variable-length, 5-bit-chunk encoding pycocotools uses.
//
// Algorithm: each run-length is packed as a sequence of 5-bit groups
// (ASCII code minus 48), continuation flagged by bit 0x20, sign-extended
// via bit 0x10 on the final group, then delta-summed against the value two
// slots back (matches the reference decoder's accumulation scheme). Once
// unpacked, run-lengths alternate background/foreground starting with
// background, filled in column-major order per the COCO spec, then
// transposed here to row-major for direct canvas use.
export function decodeCocoRLE(segmentation) {
  const { size, counts } = segmentation
  const [h, w] = size

  const runs = []
  let p = 0
  while (p < counts.length) {
    let x = 0
    let k = 0
    let more = 1
    while (more) {
      const c = counts.charCodeAt(p) - 48
      x |= (c & 0x1f) << (5 * k)
      more = c & 0x20
      p++
      k++
      if (!more && c & 0x10) {
        x |= -1 << (5 * k)
      }
    }
    if (runs.length > 2) x += runs[runs.length - 2]
    runs.push(x)
  }

  // Fill column-major (Fortran order), alternating 0/1 starting at 0.
  const colMajor = new Uint8Array(h * w)
  let idx = 0
  let val = 0
  for (const run of runs) {
    for (let i = 0; i < run && idx < colMajor.length; i++) {
      colMajor[idx++] = val
    }
    val = 1 - val
  }

  // Transpose to row-major (index = y*w + x) for canvas ImageData.
  const rowMajor = new Uint8Array(h * w)
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) {
      rowMajor[y * w + x] = colMajor[x * h + y]
    }
  }

  return { width: w, height: h, data: rowMajor }
}

// True if this looks like a COCO RLE object (as opposed to a polygon array).
export function isRLE(segmentation) {
  return (
    !!segmentation &&
    !Array.isArray(segmentation) &&
    typeof segmentation === 'object' &&
    typeof segmentation.counts === 'string' &&
    Array.isArray(segmentation.size)
  )
}