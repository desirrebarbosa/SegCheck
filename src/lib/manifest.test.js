import { describe, it, expect } from 'vitest'
import {
  parseManifest,
  buildUploadPlanForSplit,
  classifyOriginalZip,
  classifySamZip,
  buildMultiSplitUploadPlan,
} from './manifest.js'

function jsonEntry(relativePath, obj) {
  const name = relativePath.split('/').pop()
  return { name, relativePath, blob: { text: async () => JSON.stringify(obj) } }
}

function fileEntry(relativePath) {
  const name = relativePath.split('/').pop()
  return { name, relativePath, blob: `fake-bytes:${name}` }
}

describe('parseManifest', () => {
  it('groups annotations by image and resolves category names', () => {
    const manifest = {
      categories: [{ id: 1, name: 'fish' }],
      images: [{ id: 10, file_name: 'a.jpg', width: 100, height: 100 }],
      annotations: [
        { id: 500, image_id: 10, category_id: 1, bbox: [1, 2, 3, 4], mask_path: 'masks/500.png' },
      ],
    }
    const { photosByStem } = parseManifest(manifest)
    const entry = photosByStem.get('a')
    expect(entry.fileName).toBe('a.jpg')
    expect(entry.annotations).toHaveLength(1)
    expect(entry.annotations[0]).toMatchObject({
      annotationId: 500,
      category: 'fish',
      bbox: [1, 2, 3, 4],
      maskFileHint: 'masks/500.png',
    })
  })

  it('falls back to the annotation id as the mask hint when no mask_path exists', () => {
    const manifest = {
      categories: [],
      images: [{ id: 1, file_name: 'x.jpg' }],
      annotations: [{ id: 42, image_id: 1, category_id: 9 }],
    }
    const { photosByStem } = parseManifest(manifest)
    expect(photosByStem.get('x').annotations[0].maskFileHint).toBe('42')
  })
})

describe('buildUploadPlanForSplit', () => {
  const originalManifestJson = {
    categories: [{ id: 1, name: 'fish' }],
    images: [
      { id: 1, file_name: 'photo001.jpg' },
      { id: 2, file_name: 'photo002.jpg' }, // never uploaded
      { id: 3, file_name: 'background.jpg' }, // legit zero-object image
    ],
    annotations: [
      { id: 100, image_id: 1, category_id: 1, bbox: [1, 1, 2, 2] }, // matched
      { id: 101, image_id: 1, category_id: 1, bbox: [3, 3, 4, 4] }, // sam has no mask file
      { id: 102, image_id: 1, category_id: 1, bbox: [5, 5, 6, 6] }, // sam never has this id at all
      { id: 200, image_id: 2, category_id: 1, bbox: [0, 0, 1, 1] },
    ],
  }
  const samManifestJson = {
    categories: [{ id: 1, name: 'fish' }],
    images: [{ id: 1, file_name: 'photo001.jpg' }],
    annotations: [
      { id: 100, image_id: 1, category_id: 1, bbox: [1, 1, 2, 2], mask_path: 'masks/100.png' },
      { id: 101, image_id: 1, category_id: 1, bbox: [3, 3, 4, 4], mask_path: 'masks/101.png' }, // file missing on purpose
    ],
  }
  const photoFiles = [
    fileEntry('photo001.jpg'),
    fileEntry('background.jpg'),
    fileEntry('photo999.jpg'), // uploaded but not in original at all
  ]
  const maskFiles = [
    fileEntry('100.png'),
    fileEntry('orphan_555.png'), // matches no annotation
  ]

  const result = buildUploadPlanForSplit({
    photoFiles,
    maskFiles,
    originalManifestJson,
    samManifestJson,
  })

  it('matches an annotation to its mask file correctly', () => {
    const p1 = result.plan.find((p) => p.stem === 'photo001')
    const inst100 = p1.instances.find((i) => i.annotationId === 100)
    expect(inst100.missing).toBe(false)
    expect(inst100.mask).toBeTruthy()
  })

  it('auto-fails when the SAM annotation exists but its mask file is absent', () => {
    const p1 = result.plan.find((p) => p.stem === 'photo001')
    const inst101 = p1.instances.find((i) => i.annotationId === 101)
    expect(inst101.missing).toBe(true)
    expect(inst101.mask).toBeNull()
  })

  it('auto-fails when SAM never produced the annotation at all, keeping the original bbox as context', () => {
    const p1 = result.plan.find((p) => p.stem === 'photo001')
    const inst102 = p1.instances.find((i) => i.annotationId === 102)
    expect(inst102.missing).toBe(true)
    expect(inst102.bbox).toEqual([5, 5, 6, 6]) // fell back to original's bbox
  })

  it('treats a legitimate zero-annotation image as fine, not auto-failed', () => {
    const bg = result.plan.find((p) => p.stem === 'background')
    expect(bg.instances).toHaveLength(0)
    expect(bg.missingWhole).toBe(false)
  })

  it('flags a photo uploaded but absent from the original dataset as extra/out-of-scope', () => {
    expect(result.extraPhotosNotInOriginal.map((p) => p.stem)).toContain('photo999')
  })

  it('flags an original photo that was never uploaded', () => {
    expect(result.unmatchedOriginalPhotos.map((p) => p.stem)).toContain('photo002')
  })

  it('flags an uploaded mask file that matches no annotation', () => {
    expect(result.orphanMasks.map((m) => m.stem)).toContain('orphan_555')
  })

  it('does not count a used mask as orphaned', () => {
    expect(result.orphanMasks.map((m) => m.stem)).not.toContain('100')
  })
})

