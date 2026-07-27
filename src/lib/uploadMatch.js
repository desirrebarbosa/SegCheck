import { fileStem, maskStem, categoryFromPath, parseCoco } from './coco.js'

// Build the upload plan: line up each original image with its SAM mask and its
// COCO ground-truth, so the UI can show what will be ingested and flag problems
// BEFORE anything is written to Supabase.
//
// Inputs are plain descriptors so this is testable without the browser:
//   originalFiles / maskFiles: [{ name, relativePath, file? }]
//     relativePath is the in-folder path (browser: File.webkitRelativePath).
//   cocoJson: a parsed COCO object (or null if not provided yet).
//
// Returns { plan, orphanMasks, categories }:
//   plan        - one entry per original image (the upload unit)
//   orphanMasks - sam_ files whose original is missing
//   categories  - sorted list of categories seen (from the subfolders)
export function buildUploadPlan({ originalFiles = [], maskFiles = [], cocoJson = null }) {
  const coco = cocoJson ? parseCoco(cocoJson) : { byStem: new Map() }

  // Index masks by their (sam_-stripped) stem. Flag any that break the rule.
  const masksByStem = new Map()
  const invalidMasks = []
  for (const f of maskFiles) {
    const path = f.relativePath ?? f.name
    const stem = maskStem(path)
    if (stem === null) {
      invalidMasks.push({ name: f.name, reason: 'missing sam_ prefix' })
      continue
    }
    masksByStem.set(stem, f)
  }

  const usedMaskStems = new Set()
  const categories = new Set()
  const plan = []

  for (const f of originalFiles) {
    const path = f.relativePath ?? f.name
    const stem = fileStem(path)
    const category = categoryFromPath(path)
    if (category) categories.add(category)

    const mask = masksByStem.get(stem) ?? null
    if (mask) usedMaskStems.add(stem)
    const cocoRec = coco.byStem.get(stem) ?? null

    const issues = []
    if (!mask) issues.push('no-mask')
    if (!cocoRec) issues.push('no-coco')
    if (!category) issues.push('no-category-folder')

    // One DB instance per COCO annotation (object) on this image.
    const instances = (cocoRec?.annotations ?? []).map((a) => ({
      category: a.category,
      bbox: a.bbox,
      annotation_id: a.annotation_id,
    }))

    plan.push({
      stem,
      category,
      original: f,
      mask,
      coco: cocoRec,
      instances,
      ready: issues.length === 0,
      issues,
    })
  }

  const orphanMasks = []
  for (const [stem, f] of masksByStem) {
    if (!usedMaskStems.has(stem)) orphanMasks.push({ stem, name: f.name })
  }

  return {
    plan,
    orphanMasks,
    invalidMasks,
    categories: [...categories].sort(),
  }
}
