-- T9: an unknown outcome is refused (23514)
SELECT pg_temp.claims(:'A'); SET LOCAL ROLE authenticated;
DO $$ BEGIN
  PERFORM public.record_submission_attempt('5b340300-0000-4000-8000-000000000001', '0e340300-0000-4000-8000-0000000000a1', 'done', NULL, NULL, 0, '{}', false, NULL, NULL);  -- pii-allow-uuid: invented fixture id
  RAISE EXCEPTION 'T9 accepted';
EXCEPTION WHEN check_violation THEN PERFORM pg_temp.ok(true, 'T9 refused'); END $$;
