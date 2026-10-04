-- X5: submitter flips submitted to uploading: 0 rows
UPDATE public.transaction_submissions SET status = 'submitted' WHERE id = :'S';
SELECT pg_temp.claims(:'A'); SET LOCAL ROLE authenticated;
WITH u AS (UPDATE public.transaction_submissions SET status = 'uploading' WHERE id = :'S' RETURNING 1) SELECT pg_temp.ok(count(*) = 0, 'X5') FROM u;
