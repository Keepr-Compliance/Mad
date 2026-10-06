-- F1: after finalize the fence matches 0 rows
SELECT pg_temp.claims(:'A'); SET LOCAL ROLE authenticated;
SELECT public.finalize_submission(:'S', pg_temp.mf());
WITH u AS (UPDATE public.transaction_submissions SET submission_metadata = coalesce(submission_metadata, '{}'::jsonb) || '{"abandoned": true}'
           WHERE id = :'S' AND status = 'uploading' RETURNING 1) SELECT pg_temp.ok(count(*) = 0, 'F1 fence 0 rows') FROM u;
