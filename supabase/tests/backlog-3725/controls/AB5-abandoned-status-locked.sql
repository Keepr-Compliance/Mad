-- AB5: after the fence, a 2.38-shaped status flip by the submitter matches 0 rows
SELECT pg_temp.claims(:'A'); SET LOCAL ROLE authenticated;
WITH u AS (UPDATE public.transaction_submissions SET abandoned_at = now()
           WHERE id = :'S' AND status = 'uploading' AND abandoned_at IS NULL RETURNING 1) SELECT count(*) FROM u;
WITH u AS (UPDATE public.transaction_submissions SET status = 'submitted' WHERE id = :'S' RETURNING 1) SELECT pg_temp.ok(count(*) = 0, 'AB5 flip 0 rows') FROM u;
RESET ROLE;
SELECT pg_temp.ok(status = 'uploading', 'AB5 still uploading') FROM public.transaction_submissions WHERE id = :'S';
