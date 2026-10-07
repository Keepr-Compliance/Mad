-- AB9: a client writing a future abandoned_at gets the server time stored
SELECT pg_temp.claims(:'A'); SET LOCAL ROLE authenticated;
WITH u AS (UPDATE public.transaction_submissions SET abandoned_at = now() + interval '100 years'
           WHERE id = :'S' AND status = 'uploading' AND abandoned_at IS NULL RETURNING 1) SELECT pg_temp.ok(count(*) = 1, 'AB9 fence 1 row') FROM u;
RESET ROLE;
SELECT pg_temp.ok(abandoned_at = now(), 'AB9 stored = now(): ' || abandoned_at::text) FROM public.transaction_submissions WHERE id = :'S';
