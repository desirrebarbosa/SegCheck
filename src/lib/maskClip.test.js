import { describe, it, expect } from 'vitest'
import { clipForegroundOutsideBbox, isForegroundPixel } from './maskClip'

// Builds RGBA bytes from a grid of 0/1, where 1 is white (foreground) and
// 0 is black, both fully opaque — the shape a mask PNG normally has.
function rgbaFromGrid(grid) {
  const height = grid.length
  const width = grid[0].length
  const rgba = new Uint8ClampedArray(width * height * 4)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4
      const v = grid[y][x] ? 255 : 0
      rgba[i] = v
      rgba[i + 1] = v
      rgba[i + 2] = v
      rgba[i + 3] = 255
    }
  }
  return { rgba, width, height }
}

// Back to a 0/1 grid so assertions read as pictures rather than byte runs.
function gridFromRgba(rgba, width, height) {
  const grid = []
  for (let y = 0; y < height; y++) {
    const row = []
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4
      row.push(isForegroundPixel(rgba[i], rgba[i + 1], rgba[i + 2]) ? 1 : 0)
    }
    grid.push(row)
  }
  return grid
}

function clipGrid(grid, bbox) {
  const { rgba, width, height } = rgbaFromGrid(grid)
  clipForegroundOutsideBbox(rgba, width, height, bbox)
  return gridFromRgba(rgba, width, height)
}

describe('isForegroundPixel', () => {
  it('uses a halfway threshold on the channel average, not exact equality', () => {
    expect(isForegroundPixel(255, 255, 255)).toBe(true)
    expect(isForegroundPixel(0, 0, 0)).toBe(false)
    // Anti-aliased edges: near-white must still count as foreground, and
    // near-black must not. This is the whole reason for the threshold.
    expect(isForegroundPixel(250, 248, 252)).toBe(true)
    expect(isForegroundPixel(6, 4, 8)).toBe(false)
  })

  it('puts the boundary just above the midpoint', () => {
    expect(isForegroundPixel(128, 128, 128)).toBe(true)
    expect(isForegroundPixel(127, 127, 127)).toBe(false)
  })
})

describe('clipForegroundOutsideBbox', () => {
  // A 5x5 field of foreground, so anything surviving is purely the bbox.
  const full = [
    [1, 1, 1, 1, 1],
    [1, 1, 1, 1, 1],
    [1, 1, 1, 1, 1],
    [1, 1, 1, 1, 1],
    [1, 1, 1, 1, 1],
  ]

  it('keeps only what is inside a bbox fully within the image', () => {
    expect(clipGrid(full, [1, 1, 2, 2])).toEqual([
      [0, 0, 0, 0, 0],
      [0, 1, 1, 0, 0],
      [0, 1, 1, 0, 0],
      [0, 0, 0, 0, 0],
      [0, 0, 0, 0, 0],
    ])
  })

  it('treats the bbox as half-open: x + w is outside', () => {
    // [0,0,1,1] keeps exactly one pixel, not a 2x2 block.
    expect(clipGrid(full, [0, 0, 1, 1])[0]).toEqual([1, 0, 0, 0, 0])
  })

  it('clamps a bbox that extends past the image edges', () => {
    // Starts inside but runs well off the right/bottom — everything from
    // (3,3) on survives, and nothing errors.
    expect(clipGrid(full, [3, 3, 99, 99])).toEqual([
      [0, 0, 0, 0, 0],
      [0, 0, 0, 0, 0],
      [0, 0, 0, 0, 0],
      [0, 0, 0, 1, 1],
      [0, 0, 0, 1, 1],
    ])
  })

  it('clears everything when the bbox lies entirely outside the image', () => {
    expect(clipGrid(full, [20, 20, 5, 5])).toEqual([
      [0, 0, 0, 0, 0],
      [0, 0, 0, 0, 0],
      [0, 0, 0, 0, 0],
      [0, 0, 0, 0, 0],
      [0, 0, 0, 0, 0],
    ])
  })

  it('handles a bbox with negative origin by clamping to 0', () => {
    expect(clipGrid(full, [-2, -2, 4, 4])).toEqual([
      [1, 1, 0, 0, 0],
      [1, 1, 0, 0, 0],
      [0, 0, 0, 0, 0],
      [0, 0, 0, 0, 0],
      [0, 0, 0, 0, 0],
    ])
  })

  it('removes the stray pixels this exists for, keeping the real shape', () => {
    // The realistic case: a blob inside the bbox plus overshoot outside it.
    const bled = [
      [0, 0, 0, 0, 1],
      [0, 1, 1, 0, 0],
      [0, 1, 1, 0, 0],
      [1, 0, 0, 0, 0],
      [0, 0, 0, 0, 1],
    ]
    expect(clipGrid(bled, [1, 1, 2, 2])).toEqual([
      [0, 0, 0, 0, 0],
      [0, 1, 1, 0, 0],
      [0, 1, 1, 0, 0],
      [0, 0, 0, 0, 0],
      [0, 0, 0, 0, 0],
    ])
  })

  it('never turns a background pixel inside the bbox into foreground', () => {
    const holed = [
      [1, 1, 1],
      [1, 0, 1],
      [1, 1, 1],
    ]
    // The hole at the centre must stay a hole.
    expect(clipGrid(holed, [0, 0, 3, 3])).toEqual(holed)
  })

  it('leaves alpha untouched, including on pixels it clears', () => {
    const { rgba, width, height } = rgbaFromGrid([
      [1, 1],
      [1, 1],
    ])
    // Distinct alphas so a rewrite would be obvious.
    rgba[3] = 10
    rgba[7] = 90
    rgba[11] = 170
    rgba[15] = 250
    clipForegroundOutsideBbox(rgba, width, height, [0, 0, 1, 1])
    expect([rgba[3], rgba[7], rgba[11], rgba[15]]).toEqual([10, 90, 170, 250])
  })

  it('returns the same array it was given, mutated in place', () => {
    const { rgba, width, height } = rgbaFromGrid([[1]])
    expect(clipForegroundOutsideBbox(rgba, width, height, [5, 5, 1, 1])).toBe(rgba)
    expect(rgba[0]).toBe(0)
  })

  it('is a no-op when there is no bbox', () => {
    expect(clipGrid(full, null)).toEqual(full)
  })
})
