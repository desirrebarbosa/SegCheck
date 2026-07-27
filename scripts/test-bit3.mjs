// Terminal test for Bit 3 file-matching + COCO parsing (no browser, no Supabase).
// Run:  node scripts/test-bit3.mjs
import { buildUploadPlan } from '../src/lib/uploadMatch.js'

let failures = 0
function check(label, cond) {
  console.log(`${cond ? '  ok  ' : ' FAIL '} ${label}`)
  if (!cond) failures++
}

// --- Sample inputs mimicking two selected folders + a COCO file ---------------
const originalFiles = [
  { name: 'fish01.jpg', relativePath: 'originals/fish/fish01.jpg' },
  { name: 'fish02.jpg', relativePath: 'originals/fish/fish02.jpg' },
  { name: 'crab01.jpg', relativePath: 'originals/crab/crab01.jpg' }, // no mask
]
const maskFiles = [
  { name: 'sam_fish01.png', relativePath: 'masks/fish/sam_fish01.png' },
  { name: 'sam_fish02.png', relativePath: 'masks/fish/sam_fish02.png' },
  { name: 'sam_ghost.png', relativePath: 'masks/fish/sam_ghost.png' }, // orphan
  { name: 'fish03.png', relativePath: 'masks/fish/fish03.png' }, // missing sam_
]
const cocoJson = {
  categories: [
    { id: 1, name: 'fish' },
    { id: 2, name: 'crab' },
  ],
  images: [
    { id: 100, file_name: 'fish/fish01.jpg', width: 640, height: 480 },
    { id: 101, file_name: 'fish/fish02.jpg', width: 640, height: 480 },
    { id: 102, file_name: 'crab/crab01.jpg', width: 800, height: 600 },
  ],
  annotations: [
    { id: 1, image_id: 100, category_id: 1, bbox: [10, 20, 100, 120] },
    { id: 2, image_id: 100, category_id: 1, bbox: [200, 50, 80, 90] }, // 2 fish
    { id: 3, image_id: 101, category_id: 1, bbox: [5, 5, 30, 40] },
    { id: 4, image_id: 102, category_id: 2, bbox: [0, 0, 50, 50] },
  ],
}

const { plan, orphanMasks, invalidMasks, categories } = buildUploadPlan({
  originalFiles,
  maskFiles,
  cocoJson,
})

// --- Assertions ---------------------------------------------------------------
const byStem = Object.fromEntries(plan.map((p) => [p.stem, p]))

check('3 originals planned', plan.length === 3)
check('categories from subfolders = [crab, fish]', JSON.stringify(categories) === '["crab","fish"]')

check('fish01 is ready (mask + coco + category)', byStem.fish01.ready === true)
check('fish01 category = fish', byStem.fish01.category === 'fish')
check('fish01 has 2 instances', byStem.fish01.instances.length === 2)
check(
  'fish01 first bbox = {x:10,y:20,w:100,h:120}',
  JSON.stringify(byStem.fish01.instances[0].bbox) === '{"x":10,"y":20,"w":100,"h":120}',
)
check('fish01 matched mask sam_fish01.png', byStem.fish01.mask?.name === 'sam_fish01.png')

check('crab01 flagged no-mask', byStem.crab01.issues.includes('no-mask'))
check('crab01 not ready', byStem.crab01.ready === false)

check('1 orphan mask (sam_ghost)', orphanMasks.length === 1 && orphanMasks[0].stem === 'ghost')
check('1 invalid mask (fish03, no sam_)', invalidMasks.length === 1 && invalidMasks[0].name === 'fish03.png')

console.log(`\n${failures === 0 ? 'ALL PASS' : failures + ' FAILED'}`)
process.exit(failures === 0 ? 0 : 1)
