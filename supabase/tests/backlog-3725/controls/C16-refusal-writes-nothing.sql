-- C16: after refusals: still uploading, no history, no metadata, no attempt row
DELETE FROM public.submission_messages WHERE id = :'M2';
SELECT pg_temp.claims(:'A'); SET LOCAL ROLE authenticated;
SELECT public.finalize_submission(:'S', pg_temp.mf());
SELECT public.finalize_submission(:'S', pg_temp.mf());
RESET ROLE;
SELECT pg_temp.ok(status = 'uploading' AND jsonb_array_length(status_history) = 0 AND submission_metadata IS NULL, 'C16 row') FROM public.transaction_submissions WHERE id = :'S';
SELECT pg_temp.ok(NOT EXISTS (SELECT 1 FROM public.submission_attempts WHERE submission_id = :'S'), 'C16 no attempt row');
