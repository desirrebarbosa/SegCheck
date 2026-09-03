// correctionUpload.js
//
// Parses, validates, uploads, and records a correction ZIP submitted by a
// reviewer in response to a redo batch.
//
// High-level flow (mirrors CORRECTED_MASK_UPLOADS.md):
//   1. readZipEntries()          — via zipHelpers, already handles OS junk
//   2. parseCorrectionManifest() — read manifest.csv, surface row errors
//   3. preflightCorrectionZip()  — validate every mask before any upload
//   4. uploadCorrectionBatch()   — upload files, then call DB RPC
//
// Only uploadCorrectionBatch() touches Storage or the database; everything
// before it is pure logic so it can be unit-tested without network stubs.

import { supabase } from './supabaseClient'
import { uploadFile } from './storage'
import { readZipEntries } from './zipHelpers'

// How many correction files are uploaded simultaneously.
const UPLOAD_CONCURRENCY = 4

// ---------------------------------------------------------------------------
// CSV parsing
// ---------------------------------------------------------------------------

// Splits one CSV line respecting double-quoted fields (RFC 4180 subset).
// Does NOT handle multi-line quoted values — the manifest CSV never has them.
function splitCsvLine(line) {
  const fields = []
  let cur = ''
  let inQuote = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (inQuote) {
      if (ch === '"' && line[i + 1] === '"') {
        cur += '"'
        i++
      } else if (ch === '"') {
        inQuote = false
      } else {
        cur += ch
      }
    } else if (ch === '"') {
      inQuote = true
    } else if (ch === ',') {
      fields.push(cur)
      cur = ''
    } else {
      cur += ch
    }
  }
  fields.push(cur)
  return fields
}

// Finds the first non-comment, non-blank line whose first field matches
// 'photo_filename' (the header row). Comment lines start with a quoted
// sentence (the instruction text baked into the manifest).
function findHeaderRow(lines) {
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim()
    if (!trimmed || trimmed.startsWith('"')) continue
    const fields = splitCsvLine(trimmed)
    if (fields[0] === 'photo_filename') return { idx: i, fields }
  }
  return null
}

// Parses manifest.csv text into structured rows.
// Returns { projectId, batchId, rows: [{ instanceId, correctionPath, format, … }] }
// or throws a descriptive Error on any structural problem.
export function parseCorrectionManifest(csvText) {
  const lines = csvText.split(/\r?\n/)
  const header = findHeaderRow(lines)
  if (!header) throw new Error('manifest.csv: could not find the header row (photo_filename, …).')

  const col = (name) => {
    const i = header.fields.indexOf(name)
    if (i === -1) throw new Error(`manifest.csv: required column "${name}" is missing.`)
    return i
  }

  // Required columns (added in the extended manifest export).
  const iInstanceId = col('instance_id')
  const iCorrectionPath = col('correction_path')
  const iFormat = col('format')
  const iProjectId = col('project_id')
  const iBatchId = col('batch_id')
  const iPhotoFilename = col('photo_filename')

  const rows = []
  let projectId = null
  let batchId = null

  for (let i = header.idx + 1; i < lines.length; i++) {
    const trimmed = lines[i].trim()
    // Skip blank lines and the TOTAL summary line at the bottom.
    if (!trimmed || trimmed.startsWith('"TOTAL:') || trimmed.startsWith('TOTAL:')) continue

    const fields = splitCsvLine(trimmed)
    const instanceId = fields[iInstanceId]?.trim()
    if (!instanceId) continue // blank / padding row

    const rowProjectId = fields[iProjectId]?.trim() ?? ''
    const rowBatchId = fields[iBatchId]?.trim() ?? ''

    // All rows in one manifest must share the same project_id and batch_id.
    if (projectId === null) projectId = rowProjectId
    if (batchId === null) batchId = rowBatchId

    rows.push({
      instanceId,
      correctionPath: fields[iCorrectionPath]?.trim() ?? '',
      format: fields[iFormat]?.trim() ?? 'png',
      projectId: rowProjectId,
      batchId: rowBatchId,
      photoFilename: fields[iPhotoFilename]?.trim() ?? '',
    })
  }

  if (rows.length === 0) throw new Error('manifest.csv: no data rows found.')

  return { projectId: projectId ?? '', batchId: batchId ?? '', rows }
}

// ---------------------------------------------------------------------------
// Preflight validation (pure — no network, no DB)
// ---------------------------------------------------------------------------

// Supported correction file extensions → canonical format strings.
const FORMAT_BY_EXT = { png: 'png', json: 'coco_json' }

