// Helpers for COCO ground-truth JSON and SegCheck's filename conventions.
//
// Conventions (decided in Bit 3):
//   - Originals live in a subfolder per category:  <category>/<stem>.<ext>
//   - SAM masks mirror that, prefixed with sam_:    <category>/sam_<stem>.<ext>
//   - A mask matches an original when their *stems* match (mask stem = filename
//     with the leading "sam_" and the extension removed).

// "fish/fish01.jpg" -> "fish01.jpg"
export function baseName(path) {
  return String(path).split(/[\\/]/).pop() // drop any directories
}

// "fish/fish01.jpg" -> "fish01"   |   "sam_fish01.png" -> "sam_fish01"
export function fileStem(path) {
  return baseName(path).replace(/\.[^.]+$/, '') // drop the extension
}

// Mask stem with the required "sam_" prefix stripped: "sam_fish01.png" -> "fish01".
// Returns null if the file is not a valid SAM output (no "sam_" prefix).
export function maskStem(path) {
  const stem = fileStem(path)
  return stem.startsWith('sam_') ? stem.slice(4) : null
}

// The category is the immediate parent folder: "fish/fish01.jpg" -> "fish".
export function categoryFromPath(relativePath) {
  const parts = String(relativePath).split(/[\\/]/).filter(Boolean)
  return parts.length >= 2 ? parts[parts.length - 2] : null
}

// COCO bbox is [x, y, width, height]; the DB stores {x, y, w, h}.
export function bboxToObj(bbox) {
  const [x, y, w, h] = bbox
  return { x, y, w, h }
}

// Parse a COCO JSON object into a lookup keyed by image filename stem.
export function parseCoco(coco) {
  const categoriesById = new Map((coco.categories ?? []).map((c) => [c.id, c.name]))

  const annsByImageId = new Map()
  for (const a of coco.annotations ?? []) {
    if (!annsByImageId.has(a.image_id)) annsByImageId.set(a.image_id, [])
    annsByImageId.get(a.image_id).push(a)
  }

  const byStem = new Map()
  for (const img of coco.images ?? []) {
    const stem = fileStem(img.file_name)
    const annotations = (annsByImageId.get(img.id) ?? []).map((a) => ({
      annotation_id: a.id,
      category: categoriesById.get(a.category_id) ?? String(a.category_id),
      bbox: bboxToObj(a.bbox),
    }))
    byStem.set(stem, {
      fileName: img.file_name,
      width: img.width,
      height: img.height,
      annotations,
    })
  }

  return { byStem, categoriesById }
}
