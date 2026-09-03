import { describe, it, expect, vi, beforeEach } from 'vitest'
import { parseCorrectionManifest, preflightCorrectionZip, sha256Hex } from './correctionUpload.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeBlob(text = 'data') {
  return {
    text: async () => text,
    arrayBuffer: async () => new TextEncoder().encode(text).buffer,
    type: 'application/octet-stream',
  }
}

function makeEntry(relativePath, blobText = 'data') {
  return { name: relativePath.split('/').pop(), relativePath, blob: makeBlob(blobText) }
}

// Builds a minimal manifest CSV string with the full set of columns the
// correction importer expects (including the new correction metadata columns).
function buildManifestCsv(rows, { projectId = 'proj-1', batchId = 'batch-1' } = {}) {
  const header = [
    'photo_filename',
    'instance_id',
    'manifest_mask_id',
    'category',
    'reason',
    'bbox_x',
    'bbox_y',
    'bbox_w',
    'bbox_h',
    'assigned_to_email',
    'preview_path',
    'mask_path',
    'project_id',
    'batch_id',
    'split',
    'correction_path',
    'format',
  ].join(',')

  const dataRows = rows.map((r) =>
    [
      r.photoFilename ?? 'photo.jpg',
      r.instanceId,
      r.manifestMaskId ?? '',
      r.category ?? 'fish',
      r.reason ?? 'rejected',
      '0', '0', '10', '10',
      r.email ?? 'a@b.com',
      `previews/${r.photoFilename ?? 'photo.jpg'}/${r.instanceId}.png`,
      '',
      r.projectId ?? projectId,
      r.batchId ?? batchId,
      r.split ?? 'val',
      r.correctionPath ?? `corrections/${r.instanceId}.png`,
      r.format ?? 'png',
    ].join(','),
  )

  return [
    '"This zip contains photos and masks that failed QA review."',
    '"reason=missing: …"',
    '"reason=rejected: …"',
    '"preview_path is …"',
    '"correction_path: …"',
    '',
    header,
    ...dataRows,
    '',
    '"TOTAL: 1 (missing: 0, rejected: 1)"',
  ].join('\n')
}

// ---------------------------------------------------------------------------
// parseCorrectionManifest
// ---------------------------------------------------------------------------

describe('parseCorrectionManifest', () => {
  it('parses a well-formed manifest and returns rows', () => {
    const csv = buildManifestCsv([
      { instanceId: 'uuid-1', correctionPath: 'corrections/uuid-1.png' },
    ])
    const { rows, projectId, batchId } = parseCorrectionManifest(csv)
    expect(rows).toHaveLength(1)
    expect(rows[0].instanceId).toBe('uuid-1')
    expect(rows[0].correctionPath).toBe('corrections/uuid-1.png')
    expect(rows[0].format).toBe('png')
    expect(projectId).toBe('proj-1')
    expect(batchId).toBe('batch-1')
  })

  it('throws when the header row is missing', () => {
    expect(() => parseCorrectionManifest('"just a comment"\n')).toThrow(/header row/)
  })

  it('throws when a required column is absent', () => {
    // CSV without the correction_path column
    const csv = 'photo_filename,instance_id,format\nphoto.jpg,uuid-1,png\n'
    expect(() => parseCorrectionManifest(csv)).toThrow(/correction_path/)
  })

  it('throws when there are no data rows', () => {
    const csv = buildManifestCsv([]).replace(/uuid.*\n/, '')
    // Ensure the data rows are stripped (only comments + header remain).
    const headerOnly = [
      '"comment"',
      '',
      'photo_filename,instance_id,manifest_mask_id,category,reason,bbox_x,bbox_y,bbox_w,bbox_h,assigned_to_email,preview_path,mask_path,project_id,batch_id,split,correction_path,format',
      '',
    ].join('\n')
    expect(() => parseCorrectionManifest(headerOnly)).toThrow(/no data rows/)
  })

  it('handles quoted fields with embedded commas and double-quotes', () => {
    const csv = [
      'photo_filename,instance_id,manifest_mask_id,category,reason,bbox_x,bbox_y,bbox_w,bbox_h,assigned_to_email,preview_path,mask_path,project_id,batch_id,split,correction_path,format',
      '"photo,with,commas.jpg",uuid-2,,fish,rejected,0,0,10,10,a@b.com,,,"proj-1","batch-1",val,corrections/uuid-2.png,png',
    ].join('\n')
    const { rows } = parseCorrectionManifest(csv)
    expect(rows[0].photoFilename).toBe('photo,with,commas.jpg')
    expect(rows[0].instanceId).toBe('uuid-2')
  })
})

// ---------------------------------------------------------------------------
// preflightCorrectionZip
// ---------------------------------------------------------------------------

