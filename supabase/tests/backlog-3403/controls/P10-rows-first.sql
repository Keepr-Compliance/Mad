-- P10: storage delete after the parent row is gone: 0 (objects before rows)
UPDATE public.transaction_submissions SET submission_metadata = '{"abandoned": true}' WHERE id = :'S';
SELECT pg_temp.claims(:'A'); SET LOCAL ROLE authenticated;
DELETE FROM public.transaction_submissions WHERE id = :'S';
RESET ROLE;
SELECT set_config('storage.allow_delete_query', 'true', true);
SELECT pg_temp.claims(:'A'); SET LOCAL ROLE authenticated;
WITH d AS (DELETE FROM storage.objects WHERE bucket_id = 'submission-attachments' AND name = :'P1' RETURNING 1) SELECT pg_temp.ok(count(*) = 0, 'P10 deleted=0') FROM d;
