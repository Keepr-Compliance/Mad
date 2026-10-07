-- C2: declared message missing: incomplete
DELETE FROM public.submission_messages WHERE id = :'M2';
SELECT pg_temp.claims(:'A'); SET LOCAL ROLE authenticated;
SELECT pg_temp.ok((r->>'code') = 'incomplete' AND (r->>'messages_missing')::int = 1, 'C2 ' || r::text) FROM (SELECT public.finalize_submission(:'S', pg_temp.mf()) r) x;