// Validates a parsed manifest + ZIP entries and returns one of:
//   { ok: true, items: [{ instanceId, correctionPath, format, blob }] }
//   { ok: false, errors: ['...'] }
//
// Rejection reasons (from spec):
//   - Missing corrections
//   - Duplicate mask IDs
//   - Unknown or extra files
//   - Wrong-project manifests  (checked by caller with the project context)
//   - Unsupported file formats
//   - Unsafe ZIP paths  (path traversal)
export function preflightCorrectionZip({ manifestRows, entries, expectedProjectId }) {
  const errors = []

  // Build a lookup of ZIP entries by their relative path.
  const byPath = new Map(entries.map((e) => [e.relativePath, e]))

  // Track which ZIP entries are accounted for by the manifest.
  const accountedPaths = new Set()
  accountedPaths.add('manifest.csv') // always expected

  const seenInstanceIds = new Set()
  const items = []

  for (const row of manifestRows) {
    // --- Duplicate mask IDs ---
    if (seenInstanceIds.has(row.instanceId)) {
      errors.push(`Duplicate instance_id in manifest: ${row.instanceId}`)
      continue
    }
    seenInstanceIds.add(row.instanceId)

    // --- Wrong-project manifest ---
    if (expectedProjectId && row.projectId && row.projectId !== expectedProjectId) {
      errors.push(
        `instance_id ${row.instanceId}: manifest project_id (${row.projectId}) does not match the selected project (${expectedProjectId}).`,
      )
    }

    // --- Unsafe ZIP path (path traversal) ---
    if (row.correctionPath.includes('..') || row.correctionPath.startsWith('/')) {
      errors.push(`instance_id ${row.instanceId}: unsafe correction_path "${row.correctionPath}".`)
      continue
    }

    // --- Unsupported format ---
    const ext = row.correctionPath.split('.').pop().toLowerCase()
    if (!FORMAT_BY_EXT[ext]) {
      errors.push(
        `instance_id ${row.instanceId}: unsupported file extension ".${ext}". Supported: png, json.`,
      )
      continue
    }

    // --- Missing correction file ---
    const entry = byPath.get(row.correctionPath)
    if (!entry) {
      errors.push(`instance_id ${row.instanceId}: correction file "${row.correctionPath}" not found in ZIP.`)
      continue
    }

    accountedPaths.add(row.correctionPath)
    items.push({
      instanceId: row.instanceId,
      correctionPath: row.correctionPath,
      format: FORMAT_BY_EXT[ext],
      blob: entry.blob,
      originalFilename: entry.name,
    })
  }

  // --- Extra / unknown files in the ZIP ---
  // Skip photo/mask/preview folders — those are reference copies, not
  // corrections, so we don't require them to be listed in the manifest.
  const IGNORED_PREFIXES = ['photos/', 'masks/', 'previews/']
  for (const path of byPath.keys()) {
    if (accountedPaths.has(path)) continue
    if (IGNORED_PREFIXES.some((p) => path.startsWith(p))) continue
    errors.push(`Unknown file in ZIP (not listed in manifest): "${path}".`)
  }

  if (errors.length > 0) return { ok: false, errors }
  return { ok: true, items }
}

// ---------------------------------------------------------------------------
// Checksum (SHA-256, hex) — for dedup and retry detection
// ---------------------------------------------------------------------------

