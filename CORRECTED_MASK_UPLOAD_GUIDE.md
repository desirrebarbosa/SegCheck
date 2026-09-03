# Corrected Mask Upload Guide

This guide explains the end-to-end workflow for annotators who need to fix
failed masks and submit them back to SegCheck via the **Upload corrections**
button on the My Redo page.

---

## Overview

```
SegCheck (My Redo)
      │
      │  1. Download redo ZIP
      ▼
annotation_workspace/
  ├── index.csv              ← maps instance folders ↔ instance IDs
  ├── inst-<uuid-1>/
  │     ├── photo.jpg        ← reference photo from the redo ZIP
  │     ├── masks/<...>      ← original failed mask (do not modify)
  │     └── mask_final.png   ← YOUR corrected mask (create this)
  └── inst-<uuid-2>/
        └── ...
      │
      │  2. Annotate — save mask_final.png in each instance folder
      │  3. Run collect_annotated_masks.py
      ▼
corrections-<batchId>.zip   ← ready to upload
      │
      │  4. Upload via SegCheck → My Redo → Upload corrections
      ▼
SegCheck records corrections, marks masks as `fixed`
```

The collector supports partial redo batches. Only instances with a completed
`mask_final.png` (or `mask_final.json`) are placed in the upload manifest, so
unfinished instances remain available for later work.

---

## Step-by-step

### 1 — Download your redo batch from SegCheck

1. Open **SegCheck → My Redo**.
2. Click **Download my redo batch**.
3. Save the ZIP (e.g. `my-project-redo.zip`) into the project root — the
   same directory that contains `collect_annotated_masks.py`.

> [!IMPORTANT]
> Keep the downloaded ZIP in the project root. `collect_annotated_masks.py`
> auto-detects any `*-redo.zip` file there. If you have multiple ZIPs, pass
> the exact one with `--redo-zip`.

The ZIP contains:
- `manifest.csv` — one row per failed mask with `instance_id`, `correction_path`, `format`, `project_id`, `batch_id`, and reference columns
- `photos/` — original photos
- `masks/` — original failed masks
- `previews/` — flattened reference images (photo + mask overlay)

---

### 2 — Set up annotation_workspace/index.csv

Create (or update) `annotation_workspace/index.csv` with **at minimum** these
two columns:

| Column | Description |
|---|---|
| `instance_folder` | Subdirectory name inside `annotation_workspace/` |
| `instance_id` | The UUID from the redo manifest — must match exactly |

**Example:**

```csv
instance_folder,instance_id
inst-uuid-1,3f4a1b2c-0001-0001-0001-000000000001
inst-uuid-2,3f4a1b2c-0002-0002-0002-000000000002
```

The `instance_id` values come from the `instance_id` column of `manifest.csv`
inside your downloaded redo ZIP.

> [!TIP]
> You can add extra columns to `index.csv` (e.g. `photo_filename`, `category`)
> for your own reference — the script ignores unknown columns.

---

### 3 — Annotate the masks

For each instance folder:

1. Open `annotation_workspace/<instance_folder>/photo.jpg` and the preview in
   `previews/` to understand which object needs correcting.
2. Create the corrected mask and save it as **`mask_final.png`** in that folder.
   - For COCO JSON format (when `format=coco_json` in the manifest), save as
     **`mask_final.json`** instead.
3. The mask **must have the same pixel dimensions as the photo**. The script
   will reject masks with a mismatched size.

> [!NOTE]
> You do not need to rename files to match the UUID. The script reads
> `index.csv` to map your folder structure to the `instance_id`.

---

### 4 — Run collect_annotated_masks.py

```bash
# Auto-detect the redo ZIP and write corrections-<batchId>.zip
python3 collect_annotated_masks.py

# Specify the redo ZIP explicitly
python3 collect_annotated_masks.py --redo-zip path/to/my-project-redo.zip

# Preview what would be collected without writing the ZIP
python3 collect_annotated_masks.py --dry-run

# Write to a custom output path
python3 collect_annotated_masks.py --out my-corrections.zip
```

**Sample output:**

```
Using redo ZIP: /path/to/my-project-redo.zip
Manifest: 12 instance(s), batch='batch-2026-09-03', project='proj-abc'

Collected: 10/12

Dimension mismatch — NOT collected (1):
  inst-uuid-5: photo=(3024, 4032)  mask_final=(1512, 2016)

Mask not done yet (1):
  inst-uuid-9

Writing correction ZIP -> corrections-batch-2026-09-03.zip
  + corrections/3f4a1b2c-0001-...png
  + corrections/3f4a1b2c-0002-...png
  ...

Done. 10 correction(s) packaged (1842.3 KB).
Upload corrections-batch-2026-09-03.zip via SegCheck -> My Redo -> Upload corrections.
```

The script reports:
- **Collected** — masks validated and added to the ZIP
- **Dimension mismatch** — masks whose pixel size differs from the photo (fix and re-run)
- **Mask not done yet** — instance folders without a `mask_final.png`
- **instance_id not found in redo manifest** — rows in `index.csv` whose
  `instance_id` does not appear in the downloaded redo manifest (check for typos)

> [!WARNING]
> Fix all **dimension mismatches** before uploading. The SegCheck preflight
> does not re-check dimensions, but a wrong-size mask will produce inaccurate
> segmentation results.

---

### 5 — Upload the correction ZIP

1. Open **SegCheck → My Redo**.
2. Click **Upload corrections**.
3. Select the `corrections-<batchId>.zip` produced in the previous step.
4. SegCheck runs a preflight check on every mask before uploading anything.
   - If any errors are shown, fix them and re-run `collect_annotated_masks.py`.
5. On success, the corrected masks disappear from **My Redo** and their status
   changes to `fixed`.

> [!NOTE]
> Uploading the same ZIP twice is safe — duplicate checksums are detected and
> skipped without creating duplicate records.

---

## Troubleshooting

| Problem | Cause | Fix |
|---|---|---|
| `manifest.csv not found in ZIP` | The redo ZIP is corrupt or not a SegCheck export | Re-download from My Redo |
| `instance_id not found in redo manifest` | `index.csv` has a wrong UUID | Copy `instance_id` directly from the manifest |
| `The ZIP was rejected — correction file not found` | `correction_path` in manifest doesn't match the file inside the ZIP | Re-run the script; do not rename files manually |
| `mask % is not assigned to the submitting reviewer` | Uploading someone else's redo item | Only upload your own batch |
| `mask % is not in fail status` | The mask was already fixed by another upload | Nothing to do — already recorded |
| Dimension mismatch reported | Mask saved at wrong resolution | Re-export from your annotation tool at the photo's native resolution |

---

## What the script does NOT do

- It does **not** modify the original redo ZIP.
- It does **not** edit or overwrite any existing masks on disk.
- It does **not** interact with SegCheck or the network — it only produces a local ZIP.
- It does **not** support individual file uploads (use the ZIP workflow).
