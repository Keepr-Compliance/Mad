-- AB1: the fence sets abandoned_at once: 1 row, then 0 rows
SELECT pg_temp.claims(:'A'); SET LOCAL ROLE authenticated;
WITH u AS (UPDATE public.transaction_submissions SET abandoned_at = now()
           WHERE id = :'S' AND status = 'uploading' AND abandoned_at IS NULL RETURNING 1) SELECT pg_temp.ok(count(*) = 1, 'AB1 first fence 1 row') FROM u;
WITH u AS (UPDATE public.transaction_submissions SET abandoned_at = now()
           WHERE id = :'S' AND status = 'uploading' AND abandoned_at IS NULL RETURNING 1) SELECT pg_temp.ok(count(*) = 0, 'AB1 second fence 0 rows') FROM u;
RESET ROLE;
SELECT pg_temp.ok(abandoned_at IS NOT NULL AND status = 'uploading', 'AB1 row') FROM public.transaction_submissions WHERE id = :'S';
