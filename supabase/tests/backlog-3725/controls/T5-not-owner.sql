-- T5: same-org peer records against the submission or attempt of A: not_owner
SELECT pg_temp.claims(:'B'); SET LOCAL ROLE authenticated;
SELECT pg_temp.ok((public.record_submission_attempt(:'S', :'ORG', 'failed', NULL, NULL, 0, '{}', false, NULL, NULL)->>'code') = 'not_owner', 'T5 vs submission');
RESET ROLE;
SELECT pg_temp.claims(:'A'); SET LOCAL ROLE authenticated;
SELECT public.record_submission_attempt('5b340300-0000-4000-8000-0000000000dd', :'ORG', 'failed', NULL, NULL, 0, '{}', false, NULL, NULL);  -- pii-allow-uuid: invented fixture id
RESET ROLE;
SELECT pg_temp.claims(:'B'); SET LOCAL ROLE authenticated;
SELECT pg_temp.ok((public.record_submission_attempt('5b340300-0000-4000-8000-0000000000dd', :'ORG', 'abandoned', NULL, NULL, 0, '{}', false, NULL, NULL)->>'code') = 'not_owner', 'T5 vs attempt row');  -- pii-allow-uuid: invented fixture id
