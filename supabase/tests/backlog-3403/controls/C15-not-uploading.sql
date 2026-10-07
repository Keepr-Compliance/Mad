-- C15: needs_changes: not_uploading
UPDATE public.transaction_submissions SET status = 'needs_changes' WHERE id = :'S';
SELECT pg_temp.claims(:'A'); SET LOCAL ROLE authenticated;
SELECT pg_temp.ok((r->>'code') = 'not_uploading', 'C15 ' || r::text) FROM (SELECT public.finalize_submission(:'S', pg_temp.mf()) r) x;
