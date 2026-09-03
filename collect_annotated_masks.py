#!/usr/bin/env python3
"""Collect finished masks out of annotation_workspace/ into a correction ZIP
that can be uploaded directly through the SegCheck "Upload corrections" button.

Workflow
--------
1.  Download your redo batch from SegCheck (MyRedo → Download my redo batch).
    That ZIP contains manifest.csv, photos/, masks/, and previews/.
2.  Open the manifest.csv and use the `correction_path` column to know where
    each corrected file must live inside the ZIP you will upload.
3.  For every failed instance, annotate the mask and save it as
    `mask_final.png` (or `mask_final.json` for COCO format) inside its
    `annotation_workspace/<instance_folder>/` directory.
4.  Run this script — it reads `annotation_workspace/index.csv` (which must
    have an `instance_id` column linking each folder to the redo manifest),
    validates dimensions for PNG masks, and assembles a correction ZIP.
5.  Upload the resulting ZIP through SegCheck (MyRedo → Upload corrections).

index.csv columns (required)
-----------------------------
  instance_folder   — subdirectory name inside annotation_workspace/
  instance_id       — the UUID from the redo manifest (instance_id column)

Optional columns forwarded from the redo manifest (used for ZIP assembly):
  correction_path   — relative path inside the ZIP, e.g. corrections/<id>.png
                      Derived automatically from instance_id if absent.
  format            — 'png' or 'coco_json' (defaults to 'png')

Old-format redo ZIPs
---------------------
A redo ZIP downloaded before the correction-upload feature shipped has a
manifest.csv without project_id/batch_id/correction_path/format columns.
This script detects that and synthesizes them in the output manifest so it
can still be uploaded — correction_path and format are derived the same way
regardless; project_id and batch_id can't be recovered from old data and are
left blank unless supplied via --project-id/--batch-id.

Leaving project_id blank loses the "wrong project" cross-check the uploader
otherwise does. To restore it: open ANY current redo export for the same
project (even one with completely different instances — the value doesn't
change per batch) and copy its project_id column value, then pass it here:
    python3 collect_annotated_masks.py --redo-zip old.zip --project-id <uuid>

Run as you go, or once at the end:
    python3 collect_annotated_masks.py [--redo-zip PATH] [--out PATH]

Options
-------
  --redo-zip PATH   Path to the downloaded redo ZIP (default: auto-detected
                    from the most recent *.redo.zip in the project root).
  --out PATH        Output correction ZIP path (default:
                    corrections-<batchId>.zip next to this script).
  --project-id ID   project_id to stamp on the output manifest when the
                    source redo ZIP predates the correction-upload feature
                    and has no project_id column of its own.
  --batch-id ID     batch_id to stamp on the output manifest/filename when
                    the source redo ZIP has no batch_id column of its own.
  --dry-run         Validate and report without writing the output ZIP.
"""

import argparse
import csv
import io
import os
import struct
import sys
import zipfile


ROOT = os.path.dirname(os.path.abspath(__file__))
WORKSPACE = os.path.join(ROOT, "annotation_workspace")
INDEX = os.path.join(WORKSPACE, "index.csv")

# Columns SegCheck's correction-ZIP uploader requires in manifest.csv.
# Redo ZIPs downloaded before the correction-upload feature shipped don't
# have these — see build_augmented_manifest() below.
REQUIRED_UPLOAD_COLUMNS = ["project_id", "batch_id", "correction_path", "format"]


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def find_header_index(lines):
    """Return the index of the real CSV header row among `lines`.

    Instruction/comment lines may precede it, quoted or not (the exporter
    only quotes a field when it contains a comma/quote/newline, which those
    sentences usually don't) — so detect the header by its first field
    rather than by a leading quote character.
    """
    return next(
        (i for i, line in enumerate(lines)
         if line.strip() and line.split(",", 1)[0].strip().strip('"') == "photo_filename"),
        None,
    )

