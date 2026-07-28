// Parses the upload manifest: seg_coco.json — COCO instance-segmentation
// JSON (images[], annotations[], categories[]), confirmed against a real
// sample. Each annotation carries its own `mask_path` (e.g.
// "masks/3K0347OTHSV2018_3430_ann1.png"), so matching a mask FILE to its
// annotation is exact — no filename-guessing needed. `segmentation` is
// RLE ({size, counts}) in this dataset, kept as-is but not rendered (the
// raster mask file is what's actually drawn).

function stem(path) {
  const base = String(path).split(/[\\/]/).pop()
  return base.replace(/\.[^.]+$/, '')
}

// True if `relativePath` sits inside a folder literally named `folderName`
// at any depth — e.g. inFolder('jodd/val/images/foo.jpg', 'images') is true
// regardless of the dataset/split prefix in front of it.
function inFolder(relativePath, folderName) {
  const parts = String(relativePath).split(/[\\/]/)
  return parts.slice(0, -1).includes(folderName)
}

// Splits one uploaded dataset zip's flat entries (from readZipEntries) into
// the three things a batch needs, based on the real layout you showed me:
//   <dataset>/<split>/images/...            -> photos
//   <dataset>/<split>/masks/...             -> masks
//   <dataset>/<split>/annotations/seg_coco.json -> the manifest (the
//     SAM-assisted final annotation file — coco.json, if also present, is
//     ignored on purpose per your earlier confirmation)
// Throws a clear error if the manifest file isn't found, since there's
// nothing sensible to fall back to.
export async function classifyZipEntries(entries) {
  const photoFiles = entries
    .filter((e) => inFolder(e.relativePath, 'images'))
    .map((e) => ({ ...e, file: e.blob }))
  const maskFiles = entries
    .filter((e) => inFolder(e.relativePath, 'masks'))
    .map((e) => ({ ...e, file: e.blob }))
  const manifestEntry = entries.find((e) => e.name === 'seg_coco.json')

  if (!manifestEntry) {
    throw new Error('No annotations/seg_coco.json found inside the zip.')
  }
  const manifestJson = JSON.parse(await manifestEntry.blob.text())

  return { photoFiles, maskFiles, manifestJson }
}

// Parse the manifest into lookups keyed by photo filename stem.
export function parseManifest(manifestJson) {
  const categoriesById = new Map((manifestJson.categories ?? []).map((c) => [c.id, c.name]))

  const annsByImageId = new Map()
  for (const a of manifestJson.annotations ?? []) {
    if (!annsByImageId.has(a.image_id)) annsByImageId.set(a.image_id, [])
    annsByImageId.get(a.image_id).push(a)
  }

  // photosByStem: one entry per photo the manifest knows about.
  const photosByStem = new Map()
  for (const img of manifestJson.images ?? []) {
    const photoStem = stem(img.file_name)
    const annotations = (annsByImageId.get(img.id) ?? []).map((a) => ({
      annotationId: a.id,
      category: categoriesById.get(a.category_id) ?? String(a.category_id ?? ''),
      bbox: a.bbox ?? null, // [x, y, w, h] — kept as context for the reviewer
      segmentation: a.segmentation ?? null, // polygon ([[x1,y1,x2,y2,...]]) or RLE ({counts, size})
      isCrowd: !!a.iscrowd, // iscrowd=1 => segmentation is RLE, not polygon
      // Real field confirmed from seg_coco.json: mask_path, e.g.
      // "masks/3K0347OTHSV2018_3430_ann1.png". stem() strips the folder
      // prefix and extension, leaving just the match key.
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

// Build the upload plan: line up each photo with the manifest's instances for
// it, and each instance with its actual mask file (by stem match against
// maskFileHint). Pure/testable — no Supabase or browser APIs.
//
// Inputs are plain descriptors:
//   photoFiles: [{ name, relativePath, file? }]
//   maskFiles:  [{ name, relativePath, file? }]
//   manifestJson: parsed COCO-style JSON
//
// Returns { plan, unmatchedManifestPhotos, orphanMasks }:
//   plan  - one entry per uploaded photo file:
//     { stem, photo, inManifest, instances, missingWhole }
//     instances: [{ annotationId, category, bbox, mask, missing }]
//     missingWhole = true when the photo isn't in the manifest at all
//       (nothing to review -> auto-fail the whole photo, per your rule)
//   unmatchedManifestPhotos - manifest photo entries with no uploaded file
//   orphanMasks - mask files that didn't match any annotation's hint
export function buildUploadPlan({ photoFiles = [], maskFiles = [], manifestJson }) {
  const { photosByStem } = parseManifest(manifestJson)

  const masksByStem = new Map()
  for (const f of maskFiles) {
    masksByStem.set(stem(f.relativePath ?? f.name), f)
  }
  const usedMaskStems = new Set()

  const plan = []
  const seenPhotoStems = new Set()

  for (const f of photoFiles) {
    const photoStem = stem(f.relativePath ?? f.name)
    seenPhotoStems.add(photoStem)
    const manifestEntry = photosByStem.get(photoStem) ?? null

    if (!manifestEntry) {
      // Photo has no manifest entry at all: nothing to review -> auto-fail.
      plan.push({ stem: photoStem, photo: f, inManifest: false, instances: [], missingWhole: true })
      continue
    }

    const instances = manifestEntry.annotations.map((a) => {
      const mask = masksByStem.get(stem(a.maskFileHint)) ?? null
      if (mask) usedMaskStems.add(stem(a.maskFileHint))
      return {
        annotationId: a.annotationId,
        category: a.category,
        bbox: a.bbox,
        segmentation: a.segmentation,
        isCrowd: a.isCrowd,
        mask,
        missing: !mask, // no matching mask file -> auto-fail this instance
      }
    })

    plan.push({ stem: photoStem, photo: f, inManifest: true, instances, missingWhole: false })
  }

  const unmatchedManifestPhotos = [...photosByStem.entries()]
    .filter(([s]) => !seenPhotoStems.has(s))
    .map(([s, entry]) => ({ stem: s, fileName: entry.fileName }))

  const orphanMasks = [...masksByStem.entries()]
    .filter(([s]) => !usedMaskStems.has(s))
    .map(([s, f]) => ({ stem: s, name: f.name }))

  return { plan, unmatchedManifestPhotos, orphanMasks }
}