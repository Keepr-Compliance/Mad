-- T7: a committed attempt is not changed by a later record call
SELECT pg_temp.claims(:'A'); SET LOCAL ROLE authenticated;
SELECT public.finalize_submission(:'S', pg_temp.mf());
SELECT pg_temp.ok((public.record_submission_attempt(:'S', :'ORG', 'failed', 'finalize', 'no_answer', 3, '{}', false, NULL, NULL)->>'unchanged')::boolean, 'T7 unchanged');
RESET ROLE;
SELECT pg_temp.ok(outcome = 'committed' AND reason_code IS NULL, 'T7 still committed ' || outcome) FROM public.submission_attempts WHERE submission_id = :'S';