def dims(path):
    """Return (width, height) of a PNG or JPEG image.

    Reads the dimensions straight out of the file's own header — no
    external tool or third-party package required, so this works the same
    on macOS, Windows, and Linux (photos are JPEG, masks are PNG).
    """
    with open(path, "rb") as f:
        head = f.read(24)

        if head[:8] == b"\x89PNG\r\n\x1a\n":
            # IHDR is always the first chunk; width/height are the two
            # big-endian uint32s right after the 8-byte length+type prefix.
            width, height = struct.unpack(">II", head[16:24])
            return width, height

        if head[:2] == b"\xff\xd8":
            f.seek(2)
            while True:
                marker = f.read(2)
                if len(marker) < 2 or marker[0] != 0xFF:
                    raise ValueError(f"malformed JPEG (no marker): {path}")
                seg_type = marker[1]
                if seg_type == 0xD8 or 0xD0 <= seg_type <= 0xD7:
                    continue  # markers with no payload (SOI / restart)
                if seg_type == 0xD9:
                    raise ValueError(f"no frame marker (SOF) found in JPEG: {path}")
                seg_len_bytes = f.read(2)
                if len(seg_len_bytes) < 2:
                    raise ValueError(f"malformed JPEG (truncated segment): {path}")
                seg_len = struct.unpack(">H", seg_len_bytes)[0]
                # SOFn markers carry the dimensions; C4/C8/CC are not SOF.
                if seg_type in (0xC0, 0xC1, 0xC2, 0xC3, 0xC5, 0xC6, 0xC7,
                                0xC9, 0xCA, 0xCB, 0xCD, 0xCE, 0xCF):
                    f.read(1)  # sample precision byte
                    height, width = struct.unpack(">HH", f.read(4))
                    return width, height
                f.seek(seg_len - 2, 1)

        raise ValueError(f"unsupported image format (expected PNG or JPEG): {path}")


def find_redo_zip():
    """Return the path of the most recently modified *.redo.zip in ROOT."""
    candidates = [
        os.path.join(ROOT, f)
        for f in os.listdir(ROOT)
        if f.endswith("-redo.zip") or f.endswith(".redo.zip")
    ]
    if not candidates:
        return None
    return max(candidates, key=os.path.getmtime)


def read_redo_manifest(redo_zip_path):
    """Read manifest.csv from the redo ZIP.

    Returns a dict mapping instance_id → manifest row dict, and the batch_id
    extracted from the first data row (all rows share the same batch).
    """
    with zipfile.ZipFile(redo_zip_path, "r") as zf:
        names = zf.namelist()
        manifest_name = next(
            (n for n in names if os.path.basename(n) == "manifest.csv"), None
        )
        if not manifest_name:
            raise FileNotFoundError(
                f"manifest.csv not found in {redo_zip_path}.\n"
                "Make sure you downloaded the redo ZIP from SegCheck."
            )
        with zf.open(manifest_name) as f:
            text = io.TextIOWrapper(f, encoding="utf-8-sig")
            all_lines = text.readlines()
            header_index = find_header_index(all_lines)
            if header_index is None:
                raise ValueError("manifest.csv is empty or has no header row.")
            lines = [l for l in all_lines[header_index:] if l.strip()]
            reader = csv.DictReader(lines)
            rows = {}
            batch_id = ""
            project_id = ""
            for r in reader:
                iid = (r.get("instance_id") or "").strip()
                if not iid or iid.upper().startswith("TOTAL"):
                    continue
                rows[iid] = r
                if not batch_id:
                    batch_id = (r.get("batch_id") or "").strip()
                if not project_id:
                    project_id = (r.get("project_id") or "").strip()
    return rows, batch_id, project_id


def partial_manifest(manifest_bytes, included_ids):
    """Return the redo manifest containing only the collected instances."""
    text = manifest_bytes.decode("utf-8-sig")
    lines = text.splitlines()
    header_index = find_header_index(lines)
    if header_index is None:
        raise ValueError("manifest.csv has no header row")

    header = next(csv.reader([lines[header_index]]))
    instance_index = header.index("instance_id")
    selected = lines[:header_index + 1]
    manifest_ids = set()
    selected_count = 0
    for line in lines[header_index + 1:]:
        if not line.strip():
            continue
        fields = next(csv.reader([line]))
        instance_id = fields[instance_index].strip() if len(fields) > instance_index else ""
        if instance_id and not instance_id.upper().startswith("TOTAL"):
            manifest_ids.add(instance_id)
        if instance_id in included_ids:
            selected.append(line)
            selected_count += 1

    if manifest_ids.issubset(included_ids):
        return manifest_bytes

    selected.extend(["", f'"TOTAL: {selected_count}"'])
    return ("\n".join(selected) + "\n").encode("utf-8")


