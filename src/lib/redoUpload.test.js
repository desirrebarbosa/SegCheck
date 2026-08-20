import { describe, it, expect } from 'vitest'
import { parseRedoEntries, nextRedoPath } from './redoUpload'

// Only the pure halves are covered here. buildRedoUploadPlan and
// commitRedoUploadPlan both talk to Supabase, so they're exercised by the
// end-to-end pass described in the plan rather than mocked out — the
// parsing and path rules below are where the fiddly logic actually lives.

const entry = (relativePath) => ({ relativePath, name: relativePath.split('/').pop(), blob: null })

describe('parseRedoEntries', () => {
  it('pulls the annotation id from the leading segment', () => {
    const { masks } = parseRedoEntries([entry('masks/photo1.jpg/1234-instance.png')])
    expect(masks).toHaveLength(1)
    expect(masks[0].annotationId).toBe('1234')
  })

  it('accepts the exact shape the redo export produces, round-tripping it', () => {
    const { masks, ignored } = parseRedoEntries([
      entry('masks/DSC_0001.JPG/17-DSC_0001_mask_17.png'),
      entry('masks/DSC_0002.JPG/18-DSC_0002_mask_18.png'),
    ])
    expect(masks.map((m) => m.annotationId)).toEqual(['17', '18'])
    expect(ignored).toEqual([])
  })

  it('ignores the photos/ folder — redo upload is masks-only', () => {
    const { masks, ignored } = parseRedoEntries([
      entry('photos/DSC_0001.JPG'),
      entry('masks/DSC_0001.JPG/17-mask.png'),
    ])
    expect(masks).toHaveLength(1)
    expect(ignored).toEqual(['photos/DSC_0001.JPG'])
  })

  it('ignores instructions.csv and other loose files', () => {
    const { masks, ignored } = parseRedoEntries([
      entry('instructions.csv'),
      entry('notes.txt'),
    ])
    expect(masks).toEqual([])
    expect(ignored).toEqual(['instructions.csv', 'notes.txt'])
  })

  it('ignores a mask file with no leading annotation id', () => {
    // Renamed by hand in an editor — better to report it than to guess.
    const { masks, ignored } = parseRedoEntries([entry('masks/photo1.jpg/final-version.png')])
    expect(masks).toEqual([])
    expect(ignored).toEqual(['masks/photo1.jpg/final-version.png'])
  })

  it('ignores a mask sitting directly under masks/ with no photo folder', () => {
    const { masks, ignored } = parseRedoEntries([entry('masks/17-mask.png')])
    expect(masks).toEqual([])
    expect(ignored).toEqual(['masks/17-mask.png'])
  })

  it('requires digits, not just any prefix before the dash', () => {
    const { masks, ignored } = parseRedoEntries([entry('masks/p.jpg/abc-mask.png')])
    expect(masks).toEqual([])
    expect(ignored).toHaveLength(1)
  })

  it('falls back to name when relativePath is absent', () => {
    const { masks } = parseRedoEntries([
      { name: 'masks/photo1.jpg/99-mask.png', blob: null },
    ])
    expect(masks[0].annotationId).toBe('99')
  })
})

describe('nextRedoPath', () => {
  it('turns an original mask path into the first redo version', () => {
    expect(nextRedoPath('proj/train/masks/DSC_1/17-mask.png', '17')).toBe(
      'proj/train/masks/DSC_1/17-redo-1.png',
    )
  })

  it('increments an existing redo version rather than overwriting it', () => {
    expect(nextRedoPath('proj/train/masks/DSC_1/17-redo-1.png', '17')).toBe(
      'proj/train/masks/DSC_1/17-redo-2.png',
    )
    expect(nextRedoPath('proj/train/masks/DSC_1/17-redo-9.png', '17')).toBe(
      'proj/train/masks/DSC_1/17-redo-10.png',
    )
  })

  it('keeps the directory intact', () => {
    expect(nextRedoPath('a/b/c/5-x.png', '5').startsWith('a/b/c/')).toBe(true)
  })

  it('handles a path with no directory at all', () => {
    expect(nextRedoPath('5-x.png', '5')).toBe('5-redo-1.png')
  })
})
