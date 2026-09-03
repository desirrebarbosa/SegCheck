#!/usr/bin/env python3
"""Tests for collect_annotated_masks.py

Run with:  python3 -m pytest test_collect_annotated_masks.py -v
"""

import csv
import io
import os
import struct
import sys
import textwrap
import zipfile
from pathlib import Path
from unittest import mock

import pytest

# ---------------------------------------------------------------------------
# Make the script importable (it lives next to this test file)
# ---------------------------------------------------------------------------
sys.path.insert(0, os.path.dirname(__file__))
import collect_annotated_masks as cam


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _make_redo_zip(tmp_path, manifest_rows, batch_id="batch-1", project_id="proj-1"):
    """Build a minimal redo ZIP whose manifest.csv matches SegCheck's format."""
    header = [
        "photo_filename", "instance_id", "manifest_mask_id", "category",
        "reason", "bbox_x", "bbox_y", "bbox_w", "bbox_h",
        "assigned_to_email", "preview_path", "mask_path",
        "project_id", "batch_id", "split", "correction_path", "format",
    ]
    # Real exports (exportRedo.js) only quote a CSV field when it contains a
    # comma/quote/newline — these instruction sentences don't, so they come
    # through unquoted. Keep this fixture unquoted too so tests catch header
    # detection bugs that only show up against realistic input.
    lines = [
        "This zip contains photos and masks that failed QA review.",
        "reason=missing: no mask was ever produced.",
        "reason=rejected: a mask existed but was rejected.",
        "preview_path is a flattened image.",
        "correction_path: place your corrected file at this path.",
        "",
        ",".join(header),
    ]
    for r in manifest_rows:
        iid = r["instance_id"]
        fmt = r.get("format", "png")
        ext = "json" if fmt == "coco_json" else "png"
        cp = r.get("correction_path", f"corrections/{iid}.{ext}")
        lines.append(",".join([
            r.get("photo_filename", "photo.jpg"),
            iid,
            r.get("manifest_mask_id", ""),
            r.get("category", "fish"),
            r.get("reason", "rejected"),
            "0", "0", "10", "10",
            r.get("email", "a@b.com"),
            f"previews/photo.jpg/{iid}.png",
            "",
            r.get("project_id", project_id),
            r.get("batch_id", batch_id),
            r.get("split", "val"),
            cp,
            fmt,
        ]))
    lines += ["", f'"TOTAL: {len(manifest_rows)} (missing: 0, rejected: {len(manifest_rows)})"']
    manifest_csv = "\n".join(lines)

    zip_path = tmp_path / "my-redo.zip"
    with zipfile.ZipFile(zip_path, "w") as zf:
        zf.writestr("manifest.csv", manifest_csv)
    return zip_path, manifest_csv


def _make_old_format_redo_zip(tmp_path, manifest_rows):
    """Build a redo ZIP whose manifest.csv predates the correction-upload
    feature — no project_id/batch_id/correction_path/format columns, matching
    what build_annotation_workspace.py-era exports actually look like."""
    header = [
        "photo_filename", "instance_id", "manifest_mask_id", "category",
        "reason", "bbox_x", "bbox_y", "bbox_w", "bbox_h",
        "assigned_to_email", "preview_path", "mask_path",
    ]
    lines = [
        "This zip contains photos and masks that failed QA review and need re-annotation.",
        "reason=missing: no mask was ever produced for this object (do it from scratch).",
        "reason=rejected: a mask existed but a reviewer rejected it (redo/fix it).",
        "preview_path is a flattened image showing exactly which object is flagged.",
        "",
        ",".join(header),
    ]
    for r in manifest_rows:
        iid = r["instance_id"]
        lines.append(",".join([
            r.get("photo_filename", "photo.jpg"),
            iid,
            r.get("manifest_mask_id", ""),
            r.get("category", "fish"),
            r.get("reason", "rejected"),
            "0", "0", "10", "10",
            r.get("email", "a@b.com"),
            f"previews/photo.jpg/{iid}.png",
            r.get("mask_path", f"masks/photo.jpg/{iid}-ann.png"),
        ]))
    lines += ["", f'"TOTAL: {len(manifest_rows)}"']
    manifest_csv = "\n".join(lines)

    zip_path = tmp_path / "old-redo.zip"
    with zipfile.ZipFile(zip_path, "w") as zf:
        zf.writestr("manifest.csv", manifest_csv)
    return zip_path, manifest_csv


