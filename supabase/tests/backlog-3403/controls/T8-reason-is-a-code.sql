-- T8: a free-text reason is refused (23514)
SELECT pg_temp.claims(:'A'); SET LOCAL ROLE authenticated;
DO $$ BEGIN
  PERFORM public.record_submission_attempt('5b340300-0000-4000-8000-000000000001', '0e340300-0000-4000-8000-0000000000a1', 'failed', 'upload',  -- pii-allow-uuid: invented fixture id
                                           'Upload failed: contract.pdf', 0, '{}', false, NULL, NULL);
  RAISE EXCEPTION 'T8 free text accepted';
EXCEPTION WHEN check_violation THEN PERFORM pg_temp.ok(true, 'T8 refused'); END $$;
