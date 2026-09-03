\set ON_ERROR_STOP on

SELECT set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000002', false);

INSERT INTO projects (id, name) VALUES
  ('00000000-0000-0000-0000-000000000001', 'Local test project');
INSERT INTO reviewers (id, email) VALUES
  ('00000000-0000-0000-0000-000000000002', 'reviewer@example.test');
INSERT INTO project_members (project_id, reviewer_id) VALUES
  ('00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000002');
INSERT INTO masks (id, project_id, status, assigned_to) VALUES
  ('00000000-0000-0000-0000-000000000011', '00000000-0000-0000-0000-000000000001', 'pass', NULL),
  ('00000000-0000-0000-0000-000000000012', '00000000-0000-0000-0000-000000000001', 'fail', '00000000-0000-0000-0000-000000000002'),
  ('00000000-0000-0000-0000-000000000013', '00000000-0000-0000-0000-000000000001', 'fail', '00000000-0000-0000-0000-000000000002');

SELECT submit_corrections(
  '00000000-0000-0000-0000-000000000001',
  'local-batch',
  '00000000-0000-0000-0000-000000000002',
  '[{"mask_id":"00000000-0000-0000-0000-000000000012","storage_path":"local/correction.png","original_filename":"mask_final.png","format":"png","checksum":"checksum-1"}]'::jsonb
);

DO $$
DECLARE
  fixed_count integer;
  pass_count integer;
  fail_count integer;
  correction_count integer;
BEGIN
  SELECT count(*) INTO fixed_count FROM masks WHERE status = 'fixed';
  SELECT count(*) INTO pass_count FROM masks WHERE status = 'pass';
  SELECT count(*) INTO fail_count FROM masks WHERE status = 'fail';
  SELECT count(*) INTO correction_count FROM mask_corrections;

  IF fixed_count <> 1 THEN RAISE EXCEPTION 'expected 1 corrected mask, got %', fixed_count; END IF;
  IF pass_count <> 1 THEN RAISE EXCEPTION 'expected 1 passed mask, got %', pass_count; END IF;
  IF fail_count <> 1 THEN RAISE EXCEPTION 'expected 1 remaining redo mask, got %', fail_count; END IF;
  IF correction_count <> 1 THEN RAISE EXCEPTION 'expected 1 correction record, got %', correction_count; END IF;
  IF fixed_count + pass_count <> 2 THEN RAISE EXCEPTION 'expected 2 total complete masks'; END IF;
END $$;

SELECT 'PASS: partial redo correction leaves one remaining and two complete' AS result;
