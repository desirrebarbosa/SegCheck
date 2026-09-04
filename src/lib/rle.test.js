import { describe, it, expect } from 'vitest'
import { decodeCocoRLE, encodeCocoRLE, isRLE } from './rle.js'

// Fixture generated via Python's pycocotools (the reference implementation),
// for a 6x6 mask with a 3x2 filled rectangle at rows 2-3, cols 1-3:
//   [[0,0,0,0,0,0],
//    [0,0,0,0,0,0],
//    [0,1,1,1,0,0],
//    [0,1,1,1,0,0],
//    [0,0,0,0,0,0],
//    [0,0,0,0,0,0]]
const FIXTURE = { size: [6, 6], counts: '824000:' }

describe('decodeCocoRLE', () => {
  it('matches the pycocotools reference decode exactly', () => {
    const { width, height, data } = decodeCocoRLE(FIXTURE)
    expect(width).toBe(6)
    expect(height).toBe(6)

    const expected = [
      0, 0, 0, 0, 0, 0,
      0, 0, 0, 0, 0, 0,
      0, 1, 1, 1, 0, 0,
      0, 1, 1, 1, 0, 0,
      0, 0, 0, 0, 0, 0,
      0, 0, 0, 0, 0, 0,
    ]
    expect(Array.from(data)).toEqual(expected)
  })

  it('sums to the expected foreground pixel count', () => {
    const { data } = decodeCocoRLE(FIXTURE)
    const sum = data.reduce((a, b) => a + b, 0)
    expect(sum).toBe(6)
  })
})

describe('encodeCocoRLE', () => {
  // The bar that matters: re-encoding the pycocotools-generated fixture
  // has to reproduce it BYTE FOR BYTE. Round-tripping through our own
  // decoder only proves the two agree with each other — an encoder can be
  // perfectly self-consistent and still emit something pycocotools reads
  // differently. Matching the reference string rules that out.
  it('re-encodes the pycocotools fixture byte-for-byte', () => {
    const { width, height, data } = decodeCocoRLE(FIXTURE)
    expect(encodeCocoRLE(data, width, height)).toEqual(FIXTURE)
  })

  // Helper: build a row-major mask from a 2D array of 0/1 rows.
  const fromRows = (rows) => ({
    data: Uint8Array.from(rows.flat()),
    width: rows[0].length,
    height: rows.length,
  })

  const roundTrips = (rows) => {
    const { data, width, height } = fromRows(rows)
    const encoded = encodeCocoRLE(data, width, height)
    const decoded = decodeCocoRLE(encoded)
    expect(decoded.width).toBe(width)
    expect(decoded.height).toBe(height)
    expect(Array.from(decoded.data)).toEqual(Array.from(data))
    return encoded
  }

  it('handles an all-background mask', () => {
    roundTrips([
      [0, 0, 0],
      [0, 0, 0],
    ])
  })

  it('handles an all-foreground mask', () => {
    // Opens with a zero-length background run, per the COCO convention.
    roundTrips([
      [1, 1, 1],
      [1, 1, 1],
    ])
  })

  it('handles single-pixel-wide runs', () => {
    roundTrips([
      [1, 0, 1, 0],
      [0, 1, 0, 1],
      [1, 0, 1, 0],
    ])
  })

  it('handles a single foreground pixel in a corner', () => {
    roundTrips([
      [1, 0],
      [0, 0],
    ])
    roundTrips([
      [0, 0],
      [0, 1],
    ])
  })

  it('handles an irregular shape with runs long enough to need multiple 5-bit groups', () => {
    // 40x40 circle: runs well past 31, so this exercises the
    // continuation-bit path rather than only single-group values.
    const size = 40
    const rows = []
    for (let y = 0; y < size; y++) {
      const row = []
      for (let x = 0; x < size; x++) {
        const dx = x - 19.5
        const dy = y - 19.5
        row.push(dx * dx + dy * dy <= 15 * 15 ? 1 : 0)
      }
      rows.push(row)
    }
    const encoded = roundTrips(rows)
    // Sanity: a real shape, not an accidentally-empty one.
    expect(decodeCocoRLE(encoded).data.reduce((a, b) => a + b, 0)).toBeGreaterThan(600)
  })

  it('handles a non-square mask (width and height not interchangeable)', () => {
    roundTrips([
      [0, 1, 1, 0, 0, 1],
      [1, 1, 0, 0, 1, 0],
    ])
  })

  it('rejects data whose length does not match the dimensions', () => {
    expect(() => encodeCocoRLE(new Uint8Array(5), 3, 3)).toThrow(/length/)
  })

  it('treats any non-zero byte as foreground', () => {
    const encoded = encodeCocoRLE(Uint8Array.from([255, 0, 7, 0]), 2, 2)
    expect(Array.from(decodeCocoRLE(encoded).data)).toEqual([1, 0, 1, 0])
  })
})

describe('isRLE', () => {
  it('identifies a real RLE object', () => {
    expect(isRLE({ size: [6, 6], counts: '824000:' })).toBe(true)
  })

  it('rejects a polygon array', () => {
    expect(isRLE([[1, 2, 3, 4, 5, 6, 7, 8]])).toBe(false)
  })

  it('rejects null/undefined', () => {
    expect(isRLE(null)).toBe(false)
    expect(isRLE(undefined)).toBe(false)
  })

  it('rejects an object without a string counts field', () => {
    expect(isRLE({ size: [6, 6], counts: [1, 2, 3] })).toBe(false)
  })
})