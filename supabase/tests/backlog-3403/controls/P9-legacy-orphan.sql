-- P9: storage delete: object with no submission row: 0
INSERT INTO storage.objects (bucket_id, name) VALUES ('submission-attachments', '0e340300-0000-4000-8000-0000000000a1/5b340300-0000-4000-8000-0000000000aa/old.pdf');  -- pii-allow-uuid: invented fixture id
SELECT set_config('storage.allow_delete_query', 'true', true);
SELECT pg_temp.claims(:'A'); SET LOCAL ROLE authenticated;
WITH d AS (DELETE FROM storage.objects WHERE bucket_id = 'submission-attachments'
           AND name = '0e340300-0000-4000-8000-0000000000a1/5b340300-0000-4000-8000-0000000000aa/old.pdf' RETURNING 1) SELECT pg_temp.ok(count(*) = 0, 'P9 deleted=0') FROM d;  -- pii-allow-uuid: invented fixture id
