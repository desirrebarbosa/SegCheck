// Parses and cross-references the two upload zips:
//   ORIGINAL dataset  — <split>/images/... + <split>/annotations/coco.json
//     The source of truth for which photos and object instances are
//     expected to exist. No masks, no real segmentation (bbox-only).
//   SAM-ASSISTED dataset — <split>/masks/... + <split>/annotations/seg_coco.json
//     Provides the actual reviewable masks. May or may not redundantly
//     include images/ — only the original zip's images are used as photos.
//
// Verified against real data (val.zip): annotation `id`s are IDENTICAL
// between coco.json and seg_coco.json for the same object (seg_coco.json is
// coco.json with segmentation/mask_path added, not independently
// regenerated), so cross-referencing by annotation id is exact, not a
// heuristic.

function stem(path) {
  const base = String(path).split(/[\\/]/).pop()
  return base.replace(/\.[^.]+$/, '')
}

function inFolder(relativePath, folderName) {
  const parts = String(relativePath).split(/[\\/]/)
  return parts.slice(0, -1).includes(folderName)
}

// The split name is whatever folder directly contains `folderName` — e.g.
// for inFolder path "jodd/val/images/foo.jpg" with folderName "images",
// the split is "val". Works for any split naming, not just test/train/val.
function splitNameFromPath(relativePath, folderName) {
  const parts = String(relativePath).split(/[\\/]/)
  const idx = parts.lastIndexOf(folderName)
  return idx > 0 ? parts[idx - 1] : 'default'
}

// Parse one manifest (coco.json OR seg_coco.json — same shape) into lookups
// keyed by photo filename stem.
export function parseManifest(manifestJson) {
  const categoriesById = new Map((manifestJson.categories ?? []).map((c) => [c.id, c.name]))

  const annsByImageId = new Map()
  for (const a of manifestJson.annotations ?? []) {
    if (!annsByImageId.has(a.image_id)) annsByImageId.set(a.image_id, [])
    annsByImageId.get(a.image_id).push(a)
  }

  const photosByStem = new Map()
  for (const img of manifestJson.images ?? []) {
    const photoStem = stem(img.file_name)
    const annotations = (annsByImageId.get(img.id) ?? []).map((a) => ({
      annotationId: a.id,
      category: categoriesById.get(a.category_id) ?? String(a.category_id ?? ''),
      bbox: a.bbox ?? null,
      segmentation: a.segmentation ?? null,
      isCrowd: !!a.iscrowd,
      maskFileHint: a.mask_path ?? a.mask_file ?? a.file_name ?? String(a.id),
    }))
    photosByStem.set(photoStem, {
      fileName: img.file_name,
      width: img.width,
      height: img.height,
      annotations,
    })
  }

  return { photosByStem, categoriesById }
}

// Groups the ORIGINAL zip's entries by split: { photoFiles, originalManifestJson }
export async function classifyOriginalZip(entries) {
  const bySplit = new Map()
  const ensure = (split) => {
    if (!bySplit.has(split)) bySplit.set(split, { photoFiles: [], manifestEntry: null })
    return bySplit.get(split)
  }

  for (const e of entries) {
    if (inFolder(e.relativePath, 'images')) {
      ensure(splitNameFromPath(e.relativePath, 'images')).photoFiles.push({ ...e, file: e.blob })
    } else if (e.name === 'coco.json') {
      ensure(splitNameFromPath(e.relativePath, 'annotations')).manifestEntry = e
    }
  }

  const result = new Map()
  for (const [split, { photoFiles, manifestEntry }] of bySplit) {
    if (!manifestEntry) {
      throw new Error(`Original dataset, split "${split}": no annotations/coco.json found.`)
    }
    result.set(split, {
      photoFiles,
      originalManifestJson: JSON.parse(await manifestEntry.blob.text()),
    })
  }
  return result
}

// Groups the SAM-ASSISTED zip's entries by split: { maskFiles, samManifestJson }
export async function classifySamZip(entries) {
  const bySplit = new Map()
  const ensure = (split) => {
    if (!bySplit.has(split)) bySplit.set(split, { maskFiles: [], manifestEntry: null })
    return bySplit.get(split)
  }

  for (const e of entries) {
    if (inFolder(e.relativePath, 'masks')) {
      ensure(splitNameFromPath(e.relativePath, 'masks')).maskFiles.push({ ...e, file: e.blob })
    } else if (e.name === 'seg_coco.json') {
      ensure(splitNameFromPath(e.relativePath, 'annotations')).manifestEntry = e
    }
  }

  const result = new Map()
  for (const [split, { maskFiles, manifestEntry }] of bySplit) {
    if (!manifestEntry) {
      throw new Error(`SAM-assisted dataset, split "${split}": no annotations/seg_coco.json found.`)
    }
    result.set(split, {
      maskFiles,
      samManifestJson: JSON.parse(await manifestEntry.blob.text()),
    })
  }
  return result
}

