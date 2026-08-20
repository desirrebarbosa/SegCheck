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

// The exact inverse of decodeCocoRLE: row-major mask -> COCO compressed
// RLE. `data` is one byte per pixel (0 background, non-zero foreground) in
// row-major order, the same shape decodeCocoRLE returns.
//
// Every step mirrors the decoder in reverse:
//   1. transpose row-major -> column-major (COCO counts run down columns)
//   2. run-length encode, ALWAYS starting with a background run — a mask
//      whose first pixel is foreground therefore opens with a 0-length
//      run, which is what pycocotools does too
//   3. delta each run against the one two slots back (the decoder's
//      `x += runs[runs.length - 2]`, undone)
//   4. pack each value into 5-bit groups, low bits first, with 0x20 as the
//      "more groups follow" flag and 0x10 as the sign bit of the final
//      group, then offset by 48 into printable ASCII
export function encodeCocoRLE(data, width, height) {
  if (data.length !== width * height) {
    throw new Error(`encodeCocoRLE: data length ${data.length} != ${width}x${height}`)
  }

  // Row-major (y*w + x) -> column-major (x*h + y).
  const colMajor = new Uint8Array(width * height)
  for (let x = 0; x < width; x++) {
    for (let y = 0; y < height; y++) {
      colMajor[x * height + y] = data[y * width + x] ? 1 : 0
    }
  }

  // Run lengths, alternating starting from background.
  const runs = []
  let current = 0
  let run = 0
  for (let i = 0; i < colMajor.length; i++) {
    if (colMajor[i] === current) {
      run++
    } else {
      runs.push(run)
      current = 1 - current
      run = 1
    }
  }
  runs.push(run)

  let out = ''
  for (let i = 0; i < runs.length; i++) {
    // Undo the decoder's accumulation against two slots back. The decoder
    // only applies it once more than two runs exist, so match that bound
    // exactly rather than approximating it.
    let x = runs[i]
    if (i > 2) x -= runs[i - 2]

    let more = true
    while (more) {
      let c = x & 0x1f
      x >>= 5
      // Continue if the remaining bits aren't just sign padding. 0x10 is
      // this group's sign bit: when it's set, an all-ones remainder is
      // still "negative and finished", not "more to come".
      more = c & 0x10 ? x !== -1 : x !== 0
      if (more) c |= 0x20
      out += String.fromCharCode(c + 48)
    }
  }

  return { size: [height, width], counts: out }
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