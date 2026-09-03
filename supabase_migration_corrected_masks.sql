-- ============================================================
-- Migration: Corrected Mask Uploads
-- Apply this in the Supabase SQL editor (or via supabase db push).
--
-- Verified against a real dump of the production database (segcheck_dump.sql,
-- 2026-09-03): masks.status is a native enum (public.mask_status), not a
-- text+CHECK column, and review_logs.action is also a native enum
-- (public.log_action). An earlier version of this file assumed a
-- text+CHECK column and would have failed to apply (Postgres can't validate
-- a CHECK expression casting 'fixed' to an enum type that doesn't have that
-- label yet). This version matches the real schema.
-- ============================================================

-- ── 1. Add the new enum labels ────────────────────────────────────────────
ALTER TYPE public.mask_status ADD VALUE IF NOT EXISTS 'fixed';
ALTER TYPE public.log_action ADD VALUE IF NOT EXISTS 'submit_correction';

-- ── 2. mask_corrections table ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.mask_corrections (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  mask_id       uuid        NOT NULL REFERENCES public.masks(id) ON DELETE CASCADE,
  project_id    uuid        NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  submitted_by  uuid        NOT NULL REFERENCES public.reviewers(id),
  storage_path  text        NOT NULL,
  original_filename text    NOT NULL,
  format        text        NOT NULL CHECK (format IN ('png', 'coco_json')),
  checksum      text        NOT NULL,
  batch_id      text,
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- Index for fast lookups by mask and by checksum (idempotency check).
CREATE INDEX IF NOT EXISTS mask_corrections_mask_id_idx
  ON public.mask_corrections (mask_id);

CREATE UNIQUE INDEX IF NOT EXISTS mask_corrections_checksum_idx
  ON public.mask_corrections (mask_id, checksum);

-- ── 3. RLS for mask_corrections ──────────────────────────────────────────
-- Uses the project's existing public.is_project_member()/is_project_lead()
-- helpers (see masks_select/masks_insert etc. in the real schema) rather
-- than a fresh inline EXISTS, for consistency with every other table here.
ALTER TABLE public.mask_corrections ENABLE ROW LEVEL SECURITY;

CREATE POLICY "members can read corrections"
  ON public.mask_corrections FOR SELECT
  TO authenticated
  USING (public.is_project_member(project_id));

-- Belt-and-suspenders for any direct REST insert bypassing the RPC below
-- (the RPC itself runs SECURITY DEFINER and bypasses RLS as table owner —
-- these checks matter only outside that path).
CREATE POLICY "submitter can insert correction"
  ON public.mask_corrections FOR INSERT
  TO authenticated
  WITH CHECK (submitted_by = auth.uid() AND public.is_project_member(project_id));

-- ── 4. submit_corrections RPC ────────────────────────────────────────────
-- Atomically:
--   a. Verifies each mask_id belongs to p_project_id and is 'fail'.
--   b. Verifies auth.uid() is the assigned reviewer for each mask.
--   c. Skips masks whose checksum already exists (idempotent re-upload).
--   d. Inserts correction records.
--   e. Updates mask status → 'fixed', clears assigned_to.
--   f. Writes 'submit_correction' audit entries in review_logs, including
--      status_before (the real review_logs table has this column).
-- Returns { fixed int, duplicate int }.

CREATE OR REPLACE FUNCTION public.submit_corrections(
  p_project_id  uuid,
  p_batch_id    text,
  p_submitted_by uuid,
  p_corrections jsonb   -- [{ mask_id, storage_path, original_filename, format, checksum }]
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER   -- runs with definer privileges so RLS on masks doesn't block it
SET search_path TO public
AS $$
DECLARE
  v_fixed     int := 0;
  v_duplicate int := 0;
  v_rec       jsonb;
  v_mask_id   uuid;
  v_mask      public.masks%ROWTYPE;
BEGIN
  FOR v_rec IN SELECT * FROM jsonb_array_elements(p_corrections) LOOP
    v_mask_id := (v_rec->>'mask_id')::uuid;

    -- Fetch the mask row (locks it for the duration of this transaction).
    SELECT * INTO v_mask FROM public.masks WHERE id = v_mask_id FOR UPDATE;

    -- Ownership / status guard.
    IF NOT FOUND THEN
      RAISE EXCEPTION 'mask % not found', v_mask_id;
    END IF;
    IF v_mask.project_id <> p_project_id THEN
      RAISE EXCEPTION 'mask % does not belong to project %', v_mask_id, p_project_id;
    END IF;
    IF v_mask.status <> 'fail'::public.mask_status THEN
      RAISE EXCEPTION 'mask % is not in fail status (status: %)', v_mask_id, v_mask.status;
    END IF;
    IF v_mask.assigned_to IS DISTINCT FROM p_submitted_by THEN
      RAISE EXCEPTION 'mask % is not assigned to the submitting reviewer', v_mask_id;
    END IF;

    -- Idempotency: skip if this checksum was already recorded for this mask.
    IF EXISTS (
      SELECT 1 FROM public.mask_corrections
      WHERE mask_id = v_mask_id
        AND checksum = v_rec->>'checksum'
    ) THEN
      v_duplicate := v_duplicate + 1;
      CONTINUE;
    END IF;

    -- Insert the correction record.
    INSERT INTO public.mask_corrections (
      mask_id, project_id, submitted_by, storage_path,
      original_filename, format, checksum, batch_id
    ) VALUES (
      v_mask_id,
      p_project_id,
      p_submitted_by,
      v_rec->>'storage_path',
      v_rec->>'original_filename',
      v_rec->>'format',
      v_rec->>'checksum',
      p_batch_id
    );

    -- Mark the mask as fixed and release the assignment.
    UPDATE public.masks
    SET status = 'fixed'::public.mask_status, assigned_to = NULL
    WHERE id = v_mask_id;

    -- Audit log.
    INSERT INTO public.review_logs (
      project_id, mask_id, reviewer_id, action, status_before, status_after, detail
    ) VALUES (
      p_project_id,
      v_mask_id,
      p_submitted_by,
      'submit_correction'::public.log_action,
      'fail'::public.mask_status,
      'fixed'::public.mask_status,
      jsonb_build_object(
        'batch_id', p_batch_id,
        'format',   v_rec->>'format',
        'checksum', v_rec->>'checksum'
      )
    );

    v_fixed := v_fixed + 1;
  END LOOP;

  RETURN jsonb_build_object('fixed', v_fixed, 'duplicate', v_duplicate);
END;
$$;

-- ── 5. active_masks view ─────────────────────────────────────────────────
-- No change needed. The real view (checked against segcheck_dump.sql) has no
-- status filter at all — it joins masks to their latest photo version only.
-- Any query that scopes to status = 'fail' (the redo queue) will naturally
-- stop returning a mask once it moves to 'fixed'; Dashboard's counts already
-- query 'fixed' separately from the base masks table.

-- ── 6. Storage cleanup hook (documentation only) ─────────────────────────
-- When a project or photo is deleted, also remove correction Storage objects:
--   storage path pattern: {projectId}/{batchId}/corrections/{maskId}/...
-- Wire this up in your project/photo deletion functions in projects.js, or
-- use a Supabase Edge Function triggered by the on_delete event on projects/photos.
-- mask_corrections rows are cascade-deleted by the FK ON DELETE CASCADE above.
