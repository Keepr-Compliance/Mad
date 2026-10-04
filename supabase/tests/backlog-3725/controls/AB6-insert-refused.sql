-- AB6: a client cannot insert a submission with abandoned_at set
SELECT pg_temp.claims(:'A'); SET LOCAL ROLE authenticated;
DO $$ BEGIN
  INSERT INTO public.transaction_submissions (organization_id, submitted_by, local_transaction_id, property_address, status, version, abandoned_at) VALUES ('0e340300-0000-4000-8000-0000000000a1', 'aaaaaaaa-3403-4000-8000-000000000001', 't9', 'x', 'uploading', 1, now());  -- pii-allow-uuid: invented fixture id
  RAISE EXCEPTION 'AB6 was allowed';
EXCEPTION WHEN insufficient_privilege THEN PERFORM pg_temp.ok(true, 'AB6 refused'); END $$;