def _rows_from_manifest_bytes(tmp_path, manifest_bytes, name="check.zip"):
    """Round-trip manifest bytes through read_redo_manifest for assertions,
    reusing its already-tested parsing instead of re-deriving line indices."""
    zip_path = tmp_path / name
    with zipfile.ZipFile(zip_path, "w") as zf:
        zf.writestr("manifest.csv", manifest_bytes)
    return cam.read_redo_manifest(str(zip_path))


def _make_workspace(tmp_path, instances):
    """Set up annotation_workspace/ with index.csv and instance folders.

    `instances` is a list of dicts:
        instance_folder, instance_id,
        has_mask (bool), mask_filename (str, default 'mask_final.png'),
        photo_dims (w,h) or None to skip photo,
        mask_dims (w,h) or None to use photo_dims
    """
    ws = tmp_path / "annotation_workspace"
    ws.mkdir()

    index_rows = []
    for inst in instances:
        folder = inst["instance_folder"]
        inst_dir = ws / folder
        inst_dir.mkdir(parents=True, exist_ok=True)

        index_rows.append({
            "instance_folder": folder,
            "instance_id": inst["instance_id"],
        })

        if inst.get("has_mask", True):
            mask_name = inst.get("mask_filename", "mask_final.png")
            (inst_dir / mask_name).write_bytes(b"PNG")

        if inst.get("photo_dims"):
            (inst_dir / "photo.jpg").write_bytes(b"JPG")

    index_path = ws / "index.csv"
    with open(index_path, "w", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=["instance_folder", "instance_id"])
        writer.writeheader()
        writer.writerows(index_rows)

    return ws, index_path


def _make_png_bytes(width, height):
    """Minimal PNG: signature + IHDR only (dims() never reads past IHDR)."""
    sig = b"\x89PNG\r\n\x1a\n"
    ihdr_data = struct.pack(">IIBBBBB", width, height, 8, 0, 0, 0, 0)
    ihdr_chunk = struct.pack(">I", len(ihdr_data)) + b"IHDR" + ihdr_data
    return sig + ihdr_chunk


def _make_jpeg_bytes(width, height):
    """Minimal JPEG: SOI + a bare SOF0 segment (not a decodable image, but
    enough for dims(), which only scans markers up to the first SOF)."""
    sof0_payload = struct.pack(">BHHB", 8, height, width, 1) + b"\x01\x11\x00"
    sof0 = b"\xff\xc0" + struct.pack(">H", len(sof0_payload) + 2) + sof0_payload
    return b"\xff\xd8" + sof0


# ---------------------------------------------------------------------------
# dims — cross-platform (pure Python) PNG/JPEG header parsing
# ---------------------------------------------------------------------------

class TestDims:
    def test_reads_png_dimensions(self, tmp_path):
        path = tmp_path / "mask.png"
        path.write_bytes(_make_png_bytes(800, 600))
        assert cam.dims(str(path)) == (800, 600)

    def test_reads_jpeg_dimensions(self, tmp_path):
        path = tmp_path / "photo.jpg"
        path.write_bytes(_make_jpeg_bytes(1024, 768))
        assert cam.dims(str(path)) == (1024, 768)

    def test_raises_on_unsupported_format(self, tmp_path):
        path = tmp_path / "mask.bmp"
        path.write_bytes(b"BM" + b"\x00" * 32)
        with pytest.raises(ValueError, match="unsupported image format"):
            cam.dims(str(path))


# ---------------------------------------------------------------------------
# read_redo_manifest
# ---------------------------------------------------------------------------

