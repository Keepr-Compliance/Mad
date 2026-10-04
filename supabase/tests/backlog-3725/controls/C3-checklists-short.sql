-- C3: checklists expected 2, found 1: incomplete
DELETE FROM public.submission_checklists WHERE submission_id = :'S' AND template_name = 'b';
SELECT pg_temp.claims(:'A'); SET LOCAL ROLE authenticated;
SELECT pg_temp.ok((r->>'code') = 'incomplete' AND (r->>'checklists_found')::int = 1, 'C3 ' || r::text) FROM (SELECT public.finalize_submission(:'S', pg_temp.mf()) r) x;
