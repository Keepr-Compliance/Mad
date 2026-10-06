-- SR3: after the fence the submitter can delete the attachment rows
UPDATE public.transaction_submissions SET submission_metadata = '{"abandoned": true}' WHERE id = :'S';
SELECT pg_temp.claims(:'A'); SET LOCAL ROLE authenticated;
WITH d AS (DELETE FROM public.submission_attachments WHERE submission_id = :'S' RETURNING 1) SELECT pg_temp.ok(count(*) = 1, 'SR3 deleted=1') FROM d;
