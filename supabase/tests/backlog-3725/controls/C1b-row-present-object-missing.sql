-- C1b: attachment row present, object missing: incomplete objects_missing
SELECT pg_temp.rm_object(:'P1');
SELECT pg_temp.claims(:'A'); SET LOCAL ROLE authenticated;
SELECT pg_temp.ok((r->>'code') = 'incomplete' AND (r->>'objects_missing')::int = 1, 'C1b ' || r::text) FROM (SELECT public.finalize_submission(:'S', pg_temp.mf()) r) x;
