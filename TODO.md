# TODO

## Production Supabase project needs the correction-upload migration applied

**Confirmed** (2026-09-03, via a real upload attempt: `Could not find the
function public.submit_corrections(...) in the schema cache`) — the live
project is missing the `submit_corrections` RPC. Storage upload succeeds;
only the DB step fails.

**Also fixed**: `supabase_migration_corrected_masks.sql` itself was wrong for
this schema and would have errored had someone tried to apply it as-is. Per
`segcheck_dump.sql` (real prod dump, 2026-09-03): `masks.status` and
`review_logs.action` are native Postgres enums (`public.mask_status`,
`public.log_action`), not text+CHECK columns — so the old
`ALTER TABLE ... ADD CONSTRAINT ... CHECK (... 'fixed')` would fail
(Postgres can't validate a CHECK casting `'fixed'` to an enum that doesn't
have that label yet). `local-db/apply_staging_updates.sql` had the correct
enum-aware DDL (proven by restoring the real dump locally) but was missing
the RLS policies. The repo's `supabase_migration_corrected_masks.sql` has
been corrected to merge both — verified by manually cross-checking every
table/column/type it touches against `segcheck_dump.sql`. A live
restore-and-run validation via `local-db/restore_dump.sh` was attempted but
Docker wasn't running; worth doing before/instead of applying to prod
directly if Docker is available.

- [ ] **Apply the corrected `supabase_migration_corrected_masks.sql`** to the
      live project (Supabase SQL editor, with the user present — this
      touches production, don't run unattended).

## Redo export performance

The redo/annotated export downloads (Dashboard's "Download redo batch",
per-split annotated export, and MyRedo's "Download my redo batch") can feel
slow for larger batches. Root cause: every photo/mask fetch and the zip
compression step run sequentially, one at a time.

- [x] **Parallelize photo/mask downloads in `collectPhotoMaskEntries`**
      (`src/lib/zipHelpers.js`). It currently fetches every photo/mask
      sequentially via `downloadBlob`, one full Supabase Storage round-trip
      at a time. Reuse the bounded-concurrency worker-pool pattern already
      used in `readZipEntries` (`READ_CONCURRENCY = 8`) to fetch in
      parallel instead, while still deduping photos and preserving the
      per-row `onProgress` reporting.

- [x] **Skip zip compression for already-compressed images**
      (`downloadZip` in `src/lib/zipHelpers.js`). JSZip's default DEFLATE
      compression wastes CPU trying to compress already-compressed
      PNG/JPEG photo, mask, and preview files. Set `compression: 'STORE'`
      (or `compressionOptions` level 0) for these zip entries so the
      compression phase is effectively free.
