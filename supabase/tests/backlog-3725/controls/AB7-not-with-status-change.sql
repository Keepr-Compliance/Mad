-- AB7: setting abandoned_at and leaving uploading in one statement is refused
SELECT pg_temp.claims(:'A'); SET LOCAL ROLE authenticated;
DO $$ BEGIN
  UPDATE public.transaction_submissions SET abandoned_at = now(), status = 'submitted' WHERE id = '5b340300-0000-4000-8000-000000000001';  -- pii-allow-uuid: invented fixture id
  RAISE EXCEPTION 'AB7 was allowed';
EXCEPTION WHEN insufficient_privilege THEN PERFORM pg_temp.ok(true, 'AB7 refused'); END $$;