describe('preflightCorrectionZip', () => {
  const baseRows = [
    {
      instanceId: 'uuid-1',
      correctionPath: 'corrections/uuid-1.png',
      format: 'png',
      projectId: 'proj-1',
      batchId: 'batch-1',
      photoFilename: 'photo.jpg',
    },
  ]
  const baseEntries = [
    makeEntry('manifest.csv'),
    makeEntry('corrections/uuid-1.png'),
    makeEntry('photos/photo.jpg'),      // ignored reference file
    makeEntry('masks/photo.jpg/m.png'), // ignored reference file
    makeEntry('previews/photo.jpg/uuid-1.png'), // ignored
  ]

  it('accepts a valid ZIP and returns items', () => {
    const result = preflightCorrectionZip({
      manifestRows: baseRows,
      entries: baseEntries,
      expectedProjectId: 'proj-1',
    })
    expect(result.ok).toBe(true)
    expect(result.items).toHaveLength(1)
    expect(result.items[0].instanceId).toBe('uuid-1')
    expect(result.items[0].format).toBe('png')
  })

  it('accepts COCO JSON corrections (.json extension)', () => {
    const rows = [{ ...baseRows[0], correctionPath: 'corrections/uuid-1.json', format: 'coco_json' }]
    const entries = [makeEntry('manifest.csv'), makeEntry('corrections/uuid-1.json')]
    const result = preflightCorrectionZip({ manifestRows: rows, entries, expectedProjectId: 'proj-1' })
    expect(result.ok).toBe(true)
    expect(result.items[0].format).toBe('coco_json')
  })

  it('rejects when the correction file is missing from the ZIP', () => {
    const entries = [makeEntry('manifest.csv')] // correction file omitted
    const result = preflightCorrectionZip({
      manifestRows: baseRows,
      entries,
      expectedProjectId: 'proj-1',
    })
    expect(result.ok).toBe(false)
    expect(result.errors[0]).toMatch(/not found in ZIP/)
  })

  it('rejects duplicate instance_ids', () => {
    const rows = [...baseRows, { ...baseRows[0] }] // same id twice
    const result = preflightCorrectionZip({
      manifestRows: rows,
      entries: baseEntries,
      expectedProjectId: 'proj-1',
    })
    expect(result.ok).toBe(false)
    expect(result.errors[0]).toMatch(/Duplicate/)
  })

  it('rejects a wrong-project manifest', () => {
    const result = preflightCorrectionZip({
      manifestRows: baseRows,
      entries: baseEntries,
      expectedProjectId: 'proj-WRONG',
    })
    expect(result.ok).toBe(false)
    expect(result.errors[0]).toMatch(/does not match the selected project/)
  })

  it('rejects unsafe ZIP paths (path traversal)', () => {
    const rows = [{ ...baseRows[0], correctionPath: '../../../etc/passwd' }]
    const result = preflightCorrectionZip({ manifestRows: rows, entries: baseEntries, expectedProjectId: 'proj-1' })
    expect(result.ok).toBe(false)
    expect(result.errors[0]).toMatch(/unsafe/)
  })

  it('rejects unsupported file formats', () => {
    const rows = [{ ...baseRows[0], correctionPath: 'corrections/uuid-1.bmp' }]
    const entries = [makeEntry('manifest.csv'), makeEntry('corrections/uuid-1.bmp')]
    const result = preflightCorrectionZip({ manifestRows: rows, entries, expectedProjectId: 'proj-1' })
    expect(result.ok).toBe(false)
    expect(result.errors[0]).toMatch(/unsupported file extension/)
  })

  it('rejects unknown files in the corrections/ folder (not in manifest)', () => {
    const entries = [
      ...baseEntries,
      makeEntry('corrections/extra-file.png'), // not in manifest
    ]
    const result = preflightCorrectionZip({
      manifestRows: baseRows,
      entries,
      expectedProjectId: 'proj-1',
    })
    expect(result.ok).toBe(false)
    expect(result.errors[0]).toMatch(/Unknown file/)
  })

  it('accumulates multiple errors instead of short-circuiting', () => {
    const rows = [
      { ...baseRows[0], correctionPath: '../evil.png' },           // unsafe path
      { ...baseRows[0], instanceId: 'uuid-2', correctionPath: 'corrections/uuid-2.exe' }, // bad ext
    ]
    const entries = [makeEntry('manifest.csv')]
    const result = preflightCorrectionZip({ manifestRows: rows, entries, expectedProjectId: 'proj-1' })
    expect(result.ok).toBe(false)
    expect(result.errors.length).toBeGreaterThanOrEqual(2)
  })
})

// ---------------------------------------------------------------------------
// sha256Hex
// ---------------------------------------------------------------------------

describe('sha256Hex', () => {
  it('returns a 64-char hex string', async () => {
    // SubtleCrypto is available in the vitest jsdom / node environment.
    const hex = await sha256Hex(makeBlob('hello'))
    expect(hex).toMatch(/^[0-9a-f]{64}$/)
  })

  it('returns different hashes for different content', async () => {
    const a = await sha256Hex(makeBlob('aaa'))
    const b = await sha256Hex(makeBlob('bbb'))
    expect(a).not.toBe(b)
  })

  it('returns the same hash for identical content (idempotency)', async () => {
    const a = await sha256Hex(makeBlob('same'))
    const b = await sha256Hex(makeBlob('same'))
    expect(a).toBe(b)
  })
})
