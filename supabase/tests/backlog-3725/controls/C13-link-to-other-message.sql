-- C13: attachment row linked to a different message than declared: incomplete
UPDATE public.submission_attachments SET message_id = :'M2' WHERE id = :'AT1';
SELECT pg_temp.claims(:'A'); SET LOCAL ROLE authenticated;
SELECT pg_temp.ok((r->>'code') = 'incomplete' AND (r->>'attachment_message_links_wrong')::int = 1, 'C13 ' || r::text) FROM (SELECT public.finalize_submission(:'S', pg_temp.mf()) r) x;
