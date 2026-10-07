-- AB8: submission_metadata.abandoned no longer fences: finalize succeeds and no file can be deleted
SELECT pg_temp.claims(:'A'); SET LOCAL ROLE authenticated;
UPDATE public.transaction_submissions SET submission_metadata = '{"abandoned": true}' WHERE id = :'S';
RESET ROLE;
SELECT set_config('storage.allow_delete_query', 'true', true);
SELECT pg_temp.claims(:'A'); SET LOCAL ROLE authenticated;
WITH d AS (DELETE FROM storage.objects WHERE bucket_id = 'submission-attachments' AND name = :'P1' RETURNING 1) SELECT pg_temp.ok(count(*) = 0, 'AB8 no delete') FROM d;
WITH d AS (DELETE FROM public.submission_attachments WHERE submission_id = :'S' RETURNING 1) SELECT pg_temp.ok(count(*) = 0, 'AB8 no row delete') FROM d;
SELECT pg_temp.ok((r->>'ok')::boolean, 'AB8 finalize ' || r::text) FROM (SELECT public.finalize_submission(:'S', pg_temp.mf()) r) x;