// Computes a hex SHA-256 digest of a Blob's bytes. Runs in the browser
// via SubtleCrypto (available in all modern browsers and in Node 20+).
export async function sha256Hex(blob) {
  const buffer = await blob.arrayBuffer()
  const hashBuffer = await crypto.subtle.digest('SHA-256', buffer)
  return Array.from(new Uint8Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

// ---------------------------------------------------------------------------
// Storage upload (bounded concurrency)
// ---------------------------------------------------------------------------

async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length)
  let next = 0
  async function worker() {
    while (next < items.length) {
      const i = next++
      results[i] = await fn(items[i], i)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return results
}

// ---------------------------------------------------------------------------
// Database RPC
// ---------------------------------------------------------------------------

// Calls the `submit_corrections` Postgres RPC, which atomically:
//   1. Verifies each mask belongs to projectId and is still 'fail'.
//   2. Verifies the caller is the assigned reviewer for each mask.
//   3. Inserts rows into mask_corrections.
//   4. Updates mask status to 'fixed' and clears assigned_to.
//   5. Writes a 'submit_correction' entry in review_logs for each mask.
//
// Returns { fixed: number, duplicate: number } on success, throws on any failure.
async function callSubmitCorrectionsRpc({ projectId, batchId, userId, corrections }) {
  const { data, error } = await supabase.rpc('submit_corrections', {
    p_project_id: projectId,
    p_batch_id: batchId,
    p_submitted_by: userId,
    p_corrections: corrections,
    // p_corrections shape: [{ mask_id, storage_path, original_filename, format, checksum }]
  })
  if (error) throw error
  return data // { fixed: number, duplicate: number }
}

// ---------------------------------------------------------------------------
// Public upload entry point
// ---------------------------------------------------------------------------

// Reads, validates, uploads, and records a correction ZIP.
//
// `zipFile`      — the File / Blob selected by the reviewer
// `projectId`    — the project the reviewer is working in (from route context)
// `userId`       — the currently signed-in reviewer's id
// `onProgress`   — optional ({ phase, done, total }) progress callback
// `signal`       — optional AbortSignal for cancellation
//
// Returns:
//   { ok: false, errors }                   — preflight rejected
//   { ok: true,  fixed, duplicate }         — all corrections recorded (or already existed)
//
// Throws on unrecoverable network/database errors.
export async function uploadCorrectionZip({ zipFile, projectId, userId, onProgress, signal }) {
  // ── 1. Parse ZIP entries ────────────────────────────────────────────────
  onProgress?.({ phase: 'parse', done: 0, total: 1 })
  const entries = await readZipEntries(zipFile)

  // ── 2. Find and parse manifest.csv ──────────────────────────────────────
  const manifestEntry = entries.find(
    (e) => e.name === 'manifest.csv' || e.relativePath === 'manifest.csv',
  )
  if (!manifestEntry) {
    return { ok: false, errors: ['manifest.csv not found in the ZIP.'] }
  }
  let parsed
  try {
    parsed = parseCorrectionManifest(await manifestEntry.blob.text())
  } catch (e) {
    return { ok: false, errors: [e.message] }
  }

  // ── 3. Preflight validation (pure, no network) ──────────────────────────
  const preflight = preflightCorrectionZip({
    manifestRows: parsed.rows,
    entries,
    expectedProjectId: projectId,
  })
  if (!preflight.ok) return { ok: false, errors: preflight.errors }

  const items = preflight.items // [{ instanceId, correctionPath, format, blob, originalFilename }]
  onProgress?.({ phase: 'parse', done: 1, total: 1 })

  // ── 4. Compute checksums (parallel, cheap) ──────────────────────────────
  onProgress?.({ phase: 'checksum', done: 0, total: items.length })
  const checksums = await mapWithConcurrency(items, 8, async (item, i) => {
    const cs = await sha256Hex(item.blob)
    onProgress?.({ phase: 'checksum', done: i + 1, total: items.length })
    return cs
  })

  // ── 5. Upload correction files to Storage (bounded concurrency) ─────────
  // Path: {projectId}/{batchId}/corrections/{maskId}/{correctionId}-{filename}
  // correctionId = crypto.randomUUID() ensures each upload path is unique
  // and non-overwritable, even on retry.
  onProgress?.({ phase: 'upload', done: 0, total: items.length })

  const uploadedPaths = []
  let uploadDone = 0

  // If Storage uploads succeed but the DB transaction fails, callers get
  // the list of uploaded paths so they can attempt cleanup.
  const uploadedStoragePaths = []

  try {
    await mapWithConcurrency(items, UPLOAD_CONCURRENCY, async (item, i) => {
      signal?.throwIfAborted()
      const correctionId = crypto.randomUUID()
      const storagePath = `${projectId}/${parsed.batchId || 'corrections'}/${item.instanceId}/${correctionId}-${item.originalFilename}`

      await uploadFile(storagePath, item.blob)
      uploadedStoragePaths.push(storagePath)
      uploadedPaths[i] = { item, storagePath, checksum: checksums[i] }

      uploadDone++
      onProgress?.({ phase: 'upload', done: uploadDone, total: items.length })
    })
  } catch (uploadErr) {
    throw Object.assign(new Error(`Storage upload failed: ${uploadErr.message}`), {
      cause: uploadErr,
      uploadedPaths: uploadedStoragePaths,
    })
  }

  // ── 6. Atomic DB transaction via RPC ─────────────────────────────────────
  onProgress?.({ phase: 'record', done: 0, total: 1 })
  const corrections = uploadedPaths.map(({ item, storagePath, checksum }) => ({
    mask_id: item.instanceId,
    storage_path: storagePath,
    original_filename: item.originalFilename,
    format: item.format,
    checksum,
  }))

  let rpcResult
  try {
    rpcResult = await callSubmitCorrectionsRpc({
      projectId,
      batchId: parsed.batchId,
      userId,
      corrections,
    })
  } catch (dbErr) {
    // DB failed after Storage uploads succeeded. Surface the error with the
    // list of uploaded paths so the caller (or an admin) can clean them up.
    throw Object.assign(new Error(`Database transaction failed: ${dbErr.message}`), {
      cause: dbErr,
      uploadedPaths: uploadedStoragePaths,
    })
  }

  onProgress?.({ phase: 'record', done: 1, total: 1 })

  // The RPC returns { fixed, duplicate } — fixed = newly recorded,
  // duplicate = already existed (idempotent re-upload detected by checksum).
  return { ok: true, fixed: rpcResult?.fixed ?? 0, duplicate: rpcResult?.duplicate ?? 0 }
}
