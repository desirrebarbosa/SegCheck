# CHANGES

## 2026-09-03 — Partial Redo Batches

### Modified files

#### `collect_annotated_masks.py`
Partial redo batches are now supported. The generated correction ZIP includes
only instances with completed `mask_final.png` or `mask_final.json` files, and
its `manifest.csv` is filtered to the same set so the upload preflight accepts
unfinished work remaining for a later upload. Complete batches preserve the
original manifest.

#### `src/pages/Dashboard.jsx`
Dashboard statistics now include corrected instances (`status = 'fixed'`) and
a **Total complete** count combining passed and corrected masks. The existing
failure count is labeled **Needs redo** to make remaining work explicit.

#### `CORRECTED_MASK_UPLOAD_GUIDE.md`
Documents the partial redo workflow and continuing unfinished instances later.

#### `test_collect_annotated_masks.py`
Adds regression coverage confirming unfinished instance IDs are omitted from a
partial upload manifest.

---

## 2026-09-02 — Corrected Mask Uploads (CORRECTED_MASK_UPLOADS.md)

### New files

#### `src/lib/correctionUpload.js`
Core library for the correction ZIP upload pipeline.

- **`parseCorrectionManifest(csvText)`** — RFC 4180-compliant CSV parser. Skips comment/blank lines, locates the header row by the `photo_filename` sentinel, and returns `{ projectId, batchId, rows }`. Throws a descriptive error on any structural problem (missing header, missing required column, no data rows).
- **`preflightCorrectionZip({ manifestRows, entries, expectedProjectId })`** — pure validation with no network calls. Rejects the ZIP before any upload if it contains: missing correction files, duplicate `instance_id` values, a wrong-project `project_id`, unsafe paths (`../` or absolute), unsupported file formats (anything other than `.png` / `.json`), or unknown extra files outside the ignored `photos/`, `masks/`, `previews/` folders. Accumulates *all* errors rather than stopping at the first.
- **`sha256Hex(blob)`** — SHA-256 digest via `SubtleCrypto` for idempotency and duplicate-detection.
- **`uploadCorrectionZip({ zipFile, projectId, userId, onProgress, signal })`** — full upload pipeline: read ZIP entries → parse manifest → preflight → compute checksums → upload files to Storage with bounded concurrency (4 workers) → call `submit_corrections` Supabase RPC atomically. Returns `{ ok, fixed, duplicate }` on success; returns `{ ok: false, errors }` on preflight failure; throws on network/DB errors with `uploadedPaths` attached for cleanup.

#### `src/lib/correctionUpload.test.js`
18 unit tests covering:
- `parseCorrectionManifest`: well-formed CSV, missing header, missing required column, no data rows, quoted fields with embedded commas and double-quotes.
- `preflightCorrectionZip`: happy path, COCO JSON format acceptance, missing correction file, duplicate instance IDs, wrong-project manifest, unsafe ZIP path, unsupported format, unknown extra files, multi-error accumulation.
- `sha256Hex`: 64-char hex output, different content → different hash, identical content → identical hash (idempotency).

#### `supabase_migration_corrected_masks.sql`
Supabase migration to be applied in the SQL editor:
- Extends the `masks.status` `CHECK` constraint to include `'fixed'`.
- Creates the `mask_corrections` table (`id`, `mask_id`, `project_id`, `submitted_by`, `storage_path`, `original_filename`, `format`, `checksum`, `batch_id`, `created_at`).
- Adds indexes: `mask_id` index for lookups; `UNIQUE (mask_id, checksum)` index for idempotency enforcement at the DB level.
- Adds RLS policies: members can `SELECT`; only the submitter can `INSERT`.
- Creates the `submit_corrections(p_project_id, p_batch_id, p_submitted_by, p_corrections)` PL/pgSQL RPC (`SECURITY DEFINER`). In one transaction it: row-locks each mask, verifies project ownership and `fail` status, verifies the submitter is the assigned reviewer, skips checksums already recorded (idempotent), inserts `mask_corrections` rows, updates masks to `status = 'fixed'` with `assigned_to = NULL`, and writes `submit_correction` entries to `review_logs`.
- Documents the Storage cleanup pattern and the `active_masks` view update required to exclude `'fixed'` from redo counts.

---

### Modified files

#### `src/lib/exportRedo.js`
Extended the manifest so correction ZIPs carry enough metadata for the importer to verify provenance and locate files.

- `buildRedoZipFiles` options bag extended with `projectId`, `batchId`, `split` (all default to `''`).
- Per-row format detection: derives `'png'` or `'coco_json'` from the existing mask's `storage_path` extension.
- Per-row `correction_path` computed as `corrections/<maskId>.<ext>` — the exact relative path the reviewer must use inside their correction ZIP.
- Five new columns added to each manifest row: `project_id`, `batch_id`, `split`, `correction_path`, `format`.
- `buildInstanceManifestCsv` updated: five new columns added to the CSV header; a new instruction comment line added (`correction_path: place your corrected file…`); each data row serialises the new fields.
- `exportRedoBatch` signature extended with `projectId`, `batchId`, `split` and threads them into `buildRedoZipFiles`.

#### `src/pages/MyRedo.jsx`
Added the correction upload flow alongside the existing download flow.

- Import of `uploadCorrectionZip` from `correctionUpload.js`.
- Upload state: `uploading`, `uploadProgress`, `uploadController`, `preflightErrors`, `uploadResult`, hidden `fileInputRef`.
- `uploadOverallPercent(progress)` helper mapping the four upload phases (parse 5 %, checksum 10 %, upload 75 %, record 10 %) to a single 0–100 value for the progress bar.
- `handleUploadClick` — clears stale results and triggers the hidden `<input type="file" accept=".zip">`.
- `handleFileSelected` — runs `uploadCorrectionZip`, shows preflight errors as a red bullet list, shows a green success summary on completion, refreshes the redo list so fixed masks disappear immediately.
- UI: download button restyled to outlined; new orange "Upload corrections" button beside it; upload `ProgressBar` with phase labels and cancel support; preflight error panel; upload success summary with fixed/duplicate counts.
- Both download and upload are disabled while either is busy (`const busy = downloading || uploading`).