describe('buildUploadPlanForSplit — whole photo missing from SAM entirely', () => {
  it('marks missingWhole true only when the original expected objects and SAM has nothing', () => {
    const originalManifestJson = {
      categories: [],
      images: [{ id: 1, file_name: 'p.jpg' }],
      annotations: [{ id: 1, image_id: 1, category_id: 1, bbox: [0, 0, 1, 1] }],
    }
    const samManifestJson = { categories: [], images: [], annotations: [] }
    const result = buildUploadPlanForSplit({
      photoFiles: [fileEntry('p.jpg')],
      maskFiles: [],
      originalManifestJson,
      samManifestJson,
    })
    const p = result.plan[0]
    expect(p.missingWhole).toBe(true)
    expect(p.instances[0].missing).toBe(true)
  })
})

describe('classifyOriginalZip / classifySamZip', () => {
  it('groups entries by the split folder name', async () => {
    const entries = [
      fileEntry('jodd/val/images/a.jpg'),
      jsonEntry('jodd/val/annotations/coco.json', { images: [], annotations: [] }),
      fileEntry('jodd/train/images/b.jpg'),
      jsonEntry('jodd/train/annotations/coco.json', { images: [], annotations: [] }),
    ]
    const bySplit = await classifyOriginalZip(entries)
    expect([...bySplit.keys()].sort()).toEqual(['train', 'val'])
    expect(bySplit.get('val').photoFiles).toHaveLength(1)
  })

  it('throws a clear error when a split has no coco.json', async () => {
    const entries = [fileEntry('jodd/val/images/a.jpg')]
    await expect(classifyOriginalZip(entries)).rejects.toThrow(/coco\.json/)
  })

  it('throws a clear error when a split has no seg_coco.json', async () => {
    const entries = [fileEntry('jodd/val/masks/a.png')]
    await expect(classifySamZip(entries)).rejects.toThrow(/seg_coco\.json/)
  })
})

describe('buildMultiSplitUploadPlan', () => {
  it('processes splits present in both zips and reports mismatches instead of dropping them', async () => {
    const originalEntries = [
      fileEntry('jodd/val/images/a.jpg'),
      jsonEntry('jodd/val/annotations/coco.json', {
        images: [{ id: 1, file_name: 'a.jpg' }],
        annotations: [],
      }),
      fileEntry('jodd/onlyOriginal/images/z.jpg'),
      jsonEntry('jodd/onlyOriginal/annotations/coco.json', { images: [], annotations: [] }),
    ]
    const samEntries = [
      fileEntry('jodd/val/masks/dummy.png'),
      jsonEntry('jodd/val/annotations/seg_coco.json', { images: [], annotations: [] }),
      fileEntry('jodd/onlySam/masks/dummy.png'),
      jsonEntry('jodd/onlySam/annotations/seg_coco.json', { images: [], annotations: [] }),
    ]

    const result = await buildMultiSplitUploadPlan({ originalEntries, samEntries })

    expect([...result.bySplit.keys()]).toEqual(['val'])
    expect(result.splitsOnlyInOriginal).toEqual(['onlyOriginal'])
    expect(result.splitsOnlyInSam).toEqual(['onlySam'])
  })
})