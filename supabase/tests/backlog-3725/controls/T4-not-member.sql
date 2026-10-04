-- T4: agent of another org records for this org: not_member
SELECT pg_temp.claims(:'O'); SET LOCAL ROLE authenticated;
SELECT pg_temp.ok((public.record_submission_attempt('5b340300-0000-4000-8000-0000000000dd', :'ORG', 'failed', NULL, NULL, 0, '{}', false, NULL, NULL)->>'code') = 'not_member', 'T4');  -- pii-allow-uuid: invented fixture id
