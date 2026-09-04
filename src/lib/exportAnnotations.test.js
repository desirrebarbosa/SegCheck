import { describe, it, expect } from 'vitest'
import {
  countArea,
  resolveJsonSegmentation,
  assembleCocoAnnotations,
  correctedAnnotationsFilename,
} from './exportAnnotations.js'
import { JODD_CLASSES } from './joddClasses.js'

describe('countArea', () => {
  it('counts non-zero entries', () => {
    expect(countArea(new Uint8Array([0, 1, 1, 0, 1]))).toBe(3)
  })

  it('is zero for an all-background mask', () => {
    expect(countArea(new Uint8Array([0, 0, 0]))).toBe(0)
  })
})

describe('resolveJsonSegmentation', () => {
  const rle = { size: [10, 10], counts: 'abc' }

  it('accepts a bare RLE object', () => {
    expect(resolveJsonSegmentation(rle)).toEqual(rle)
  })

  it('accepts an RLE nested under a segmentation key', () => {
    expect(resolveJsonSegmentation({ segmentation: rle, other: 'field' })).toEqual(rle)
  })

  it('rejects a polygon array — no pixel dimensions to rasterize against', () => {
    expect(resolveJsonSegmentation([1, 2, 3, 4, 5, 6])).toBeNull()
  })

  it('rejects a polygon nested under a segmentation key', () => {
    expect(resolveJsonSegmentation({ segmentation: [1, 2, 3, 4] })).toBeNull()
  })

  it('rejects garbage', () => {
    expect(resolveJsonSegmentation(null)).toBeNull()
    expect(resolveJsonSegmentation({})).toBeNull()
    expect(resolveJsonSegmentation('not an object')).toBeNull()
  })
})

