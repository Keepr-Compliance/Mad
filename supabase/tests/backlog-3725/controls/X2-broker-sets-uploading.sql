-- X2: broker UPDATE submitted to uploading: refused
UPDATE public.transaction_submissions SET status = 'submitted' WHERE id = :'S';
SELECT pg_temp.claims(:'K'); SET LOCAL ROLE authenticated;
DO $$ BEGIN
  UPDATE public.transaction_submissions SET status = 'uploading' WHERE id = '5b340300-0000-4000-8000-000000000001';  -- pii-allow-uuid: invented fixture id
  RAISE EXCEPTION 'X2 was allowed';
EXCEPTION WHEN insufficient_privilege THEN PERFORM pg_temp.ok(true, 'X2 refused'); END $$;
