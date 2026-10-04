-- P8: storage delete: same-org agent, fenced upload: 0
UPDATE public.transaction_submissions SET abandoned_at = now() WHERE id = :'S';
SELECT set_config('storage.allow_delete_query', 'true', true);
SELECT pg_temp.claims(:'B'); SET LOCAL ROLE authenticated;
WITH d AS (DELETE FROM storage.objects WHERE bucket_id = 'submission-attachments' AND name = :'P1' RETURNING 1) SELECT pg_temp.ok(count(*) = 0, 'P8 deleted=0') FROM d;
