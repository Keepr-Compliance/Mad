-- R3: fence first (1 row), then finalize: abandoned, nothing changes
SELECT pg_temp.claims(:'A'); SET LOCAL ROLE authenticated;
WITH u AS (UPDATE public.transaction_submissions SET abandoned_at = now()
           WHERE id = :'S' AND status = 'uploading' AND abandoned_at IS NULL RETURNING 1) SELECT pg_temp.ok(count(*) = 1, 'R3 fence 1 row') FROM u;
SELECT pg_temp.ok((r->>'code') = 'abandoned', 'R3 ' || r::text) FROM (SELECT public.finalize_submission(:'S', pg_temp.mf()) r) x;
RESET ROLE;
SELECT pg_temp.ok(status = 'uploading', 'R3 still uploading') FROM public.transaction_submissions WHERE id = :'S';
