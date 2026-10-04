-- AB4: a peer agent matches no row; a broker cannot set it on a submission it can update
SELECT pg_temp.claims(:'B'); SET LOCAL ROLE authenticated;
WITH u AS (UPDATE public.transaction_submissions SET abandoned_at = now() WHERE id = :'S' RETURNING 1) SELECT pg_temp.ok(count(*) = 0, 'AB4 peer 0 rows') FROM u;
RESET ROLE;
UPDATE public.transaction_submissions SET status = 'submitted' WHERE id = :'S';
SELECT pg_temp.claims(:'K'); SET LOCAL ROLE authenticated;
DO $$ BEGIN
  UPDATE public.transaction_submissions SET abandoned_at = now() WHERE id = '5b340300-0000-4000-8000-000000000001';  -- pii-allow-uuid: invented fixture id
  RAISE EXCEPTION 'AB4 broker was allowed';
EXCEPTION WHEN insufficient_privilege THEN PERFORM pg_temp.ok(true, 'AB4 broker refused'); END $$;
