-- C4: same-org agent calls finalize on the submission of A: not_owner
SELECT pg_temp.claims(:'B'); SET LOCAL ROLE authenticated;
SELECT pg_temp.ok((r->>'code') = 'not_owner', 'C4 ' || r::text) FROM (SELECT public.finalize_submission(:'S', pg_temp.mf()) r) x;
RESET ROLE;
SELECT pg_temp.ok((SELECT status FROM public.transaction_submissions WHERE id = :'S') = 'uploading', 'C4 still uploading');
