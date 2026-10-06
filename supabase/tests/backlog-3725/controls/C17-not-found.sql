-- C17: unknown submission id: not_found
SELECT pg_temp.claims(:'A'); SET LOCAL ROLE authenticated;
SELECT pg_temp.ok((r->>'code') = 'not_found', 'C17 ' || r::text) FROM (SELECT public.finalize_submission('5b340300-0000-4000-8000-0000000000ee', pg_temp.mf()) r) x;  -- pii-allow-uuid: invented fixture id
