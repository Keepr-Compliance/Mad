-- T1: record in_progress then failed: one row, counts keep only snake_case whole numbers
SELECT pg_temp.claims(:'A'); SET LOCAL ROLE authenticated;
SELECT pg_temp.ok((public.record_submission_attempt(:'S', :'ORG', 'in_progress', 'gather', NULL, 0, '{"messages": 2}', false, '2.39.0', 'darwin')->>'ok')::boolean, 'T1 first');
SELECT pg_temp.ok((public.record_submission_attempt(:'S', :'ORG', 'failed', 'upload', 'retries_exhausted', 3,
   '{"attachments": 1, "Bad Key": 5, "note": "contract.pdf", "neg": -1, "nested": {"a": 1}, "frac": 1.5}', false, NULL, NULL)->>'outcome') = 'failed', 'T1 second');
RESET ROLE;
SELECT pg_temp.ok(count(*) = 1, 'T1 one row') FROM public.submission_attempts WHERE submission_id = :'S';
SELECT pg_temp.ok(counts = '{"messages": 2, "attachments": 1}'::jsonb AND ended_at IS NOT NULL AND retry_count = 3 AND reason_code = 'retries_exhausted'
                  AND app_version = '2.39.0' AND user_id = :'A' AND organization_id = :'ORG', 'T1 row ' || counts::text)
  FROM public.submission_attempts WHERE submission_id = :'S';