describe('assembleCocoAnnotations', () => {
  const rle = { size: [100, 100], counts: 'xyz' }

  it('mints sequential image ids ordered by filename', () => {
    const { images } = assembleCocoAnnotations([
      {
        photoId: 'photo-b',
        photoFilename: 'b.jpg',
        category: 'shark',
        bbox: [0, 0, 1, 1],
        isCrowd: false,
        manifestMaskId: '2',
        segmentation: rle,
        area: 10,
        width: 100,
        height: 100,
      },
      {
        photoId: 'photo-a',
        photoFilename: 'a.jpg',
        category: 'fish',
        bbox: [0, 0, 1, 1],
        isCrowd: false,
        manifestMaskId: '1',
        segmentation: rle,
        area: 5,
        width: 100,
        height: 100,
      },
    ])

    expect(images).toEqual([
      { id: 1, file_name: 'a.jpg', width: 100, height: 100 },
      { id: 2, file_name: 'b.jpg', width: 100, height: 100 },
    ])
  })

  // photo_filename is stored verbatim from the original import's COCO
  // file_name, which may carry the dataset's own directory prefix (e.g.
  // "coco_valid_data/images/foo.jpg"). The exported file_name must always be
  // a bare basename so it matches the actual images/ folder a downstream
  // consumer unzips this JSON next to.
  it('strips any directory prefix from photoFilename in the emitted file_name', () => {
    const { images } = assembleCocoAnnotations([
      {
        photoId: 'photo-a',
        photoFilename: 'coco_valid_data/images/2K0263OUTUM108_117.jpg',
        category: 'fish',
        bbox: [0, 0, 1, 1],
        isCrowd: false,
        manifestMaskId: '1',
        segmentation: rle,
        area: 5,
        width: 100,
        height: 100,
      },
    ])

    expect(images).toEqual([{ id: 1, file_name: '2K0263OUTUM108_117.jpg', width: 100, height: 100 }])
  })

  it('always emits every JODD_CLASSES category in fixed order, regardless of which are present in instances', () => {
    const { categories } = assembleCocoAnnotations([
      {
        photoId: 'photo-b',
        photoFilename: 'b.jpg',
        category: 'shark',
        bbox: [0, 0, 1, 1],
        isCrowd: false,
        manifestMaskId: '2',
        segmentation: rle,
        area: 10,
        width: 100,
        height: 100,
      },
      {
        photoId: 'photo-a',
        photoFilename: 'a.jpg',
        category: 'fish',
        bbox: [0, 0, 1, 1],
        isCrowd: false,
        manifestMaskId: '1',
        segmentation: rle,
        area: 5,
        width: 100,
        height: 100,
      },
    ])

    expect(categories).toEqual(JODD_CLASSES.map((name, i) => ({ id: i + 1, name })))
    // canary: id is positional (JODD_CLASSES order), not alphabetical-among-what's-present —
    // 'shark' appears first in the instances array but must still sort after 'fish'.
    expect(categories.find((c) => c.name === 'fish').id).toBe(6)
    expect(categories.find((c) => c.name === 'shark').id).toBe(7)
  })

  it('builds annotation objects in the coco.json/seg_coco.json convention', () => {
    const { annotations } = assembleCocoAnnotations([
      {
        photoId: 'photo-a',
        photoFilename: 'a.jpg',
        category: 'fish',
        bbox: [1, 2, 3, 4],
        isCrowd: true,
        manifestMaskId: '500',
        segmentation: rle,
        area: 42,
        width: 100,
        height: 100,
      },
    ])

    expect(annotations).toEqual([
      {
        id: 500,
        image_id: 1,
        category_id: 6,
        bbox: [1, 2, 3, 4],
        area: 42,
        iscrowd: 1,
        segmentation: rle,
      },
    ])
  })

  it('keeps a non-numeric manifest id as a string rather than coercing to NaN', () => {
    const { annotations } = assembleCocoAnnotations([
      {
        photoId: 'photo-a',
        photoFilename: 'a.jpg',
        category: 'fish',
        bbox: [0, 0, 1, 1],
        isCrowd: false,
        manifestMaskId: 'not-numeric',
        segmentation: rle,
        area: 1,
        width: 100,
        height: 100,
      },
    ])
    expect(annotations[0].id).toBe('not-numeric')
  })

  it('dedupes photos by photoId, keeping the first-seen width/height', () => {
    const { images, annotations } = assembleCocoAnnotations([
      {
        photoId: 'photo-a',
        photoFilename: 'a.jpg',
        category: 'fish',
        bbox: [0, 0, 1, 1],
        isCrowd: false,
        manifestMaskId: '1',
        segmentation: rle,
        area: 1,
        width: 100,
        height: 100,
      },
      {
        photoId: 'photo-a',
        photoFilename: 'a.jpg',
        category: 'fish',
        bbox: [5, 5, 1, 1],
        isCrowd: false,
        manifestMaskId: '2',
        segmentation: rle,
        area: 1,
        width: 100,
        height: 100,
      },
    ])
    expect(images).toHaveLength(1)
    expect(annotations).toHaveLength(2)
    expect(annotations.every((a) => a.image_id === 1)).toBe(true)
  })

  it('falls back to "(uncategorized)" for a null category, appended after the known JODD_CLASSES', () => {
    const { categories, annotations } = assembleCocoAnnotations([
      {
        photoId: 'photo-a',
        photoFilename: 'a.jpg',
        category: null,
        bbox: [0, 0, 1, 1],
        isCrowd: false,
        manifestMaskId: '1',
        segmentation: rle,
        area: 1,
        width: 100,
        height: 100,
      },
    ])
    expect(categories).toEqual([
      ...JODD_CLASSES.map((name, i) => ({ id: i + 1, name })),
      { id: 21, name: '(uncategorized)' },
    ])
    expect(annotations[0].category_id).toBe(21)
  })

  it('dedupes and alphabetically sorts multiple unknown category names, appending them after the known 20', () => {
    const { categories } = assembleCocoAnnotations([
      {
        photoId: 'photo-a',
        photoFilename: 'a.jpg',
        category: 'zzz-typo',
        bbox: [0, 0, 1, 1],
        isCrowd: false,
        manifestMaskId: '1',
        segmentation: rle,
        area: 1,
        width: 100,
        height: 100,
      },
      {
        photoId: 'photo-a',
        photoFilename: 'a.jpg',
        category: 'aaa-typo',
        bbox: [0, 0, 1, 1],
        isCrowd: false,
        manifestMaskId: '2',
        segmentation: rle,
        area: 1,
        width: 100,
        height: 100,
      },
      {
        photoId: 'photo-a',
        photoFilename: 'a.jpg',
        category: 'aaa-typo',
        bbox: [0, 0, 1, 1],
        isCrowd: false,
        manifestMaskId: '3',
        segmentation: rle,
        area: 1,
        width: 100,
        height: 100,
      },
    ])
    expect(categories.slice(20)).toEqual([
      { id: 21, name: 'aaa-typo' },
      { id: 22, name: 'zzz-typo' },
    ])
  })
})

describe('correctedAnnotationsFilename', () => {
  it('follows the {split}_corrected_{date}.json convention', () => {
    expect(correctedAnnotationsFilename('val', new Date(2026, 8, 4))).toBe('val_corrected_2026-09-04.json')
  })

  it('labels the no-split bucket as "default"', () => {
    expect(correctedAnnotationsFilename('(no split)', new Date(2026, 0, 5))).toBe(
      'default_corrected_2026-01-05.json',
    )
  })
})
