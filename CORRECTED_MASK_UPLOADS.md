# Corrected Mask Uploads

## Purpose

Allow reviewers to upload manually corrected masks from a redo batch while preserving the original failed mask and a complete history of the correction.

## Proposed Workflow

1. A reviewer downloads their assigned redo ZIP.
2. The ZIP contains the failed photos, masks, previews, and `manifest.csv`.
3. The reviewer edits the mask files and places the corrected files in the expected correction folder.
4. The reviewer uploads the completed ZIP.
5. SegCheck validates the entire ZIP before uploading anything.
6. Valid corrections are stored, recorded, and marked as `fixed`.
7. Fixed masks leave the redo queue but remain available for audit and reporting.

Uploading a valid correction completes the redo. A second QA review is not required for this feature.

## Identity and Validation

- `instance_id` from `manifest.csv` is the authoritative mask ID.
- `manifest_mask_id` is retained as a human-readable cross-check.
- Only the member currently assigned to the failed mask may submit it.
- The server must verify that every mask belongs to the selected project and is still in `fail` status.
- The importer must reject:
  - Missing corrections
  - Duplicate mask IDs
  - Unknown or extra files
  - Wrong-project manifests
  - Already-fixed or unassigned masks
  - Unsupported file formats
  - Unsafe ZIP paths

Supported formats:

- PNG raster masks
- COCO segmentation JSON

## Storage and Database

Keep the original failed mask unchanged. Store each correction at a unique path, for example:

```text
{projectId}/{split}/corrections/{maskId}/{correctionId}-{filename}
```

Add a `mask_corrections` table with:

- `id`
- `mask_id`
- `project_id`
- `submitted_by`
- `storage_path`
- `original_filename`
- `format`
- `checksum`
- `batch_id`
- `created_at`

Add `fixed` to the mask status values. A correction submission should also create a `review_logs` entry such as `submit_correction`.

The database update should happen through one transaction or Supabase RPC. It must verify ownership, insert correction records, update mask statuses, and write audit logs together.

## Performance and Reliability

- Validate the complete ZIP before any Storage upload.
- Upload files with bounded concurrency, following the existing worker pattern in `uploads.js` and `zipHelpers.js`.
- Never use an overwritable Storage path for corrections.
- Compute a checksum for each correction to support retry and duplicate detection.
- Make repeated uploads of the same batch idempotent, or return a clear duplicate result.
- If the database transaction fails after Storage uploads, provide cleanup or retry handling for those objects.

## Application Changes

- Extend `exportRedo.js` so the manifest includes the project ID, batch ID, expected correction path, and format.
- Add a correction ZIP parser and upload service near the existing upload helpers.
- Replace the placeholder in `Fix.jsx` or add an upload flow to `MyRedo.jsx`.
- Show preflight results, upload progress, row-level errors, and final counts.
- Keep `fixed` masks out of active redo counts and assignment queues.
- Include correction files in photo and project cleanup.

## Acceptance Criteria

- A valid redo ZIP fixes every listed mask and creates one correction record per mask.
- The original failed mask and its Storage object remain unchanged.
- Invalid ZIPs are rejected before any upload begins.
- A reviewer cannot submit another member's redo item.
- Duplicate submissions do not create duplicate correction records.
- Fixed masks disappear from My Redo and dashboard redo counts.
- Project and photo deletion removes correction files.
- Tests cover ZIP parsing, identity matching, ownership, idempotency, status changes, audit logs, and cleanup.

## Scope Note

This feature covers batch ZIP upload. It does not redesign the manual Canvas editor or add individual file uploads in the first implementation.
