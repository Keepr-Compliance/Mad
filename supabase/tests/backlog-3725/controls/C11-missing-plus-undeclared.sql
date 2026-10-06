-- C11: one declared message missing and one undeclared row (same count): incomplete
DELETE FROM public.submission_messages WHERE id = :'M2';
INSERT INTO public.submission_messages (id, submission_id, channel) VALUES (:'M3', :'S', 'sms');
SELECT pg_temp.claims(:'A'); SET LOCAL ROLE authenticated;
SELECT pg_temp.ok((r->>'code') = 'incomplete' AND (r->>'messages_missing')::int = 1 AND (r->>'messages_extra')::int = 1, 'C11 ' || r::text) FROM (SELECT public.finalize_submission(:'S', pg_temp.mf()) r) x;