class TestReadRedoManifest:
    def test_parses_batch_and_project_ids(self, tmp_path):
        zip_path, _ = _make_redo_zip(tmp_path, [
            {"instance_id": "uuid-1"},
            {"instance_id": "uuid-2"},
        ], batch_id="b42", project_id="p99")
        rows, batch_id, project_id = cam.read_redo_manifest(str(zip_path))
        assert "uuid-1" in rows
        assert "uuid-2" in rows
        assert batch_id == "b42"
        assert project_id == "p99"

    def test_correction_path_is_preserved(self, tmp_path):
        zip_path, _ = _make_redo_zip(tmp_path, [
            {"instance_id": "uuid-1", "correction_path": "corrections/uuid-1.png"},
        ])
        rows, _, _ = cam.read_redo_manifest(str(zip_path))
        assert rows["uuid-1"]["correction_path"] == "corrections/uuid-1.png"

    def test_format_field_is_preserved(self, tmp_path):
        zip_path, _ = _make_redo_zip(tmp_path, [
            {"instance_id": "uuid-json", "format": "coco_json",
             "correction_path": "corrections/uuid-json.json"},
        ])
        rows, _, _ = cam.read_redo_manifest(str(zip_path))
        assert rows["uuid-json"]["format"] == "coco_json"

    def test_skips_comment_lines(self, tmp_path):
        # The helper already inserts 5 comment lines; verify they don't
        # accidentally become data rows.
        zip_path, _ = _make_redo_zip(tmp_path, [{"instance_id": "uuid-1"}])
        rows, _, _ = cam.read_redo_manifest(str(zip_path))
        assert len(rows) == 1

    def test_raises_when_manifest_missing(self, tmp_path):
        zip_path = tmp_path / "empty.zip"
        with zipfile.ZipFile(zip_path, "w"):
            pass
        with pytest.raises(FileNotFoundError, match="manifest.csv not found"):
            cam.read_redo_manifest(str(zip_path))

    def test_skips_total_summary_row(self, tmp_path):
        zip_path, _ = _make_redo_zip(tmp_path, [{"instance_id": "uuid-1"}])
        rows, _, _ = cam.read_redo_manifest(str(zip_path))
        # The TOTAL row must not appear as an instance.
        assert not any(k.upper().startswith("TOTAL") for k in rows)


# ---------------------------------------------------------------------------
# missing_upload_columns / build_augmented_manifest — old-format support
# ---------------------------------------------------------------------------

class TestMissingUploadColumns:
    def test_modern_manifest_has_no_missing_columns(self, tmp_path):
        _, manifest_csv = _make_redo_zip(tmp_path, [{"instance_id": "uuid-1"}])
        assert cam.missing_upload_columns(manifest_csv.encode("utf-8")) == []

    def test_old_manifest_reports_all_four_missing(self, tmp_path):
        _, manifest_csv = _make_old_format_redo_zip(tmp_path, [{"instance_id": "uuid-1"}])
        missing = cam.missing_upload_columns(manifest_csv.encode("utf-8"))
        assert set(missing) == {"project_id", "batch_id", "correction_path", "format"}