// Builds the plan for ONE split: cross-checks the original's annotations
// (source of truth) against the SAM-assisted annotations by exact id match.
//   - id missing from SAM entirely -> auto-fail, original bbox kept as context
//   - id present but its mask_path file wasn't uploaded -> auto-fail
//   - id present with a resolved mask file -> pending review
// A photo in the original with a shortfall between what's expected and what
// SAM has (either scenario above) never silently drops the object — it
// always becomes a `missing: true` instance so it surfaces in the redo batch.
export function buildUploadPlanForSplit({
  photoFiles = [],
  maskFiles = [],
  originalManifestJson,
  samManifestJson,
}) {
  const { photosByStem: originalByStem } = parseManifest(originalManifestJson)
  const { photosByStem: samByStem } = parseManifest(samManifestJson)

  const masksByStem = new Map()
  for (const f of maskFiles) masksByStem.set(stem(f.relativePath ?? f.name), f)
  const usedMaskStems = new Set()

  const plan = []
  const seenPhotoStems = new Set()
  const extraPhotosNotInOriginal = []

  for (const f of photoFiles) {
    const photoStem = stem(f.relativePath ?? f.name)
    seenPhotoStems.add(photoStem)
    const originalEntry = originalByStem.get(photoStem)

    if (!originalEntry) {
      // Not part of the source-of-truth dataset at all — out of scope.
      extraPhotosNotInOriginal.push({ stem: photoStem, name: f.name })
      continue
    }

    const samEntry = samByStem.get(photoStem)
    const samAnnotationsById = new Map(
      (samEntry?.annotations ?? []).map((a) => [a.annotationId, a]),
    )

    const instances = originalEntry.annotations.map((origAnn) => {
      const samAnn = samAnnotationsById.get(origAnn.annotationId)
      const mask = samAnn ? (masksByStem.get(stem(samAnn.maskFileHint)) ?? null) : null
      if (mask && samAnn) usedMaskStems.add(stem(samAnn.maskFileHint))
      return {
        annotationId: origAnn.annotationId,
        category: samAnn?.category ?? origAnn.category,
        bbox: samAnn?.bbox ?? origAnn.bbox,
        segmentation: samAnn?.segmentation ?? null,
        isCrowd: samAnn?.isCrowd ?? origAnn.isCrowd,
        mask,
        missing: !samAnn || !mask,
      }
    })

    plan.push({
      stem: photoStem,
      photo: f,
      instances,
      // Original expected objects here, but the SAM-assisted output has
      // nothing for this photo at all (as opposed to a legitimate
      // zero-object background image, where instances is just empty).
      missingWhole: !samEntry && instances.length > 0,
    })
  }

  const unmatchedOriginalPhotos = [...originalByStem.entries()]
    .filter(([s]) => !seenPhotoStems.has(s))
    .map(([s, entry]) => ({ stem: s, fileName: entry.fileName }))

  const orphanMasks = [...masksByStem.entries()]
    .filter(([s]) => !usedMaskStems.has(s))
    .map(([s, f]) => ({ stem: s, name: f.name }))

  return { plan, unmatchedOriginalPhotos, orphanMasks, extraPhotosNotInOriginal }
}

// Top-level entry point: both zips' entries in, one plan per split out.
// Only splits present in BOTH zips are processed; a split found in only one
// is reported rather than silently skipped, since that usually means a
// naming mismatch (e.g. "val" vs "validation") worth catching immediately.
export async function buildMultiSplitUploadPlan({ originalEntries, samEntries }) {
  const originalBySplit = await classifyOriginalZip(originalEntries)
  const samBySplit = await classifySamZip(samEntries)

  const allSplits = new Set([...originalBySplit.keys(), ...samBySplit.keys()])
  const bySplit = new Map()
  const splitsOnlyInOriginal = []
  const splitsOnlyInSam = []

  for (const split of allSplits) {
    const orig = originalBySplit.get(split)
    const sam = samBySplit.get(split)
    if (!orig) {
      splitsOnlyInSam.push(split)
      continue
    }
    if (!sam) {
      splitsOnlyInOriginal.push(split)
      continue
    }
    bySplit.set(
      split,
      buildUploadPlanForSplit({
        photoFiles: orig.photoFiles,
        maskFiles: sam.maskFiles,
        originalManifestJson: orig.originalManifestJson,
        samManifestJson: sam.samManifestJson,
      }),
    )
  }

  return { bySplit, splitsOnlyInOriginal, splitsOnlyInSam }
}