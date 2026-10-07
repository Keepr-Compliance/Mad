-- T2: attempt rows: agent, org broker, internal user see; other-org agent and same-org peer do not
SELECT pg_temp.claims(:'A'); SET LOCAL ROLE authenticated;
SELECT public.record_submission_attempt(:'S', :'ORG', 'failed', 'upload', 'retries_exhausted', 3, '{}', false, NULL, NULL);
RESET ROLE;
SELECT pg_temp.claims(:'A'); SET LOCAL ROLE authenticated;
SELECT pg_temp.ok((SELECT count(*) FROM public.submission_attempts WHERE submission_id = :'S') = 1, 'T2 agent');
RESET ROLE;
SELECT pg_temp.claims(:'K'); SET LOCAL ROLE authenticated;
SELECT pg_temp.ok((SELECT count(*) FROM public.submission_attempts WHERE submission_id = :'S') = 1, 'T2 broker');
RESET ROLE;
SELECT pg_temp.claims(:'Z'); SET LOCAL ROLE authenticated;
SELECT pg_temp.ok((SELECT count(*) FROM public.submission_attempts WHERE submission_id = :'S') = 1, 'T2 staff');
RESET ROLE;
SELECT pg_temp.claims(:'O'); SET LOCAL ROLE authenticated;
SELECT pg_temp.ok((SELECT count(*) FROM public.submission_attempts WHERE submission_id = :'S') = 0, 'T2 other org');
RESET ROLE;
SELECT pg_temp.claims(:'B'); SET LOCAL ROLE authenticated;
SELECT pg_temp.ok((SELECT count(*) FROM public.submission_attempts WHERE submission_id = :'S') = 0, 'T2 peer');
RESET ROLE;
