import { describe, it, expect } from 'vitest'
import { decodeCocoRLE, isRLE } from './rle.js'

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