def missing_upload_columns(manifest_bytes):
    """Return the subset of REQUIRED_UPLOAD_COLUMNS absent from manifest_bytes's
    header — i.e. what a pre-correction-upload-feature redo ZIP is missing."""
    lines = manifest_bytes.decode("utf-8-sig").splitlines()
    header_index = find_header_index(lines)
    if header_index is None:
        raise ValueError("manifest.csv has no header row")
    header = next(csv.reader([lines[header_index]]))
    return [c for c in REQUIRED_UPLOAD_COLUMNS if c not in header]


def build_augmented_manifest(manifest_bytes, manifest_rows, included_ids, missing_cols,
                              project_id="", batch_id=""):
    """Rewrite an old-format manifest (missing one or more of
    REQUIRED_UPLOAD_COLUMNS) so the output satisfies SegCheck's uploader.

    Existing columns are kept as-is; only the missing ones are appended:
      - correction_path — corrections/<instance_id>.<ext>, the same formula
        the modern exporter and the collector's own fallback use.
      - format           — derived from the row's mask_path extension
        ('.json' → coco_json, else png); missing-reason rows have no
        mask_path and default to png.
      - project_id/batch_id — not recoverable from old data; left blank
        unless the caller supplies overrides (see --project-id/--batch-id).
    """
    text = manifest_bytes.decode("utf-8-sig")
    lines = text.splitlines()
    header_index = find_header_index(lines)
    if header_index is None:
        raise ValueError("manifest.csv has no header row")

    preamble = lines[:header_index]
    header = next(csv.reader([lines[header_index]]))
    new_cols = [c for c in REQUIRED_UPLOAD_COLUMNS if c in missing_cols]
    field_index = {name: i for i, name in enumerate(header)}
    instance_i = field_index["instance_id"]
    mask_path_i = field_index.get("mask_path")

    out = io.StringIO()
    writer = csv.writer(out, lineterminator="\n")
    for line in preamble:
        out.write(line + "\n")
    writer.writerow(header + new_cols)

    override_values = {"project_id": project_id or "", "batch_id": batch_id or ""}
    selected_count = 0
    for line in lines[header_index + 1:]:
        if not line.strip():
            continue
        fields = next(csv.reader([line]))
        instance_id = fields[instance_i].strip() if len(fields) > instance_i else ""
        if not instance_id or instance_id.upper().startswith("TOTAL"):
            continue
        if instance_id not in included_ids:
            continue

        row = manifest_rows.get(instance_id, {})
        mask_path = fields[mask_path_i] if mask_path_i is not None and len(fields) > mask_path_i else ""
        fmt = (row.get("format") or "").strip() or ("coco_json" if mask_path.lower().endswith(".json") else "png")
        ext = "json" if fmt == "coco_json" else "png"
        correction_path = (row.get("correction_path") or "").strip() or f"corrections/{instance_id}.{ext}"

        computed = {"correction_path": correction_path, "format": fmt, **override_values}
        writer.writerow(fields + [computed[c] for c in new_cols])
        selected_count += 1

    writer.writerow([])
    writer.writerow([f"TOTAL: {selected_count}"])
    return out.getvalue().encode("utf-8")


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    # Windows consoles often default to a legacy, non-UTF-8 codepage, which
    # raises UnicodeEncodeError on the →/—/… characters printed below.
    # macOS/Linux terminals are already UTF-8, so this is a no-op there.
    if hasattr(sys.stdout, "reconfigure"):
        try:
            sys.stdout.reconfigure(encoding="utf-8", errors="replace")
        except Exception:
            pass

    parser = argparse.ArgumentParser(
        description="Collect annotated masks and assemble a SegCheck correction ZIP."
    )
    parser.add_argument(
        "--redo-zip",
        metavar="PATH",
        help="Path to the downloaded redo ZIP. Auto-detected if omitted.",
    )
    parser.add_argument(
        "--out",
        metavar="PATH",
        help="Output correction ZIP path. Defaults to corrections-<batchId>.zip.",
    )
    parser.add_argument(
        "--project-id",
        metavar="ID",
        help=(
            "project_id to stamp on the output manifest when the source "
            "redo ZIP predates the correction-upload feature and has no "
            "project_id column of its own."
        ),
    )
    parser.add_argument(
        "--batch-id",
        metavar="ID",
        help=(
            "batch_id to stamp on the output manifest/filename when the "
            "source redo ZIP has no batch_id column of its own."
        ),
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Validate and report without writing the output ZIP.",
    )
    args = parser.parse_args()

    # ── Locate the redo ZIP ────────────────────────────────────────────────
    redo_zip_path = args.redo_zip
    if not redo_zip_path:
        redo_zip_path = find_redo_zip()
    if not redo_zip_path or not os.path.exists(redo_zip_path):
        sys.exit(
            "ERROR: Could not find a redo ZIP. Download your batch from SegCheck\n"
            "       and pass its path with --redo-zip, or place it in the project root."
        )
    print(f"Using redo ZIP: {redo_zip_path}")

    # ── Read redo manifest ─────────────────────────────────────────────────
    try:
        manifest_rows, batch_id, project_id = read_redo_manifest(redo_zip_path)
    except Exception as e:
        sys.exit(f"ERROR reading redo manifest: {e}")

    batch_id = args.batch_id or batch_id
    project_id = args.project_id or project_id

    print(f"Manifest: {len(manifest_rows)} instance(s), batch={batch_id!r}, project={project_id!r}")

    # ── Read annotation workspace index ───────────────────────────────────
    if not os.path.exists(INDEX):
        sys.exit(
            f"ERROR: {INDEX} not found.\n"
            "       Create annotation_workspace/index.csv with columns:\n"
            "         instance_folder, instance_id"
        )

    with open(INDEX, newline="", encoding="utf-8-sig") as f:
        index_rows = list(csv.DictReader(f))

    required_cols = {"instance_folder", "instance_id"}
    if index_rows:
        missing = required_cols - set(index_rows[0].keys())
        if missing:
            sys.exit(
                f"ERROR: index.csv is missing required column(s): {', '.join(sorted(missing))}"
            )

    # ── Validate and collect masks ─────────────────────────────────────────
    done, missing_mask, bad_dims, unknown_id = [], [], [], []

    # Entries to include in the output ZIP: list of (zip_path, src_file_path).
    zip_entries = []
    collected_ids = set()

    for r in index_rows:
        instance_folder = r["instance_folder"].strip()
        instance_id = r["instance_id"].strip()

        if not instance_id:
            continue

        # Match to the redo manifest.
        manifest_row = manifest_rows.get(instance_id)
        if manifest_row is None:
            unknown_id.append((instance_folder, instance_id))
            continue

        inst_dir = os.path.join(WORKSPACE, instance_folder)

        # Determine the expected format from the manifest, falling back to png.
        fmt = manifest_row.get("format", "png").strip() or "png"
        ext = "json" if fmt == "coco_json" else "png"

        # The corrected file must be named mask_final.<ext> in the instance dir.
        final = os.path.join(inst_dir, f"mask_final.{ext}")
        if not os.path.exists(final):
            # Also accept mask_final.png for coco_json (annotator saved as png)
            fallback = os.path.join(inst_dir, "mask_final.png")
            if ext == "json" and os.path.exists(fallback):
                # Treat as PNG correction even though manifest says coco_json.
                # The preflight will catch a format mismatch by extension, so
                # we only accept .json files here.
                pass
            missing_mask.append(instance_folder)
            continue

        # Dimension check for PNG masks.
        if ext == "png":
            photo = os.path.join(inst_dir, "photo.jpg")
            if os.path.exists(photo):
                try:
                    pw, ph = dims(photo)
                    mw, mh = dims(final)
                    if (pw, ph) != (mw, mh):
                        bad_dims.append((instance_folder, (pw, ph), (mw, mh)))
                        continue
                except Exception as e:
                    print(f"  WARN: dimension check failed for {instance_folder}: {e}")

        # Use the correction_path from the manifest if available, otherwise
        # derive it: corrections/<instance_id>.<ext>
        correction_path = manifest_row.get("correction_path", "").strip()
        if not correction_path:
            correction_path = f"corrections/{instance_id}.{ext}"

        zip_entries.append((correction_path, final))
        collected_ids.add(instance_id)
        done.append(instance_folder)

    # ── Report ─────────────────────────────────────────────────────────────
    print(f"\nCollected: {len(done)}/{len(index_rows)}")

    if bad_dims:
        print(f"\nDimension mismatch — NOT collected ({len(bad_dims)}):")
        for folder, p, m in bad_dims:
            print(f"  {folder}: photo={p}  mask_final={m}")

    if missing_mask:
        print(f"\nMask not done yet ({len(missing_mask)}):")
        for m in missing_mask[:20]:
            print(f"  {m}")
        if len(missing_mask) > 20:
            print(f"  … and {len(missing_mask) - 20} more")

    if unknown_id:
        print(f"\ninstance_id not found in redo manifest ({len(unknown_id)}):")
        for folder, iid in unknown_id[:10]:
            print(f"  {folder}  (instance_id={iid!r})")
        if len(unknown_id) > 10:
            print(f"  … and {len(unknown_id) - 10} more")

    if not zip_entries:
        print("\nNothing to package. Exiting without writing a ZIP.")
        return

    if args.dry_run:
        print("\n--dry-run: skipping ZIP creation.")
        print("Would include:")
        for zp, _ in zip_entries:
            print(f"  {zp}")
        return

    # ── Assemble the correction ZIP ────────────────────────────────────────
    out_path = args.out
    if not out_path:
        label = batch_id or "corrections"
        out_path = os.path.join(ROOT, f"corrections-{label}.zip")

    # Copy the original manifest.csv from the redo ZIP so the importer can
    # parse project_id, batch_id, and correction_path for every instance.
    with zipfile.ZipFile(redo_zip_path, "r") as zf:
        manifest_name = next(
            n for n in zf.namelist() if os.path.basename(n) == "manifest.csv"
        )
        manifest_bytes = zf.read(manifest_name)

    missing_cols = missing_upload_columns(manifest_bytes)
    if missing_cols:
        print(
            f"\nNote: this redo ZIP predates the correction-upload feature "
            f"(missing column(s): {', '.join(missing_cols)}). Synthesizing "
            f"them in the output manifest so it can still be uploaded."
        )
        if "project_id" in missing_cols and not project_id:
            print(
                "      No --project-id given, so the wrong-project safety "
                "check will be skipped for this upload. See --help for how "
                "to restore it."
            )
        manifest_bytes = build_augmented_manifest(
            manifest_bytes, manifest_rows, collected_ids, missing_cols,
            project_id=project_id, batch_id=batch_id,
        )
    else:
        manifest_bytes = partial_manifest(manifest_bytes, collected_ids)

    print(f"\nWriting correction ZIP → {out_path}")
    with zipfile.ZipFile(out_path, "w", compression=zipfile.ZIP_DEFLATED) as zout:
        # Always include the manifest at the root of the ZIP.
        zout.writestr("manifest.csv", manifest_bytes)
        for zip_path, src_path in zip_entries:
            zout.write(src_path, zip_path)
            print(f"  + {zip_path}")

    size_kb = os.path.getsize(out_path) / 1024
    print(f"\nDone. {len(zip_entries)} correction(s) packaged ({size_kb:.1f} KB).")
    print(f"Upload {os.path.basename(out_path)} via SegCheck → My Redo → Upload corrections.")


if __name__ == "__main__":
    main()
