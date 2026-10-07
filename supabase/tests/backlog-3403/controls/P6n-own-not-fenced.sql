-- P6n: storage delete: submitter, uploading, NOT fenced: 0
SELECT set_config('storage.allow_delete_query', 'true', true);
SELECT pg_temp.claims(:'A'); SET LOCAL ROLE authenticated;
WITH d AS (DELETE FROM storage.objects WHERE bucket_id = 'submission-attachments' AND name = :'P1' RETURNING 1) SELECT pg_temp.ok(count(*) = 0, 'P6n deleted=0') FROM d;
