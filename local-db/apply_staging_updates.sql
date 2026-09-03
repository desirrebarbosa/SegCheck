\set ON_ERROR_STOP on

-- Local-only compatibility updates for segcheck_dump.sql.
ALTER TYPE public.mask_status ADD VALUE IF NOT EXISTS 'fixed';
ALTER TYPE public.log_action ADD VALUE IF NOT EXISTS 'submit_correction';

CREATE TABLE IF NOT EXISTS public.mask_corrections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  mask_id uuid NOT NULL REFERENCES public.masks(id) ON DELETE CASCADE,
  project_id uuid NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  submitted_by uuid NOT NULL REFERENCES public.reviewers(id),
  storage_path text NOT NULL,
  original_filename text NOT NULL,
  format text NOT NULL CHECK (format IN ('png', 'coco_json')),
  checksum text NOT NULL,
  batch_id text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS mask_corrections_mask_id_idx
  ON public.mask_corrections (mask_id);
CREATE UNIQUE INDEX IF NOT EXISTS mask_corrections_checksum_idx
  ON public.mask_corrections (mask_id, checksum);

CREATE OR REPLACE FUNCTION public.submit_corrections(
  p_project_id uuid,
  p_batch_id text,
  p_submitted_by uuid,
  p_corrections jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public
AS $$
DECLARE
  v_fixed int := 0;
  v_duplicate int := 0;
  v_rec jsonb;
  v_mask_id uuid;
  v_mask public.masks%ROWTYPE;
BEGIN
  FOR v_rec IN SELECT * FROM jsonb_array_elements(p_corrections) LOOP
    v_mask_id := (v_rec->>'mask_id')::uuid;
    SELECT * INTO v_mask FROM public.masks WHERE id = v_mask_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'mask % not found', v_mask_id; END IF;
    IF v_mask.project_id <> p_project_id THEN
      RAISE EXCEPTION 'mask % does not belong to project %', v_mask_id, p_project_id;
    END IF;
    IF v_mask.status <> 'fail'::public.mask_status THEN
      RAISE EXCEPTION 'mask % is not in fail status (status: %)', v_mask_id, v_mask.status;
    END IF;
    IF v_mask.assigned_to IS DISTINCT FROM p_submitted_by THEN
      RAISE EXCEPTION 'mask % is not assigned to the submitting reviewer', v_mask_id;
    END IF;
    IF EXISTS (
      SELECT 1 FROM public.mask_corrections
      WHERE mask_id = v_mask_id AND checksum = v_rec->>'checksum'
    ) THEN
      v_duplicate := v_duplicate + 1;
      CONTINUE;
    END IF;
    INSERT INTO public.mask_corrections (
      mask_id, project_id, submitted_by, storage_path,
      original_filename, format, checksum, batch_id
    ) VALUES (
      v_mask_id, p_project_id, p_submitted_by, v_rec->>'storage_path',
      v_rec->>'original_filename', v_rec->>'format', v_rec->>'checksum', p_batch_id
    );
    UPDATE public.masks SET status = 'fixed'::public.mask_status, assigned_to = NULL
      WHERE id = v_mask_id;
    INSERT INTO public.review_logs (
      project_id, mask_id, reviewer_id, action, status_before, status_after, detail
    ) VALUES (
      p_project_id, v_mask_id, p_submitted_by, 'submit_correction'::public.log_action,
      'fail'::public.mask_status, 'fixed'::public.mask_status,
      jsonb_build_object('batch_id', p_batch_id, 'format', v_rec->>'format', 'checksum', v_rec->>'checksum')
    );
    v_fixed := v_fixed + 1;
  END LOOP;
  RETURN jsonb_build_object('fixed', v_fixed, 'duplicate', v_duplicate);
END;
$$;

SELECT 'staging updates applied' AS result;
