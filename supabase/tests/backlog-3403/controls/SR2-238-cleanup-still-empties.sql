-- SR2: the 2.38 cleanup order (messages, attachment rows, parent) on an unfenced upload still ends with every row gone
SELECT pg_temp.claims(:'A'); SET LOCAL ROLE authenticated;
WITH d AS (DELETE FROM public.submission_messages WHERE submission_id = :'S' RETURNING 1) SELECT pg_temp.ok(count(*) = 0, 'SR2 message delete is a no-op') FROM d;
WITH d AS (DELETE FROM public.submission_attachments WHERE submission_id = :'S' RETURNING 1) SELECT pg_temp.ok(count(*) = 0, 'SR2 attachment-row delete is a no-op') FROM d;
WITH d AS (DELETE FROM public.transaction_submissions WHERE id = :'S' RETURNING 1) SELECT pg_temp.ok(count(*) = 1, 'SR2 parent delete') FROM d;
RESET ROLE;
SELECT pg_temp.ok((SELECT count(*) FROM public.submission_messages WHERE submission_id = :'S') = 0
              AND (SELECT count(*) FROM public.submission_attachments WHERE submission_id = :'S') = 0
              AND (SELECT count(*) FROM public.submission_checklists WHERE submission_id = :'S') = 0, 'SR2 every child row gone');