class TestBuildAugmentedManifest:
    def test_derives_correction_path_and_format_from_mask_path(self, tmp_path):
        zip_path, manifest_csv = _make_old_format_redo_zip(tmp_path, [
            {"instance_id": "uuid-1", "mask_path": "masks/photo.jpg/1-ann.png"},
            {"instance_id": "uuid-2", "mask_path": "masks/photo.jpg/2-ann.json"},
        ])
        manifest_bytes = manifest_csv.encode("utf-8")
        manifest_rows, _, _ = cam.read_redo_manifest(str(zip_path))
        missing = cam.missing_upload_columns(manifest_bytes)

        augmented = cam.build_augmented_manifest(
            manifest_bytes, manifest_rows, {"uuid-1", "uuid-2"}, missing,
        )
        rows, _, _ = _rows_from_manifest_bytes(tmp_path, augmented)

        assert rows["uuid-1"]["correction_path"] == "corrections/uuid-1.png"
        assert rows["uuid-1"]["format"] == "png"
        assert rows["uuid-2"]["correction_path"] == "corrections/uuid-2.json"
        assert rows["uuid-2"]["format"] == "coco_json"

    def test_missing_reason_row_with_no_mask_path_defaults_to_png(self, tmp_path):
        zip_path, manifest_csv = _make_old_format_redo_zip(tmp_path, [
            {"instance_id": "uuid-1", "reason": "missing", "mask_path": ""},
        ])
        manifest_bytes = manifest_csv.encode("utf-8")
        manifest_rows, _, _ = cam.read_redo_manifest(str(zip_path))
        missing = cam.missing_upload_columns(manifest_bytes)

        augmented = cam.build_augmented_manifest(manifest_bytes, manifest_rows, {"uuid-1"}, missing)
        rows, _, _ = _rows_from_manifest_bytes(tmp_path, augmented)
        assert rows["uuid-1"]["format"] == "png"

    def test_project_and_batch_id_blank_by_default(self, tmp_path):
        zip_path, manifest_csv = _make_old_format_redo_zip(tmp_path, [{"instance_id": "uuid-1"}])
        manifest_bytes = manifest_csv.encode("utf-8")
        manifest_rows, _, _ = cam.read_redo_manifest(str(zip_path))
        missing = cam.missing_upload_columns(manifest_bytes)

        augmented = cam.build_augmented_manifest(manifest_bytes, manifest_rows, {"uuid-1"}, missing)
        rows, _, _ = _rows_from_manifest_bytes(tmp_path, augmented)
        assert rows["uuid-1"]["project_id"] == ""
        assert rows["uuid-1"]["batch_id"] == ""

    def test_project_and_batch_id_use_overrides(self, tmp_path):
        zip_path, manifest_csv = _make_old_format_redo_zip(tmp_path, [{"instance_id": "uuid-1"}])
        manifest_bytes = manifest_csv.encode("utf-8")
        manifest_rows, _, _ = cam.read_redo_manifest(str(zip_path))
        missing = cam.missing_upload_columns(manifest_bytes)

        augmented = cam.build_augmented_manifest(
            manifest_bytes, manifest_rows, {"uuid-1"}, missing,
            project_id="proj-override", batch_id="batch-override",
        )
        rows, _, _ = _rows_from_manifest_bytes(tmp_path, augmented)
        assert rows["uuid-1"]["project_id"] == "proj-override"
        assert rows["uuid-1"]["batch_id"] == "batch-override"

    def test_excludes_uncollected_instances(self, tmp_path):
        zip_path, manifest_csv = _make_old_format_redo_zip(tmp_path, [
            {"instance_id": "uuid-1"},
            {"instance_id": "uuid-2"},
        ])
        manifest_bytes = manifest_csv.encode("utf-8")
        manifest_rows, _, _ = cam.read_redo_manifest(str(zip_path))
        missing = cam.missing_upload_columns(manifest_bytes)

        augmented = cam.build_augmented_manifest(manifest_bytes, manifest_rows, {"uuid-1"}, missing)
        rows, _, _ = _rows_from_manifest_bytes(tmp_path, augmented)
        assert "uuid-1" in rows
        assert "uuid-2" not in rows


# ---------------------------------------------------------------------------
# find_redo_zip
# ---------------------------------------------------------------------------

class TestFindRedoZip:
    def test_finds_redo_zip(self, tmp_path, monkeypatch):
        monkeypatch.setattr(cam, "ROOT", str(tmp_path))
        zip1 = tmp_path / "project-redo.zip"
        zip1.write_bytes(b"")
        result = cam.find_redo_zip()
        assert result == str(zip1)

    def test_returns_none_when_absent(self, tmp_path, monkeypatch):
        monkeypatch.setattr(cam, "ROOT", str(tmp_path))
        assert cam.find_redo_zip() is None

    def test_picks_most_recent(self, tmp_path, monkeypatch):
        monkeypatch.setattr(cam, "ROOT", str(tmp_path))
        old = tmp_path / "old-redo.zip"
        old.write_bytes(b"")
        import time; time.sleep(0.05)
        new = tmp_path / "new-redo.zip"
        new.write_bytes(b"")
        result = cam.find_redo_zip()
        assert result == str(new)


# ---------------------------------------------------------------------------
# main() — integration tests using tmp_path fixtures
# ---------------------------------------------------------------------------

