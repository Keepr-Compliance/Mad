-- P6: storage delete: submitter, uploading, fenced: 1
UPDATE public.transaction_submissions SET submission_metadata = '{"abandoned": true}' WHERE id = :'S';
SELECT set_config('storage.allow_delete_query', 'true', true);
SELECT pg_temp.claims(:'A'); SET LOCAL ROLE authenticated;
WITH d AS (DELETE FROM storage.objects WHERE bucket_id = 'submission-attachments' AND name = :'P1' RETURNING 1) SELECT pg_temp.ok(count(*) = 1, 'P6 deleted=1') FROM d;
