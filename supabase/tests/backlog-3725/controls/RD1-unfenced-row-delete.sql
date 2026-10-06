-- RD1: attachment-row delete on an uploading, NOT fenced submission: 0 rows
SELECT pg_temp.claims(:'A'); SET LOCAL ROLE authenticated;
WITH d AS (DELETE FROM public.submission_attachments WHERE submission_id = :'S' RETURNING 1) SELECT pg_temp.ok(count(*) = 0, 'RD1 deleted=0') FROM d;
