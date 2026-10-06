-- SR1: a client cannot record outcome committed; the row is not committed
SELECT pg_temp.claims(:'A'); SET LOCAL ROLE authenticated;
SELECT pg_temp.ok((r->>'ok')::boolean = false AND (r->>'code') = 'committed_is_server_only', 'SR1 ' || r::text)
  FROM (SELECT public.record_submission_attempt(:'S', :'ORG', 'committed', 'finalize', NULL, 0, '{}', false, NULL, NULL) r) x;
SELECT public.record_submission_attempt(:'S', :'ORG', 'in_progress', 'upload', NULL, 0, '{}', false, NULL, NULL);
SELECT pg_temp.ok((public.record_submission_attempt(:'S', :'ORG', 'committed', NULL, NULL, 0, '{}', false, NULL, NULL)->>'code') = 'committed_is_server_only', 'SR1 over an existing row');
RESET ROLE;
SELECT pg_temp.ok(NOT EXISTS (SELECT 1 FROM public.submission_attempts WHERE submission_id = :'S' AND outcome = 'committed'), 'SR1 no committed row');
