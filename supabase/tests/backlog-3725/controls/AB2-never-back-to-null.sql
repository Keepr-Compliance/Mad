-- AB2: abandoned_at cannot go back to NULL (0 rows or refused; the value is unchanged)
SELECT pg_temp.claims(:'A'); SET LOCAL ROLE authenticated;
WITH u AS (UPDATE public.transaction_submissions SET abandoned_at = now()
           WHERE id = :'S' AND status = 'uploading' AND abandoned_at IS NULL RETURNING 1) SELECT count(*) FROM u;
RESET ROLE;
CREATE TEMP TABLE ab2 AS SELECT abandoned_at FROM public.transaction_submissions WHERE id = :'S';
SELECT pg_temp.claims(:'A'); SET LOCAL ROLE authenticated;
DO $$ BEGIN
  UPDATE public.transaction_submissions SET abandoned_at = NULL WHERE id = '5b340300-0000-4000-8000-000000000001';  -- pii-allow-uuid: invented fixture id
EXCEPTION WHEN insufficient_privilege THEN NULL; END $$;
RESET ROLE;
SELECT pg_temp.ok(s.abandoned_at IS NOT NULL AND s.abandoned_at = (SELECT abandoned_at FROM ab2), 'AB2 unchanged') FROM public.transaction_submissions s WHERE s.id = :'S';