class TestMainIntegration:
    """End-to-end tests that call main() with patched ROOT/WORKSPACE/INDEX."""

    def _run(self, tmp_path, extra_argv=None):
        """Patch filesystem roots and run main(), returning the output ZIP path."""
        monkeypatch_attrs = {
            "ROOT": str(tmp_path),
            "WORKSPACE": str(tmp_path / "annotation_workspace"),
            "INDEX": str(tmp_path / "annotation_workspace" / "index.csv"),
        }
        argv = ["collect_annotated_masks.py"]
        if extra_argv:
            argv += extra_argv

        with mock.patch.multiple(cam, **monkeypatch_attrs):
            with mock.patch("sys.argv", argv):
                cam.main()

    def test_happy_path_creates_zip(self, tmp_path):
        zip_path, _ = _make_redo_zip(tmp_path, [{"instance_id": "uuid-1"}])
        _make_workspace(tmp_path, [
            {"instance_folder": "inst-1", "instance_id": "uuid-1", "has_mask": True},
        ])
        # Suppress dimension check (no real sips binary needed).
        with mock.patch.object(cam, "dims", side_effect=FileNotFoundError):
            self._run(tmp_path, ["--redo-zip", str(zip_path)])

        out_zips = list(tmp_path.glob("corrections-*.zip"))
        assert len(out_zips) == 1
        with zipfile.ZipFile(out_zips[0]) as zf:
            names = zf.namelist()
        assert "manifest.csv" in names
        assert "corrections/uuid-1.png" in names

    def test_dry_run_does_not_write_zip(self, tmp_path):
        zip_path, _ = _make_redo_zip(tmp_path, [{"instance_id": "uuid-1"}])
        _make_workspace(tmp_path, [
            {"instance_folder": "inst-1", "instance_id": "uuid-1", "has_mask": True},
        ])
        with mock.patch.object(cam, "dims", side_effect=FileNotFoundError):
            self._run(tmp_path, ["--redo-zip", str(zip_path), "--dry-run"])

        assert not list(tmp_path.glob("corrections-*.zip"))

    def test_missing_mask_not_included(self, tmp_path):
        zip_path, _ = _make_redo_zip(tmp_path, [
            {"instance_id": "uuid-1"},
            {"instance_id": "uuid-2"},
        ])
        _make_workspace(tmp_path, [
            {"instance_folder": "inst-1", "instance_id": "uuid-1", "has_mask": True},
            {"instance_folder": "inst-2", "instance_id": "uuid-2", "has_mask": False},
        ])
        with mock.patch.object(cam, "dims", side_effect=FileNotFoundError):
            self._run(tmp_path, ["--redo-zip", str(zip_path)])

        out_zips = list(tmp_path.glob("corrections-*.zip"))
        with zipfile.ZipFile(out_zips[0]) as zf:
            names = zf.namelist()
            manifest = zf.read("manifest.csv").decode("utf-8")
        assert "corrections/uuid-1.png" in names
        assert "corrections/uuid-2.png" not in names
        assert "uuid-1" in manifest
        assert "uuid-2" not in manifest

    def test_dimension_mismatch_not_included(self, tmp_path):
        zip_path, _ = _make_redo_zip(tmp_path, [{"instance_id": "uuid-1"}])
        ws = tmp_path / "annotation_workspace"
        (ws / "inst-1").mkdir(parents=True)
        (ws / "inst-1" / "mask_final.png").write_bytes(b"PNG")
        (ws / "inst-1" / "photo.jpg").write_bytes(b"JPG")
        with open(ws / "index.csv", "w", newline="") as f:
            w = csv.DictWriter(f, fieldnames=["instance_folder", "instance_id"])
            w.writeheader()
            w.writerow({"instance_folder": "inst-1", "instance_id": "uuid-1"})

        # photo=800×600, mask=400×300 → mismatch
        def fake_dims(path):
            if "photo" in path:
                return (800, 600)
            return (400, 300)

        with mock.patch.multiple(cam, ROOT=str(tmp_path), WORKSPACE=str(ws),
                                 INDEX=str(ws / "index.csv")):
            with mock.patch.object(cam, "dims", side_effect=fake_dims):
                with mock.patch("sys.argv", ["collect_annotated_masks.py",
                                             "--redo-zip", str(zip_path)]):
                    cam.main()

        # No output ZIP should have any correction entry.
        out_zips = list(tmp_path.glob("corrections-*.zip"))
        if out_zips:
            with zipfile.ZipFile(out_zips[0]) as zf:
                assert "corrections/uuid-1.png" not in zf.namelist()

    def test_unknown_instance_id_reported(self, tmp_path, capsys):
        zip_path, _ = _make_redo_zip(tmp_path, [{"instance_id": "uuid-known"}])
        _make_workspace(tmp_path, [
            {"instance_folder": "inst-1", "instance_id": "uuid-UNKNOWN", "has_mask": True},
        ])
        with mock.patch.object(cam, "dims", side_effect=FileNotFoundError):
            self._run(tmp_path, ["--redo-zip", str(zip_path)])

        captured = capsys.readouterr()
        assert "uuid-UNKNOWN" in captured.out
        assert "not found in redo manifest" in captured.out

    def test_custom_out_path(self, tmp_path):
        zip_path, _ = _make_redo_zip(tmp_path, [{"instance_id": "uuid-1"}])
        _make_workspace(tmp_path, [
            {"instance_folder": "inst-1", "instance_id": "uuid-1", "has_mask": True},
        ])
        custom_out = str(tmp_path / "my-custom-output.zip")
        with mock.patch.object(cam, "dims", side_effect=FileNotFoundError):
            self._run(tmp_path, ["--redo-zip", str(zip_path), "--out", custom_out])

        assert os.path.exists(custom_out)

    def test_manifest_csv_is_copied_verbatim(self, tmp_path):
        """The manifest.csv in the output ZIP must be identical to the redo ZIP's."""
        zip_path, original_manifest = _make_redo_zip(
            tmp_path, [{"instance_id": "uuid-1"}]
        )
        _make_workspace(tmp_path, [
            {"instance_folder": "inst-1", "instance_id": "uuid-1", "has_mask": True},
        ])
        with mock.patch.object(cam, "dims", side_effect=FileNotFoundError):
            self._run(tmp_path, ["--redo-zip", str(zip_path)])

        out_zips = list(tmp_path.glob("corrections-*.zip"))
        with zipfile.ZipFile(out_zips[0]) as zf:
            actual = zf.read("manifest.csv").decode("utf-8")
        assert actual == original_manifest

    def test_old_format_manifest_gets_required_columns_added(self, tmp_path):
        zip_path, _ = _make_old_format_redo_zip(tmp_path, [
            {"instance_id": "uuid-1", "mask_path": "masks/photo.jpg/1-ann.png"},
        ])
        _make_workspace(tmp_path, [
            {"instance_folder": "inst-1", "instance_id": "uuid-1", "has_mask": True},
        ])
        with mock.patch.object(cam, "dims", side_effect=FileNotFoundError):
            self._run(tmp_path, ["--redo-zip", str(zip_path)])

        out_zips = list(tmp_path.glob("corrections-*.zip"))
        assert len(out_zips) == 1
        with zipfile.ZipFile(out_zips[0]) as zf:
            names = zf.namelist()
            manifest = zf.read("manifest.csv").decode("utf-8")
        assert "corrections/uuid-1.png" in names
        header = next(l for l in manifest.splitlines() if l.startswith("photo_filename")).split(",")
        for col in ("project_id", "batch_id", "correction_path", "format"):
            assert col in header

    def test_old_format_manifest_respects_project_and_batch_id_overrides(self, tmp_path):
        zip_path, _ = _make_old_format_redo_zip(tmp_path, [{"instance_id": "uuid-1"}])
        _make_workspace(tmp_path, [
            {"instance_folder": "inst-1", "instance_id": "uuid-1", "has_mask": True},
        ])
        with mock.patch.object(cam, "dims", side_effect=FileNotFoundError):
            self._run(tmp_path, [
                "--redo-zip", str(zip_path),
                "--project-id", "proj-xyz",
                "--batch-id", "batch-xyz",
            ])

        out_zips = list(tmp_path.glob("corrections-batch-xyz.zip"))
        assert len(out_zips) == 1
        with zipfile.ZipFile(out_zips[0]) as zf:
            manifest = zf.read("manifest.csv").decode("utf-8")
        assert "proj-xyz" in manifest
        assert "batch-xyz" in manifest

    def test_coco_json_format(self, tmp_path):
        """Instances with format=coco_json should be placed at corrections/<id>.json."""
        zip_path, _ = _make_redo_zip(tmp_path, [
            {"instance_id": "uuid-json", "format": "coco_json",
             "correction_path": "corrections/uuid-json.json"},
        ])
        ws = tmp_path / "annotation_workspace"
        (ws / "inst-json").mkdir(parents=True)
        (ws / "inst-json" / "mask_final.json").write_bytes(b'{"segmentation":[]}')
        with open(ws / "index.csv", "w", newline="") as f:
            w = csv.DictWriter(f, fieldnames=["instance_folder", "instance_id"])
            w.writeheader()
            w.writerow({"instance_folder": "inst-json", "instance_id": "uuid-json"})

        with mock.patch.multiple(cam, ROOT=str(tmp_path), WORKSPACE=str(ws),
                                 INDEX=str(ws / "index.csv")):
            with mock.patch("sys.argv", ["collect_annotated_masks.py",
                                         "--redo-zip", str(zip_path)]):
                cam.main()

        out_zips = list(tmp_path.glob("corrections-*.zip"))
        with zipfile.ZipFile(out_zips[0]) as zf:
            assert "corrections/uuid-json.json" in zf.namelist()
