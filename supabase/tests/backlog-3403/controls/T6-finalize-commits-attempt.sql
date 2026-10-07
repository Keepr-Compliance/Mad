-- T6: finalize marks an existing attempt committed, and creates one when absent
SELECT pg_temp.claims(:'A'); SET LOCAL ROLE authenticated;
SELECT public.record_submission_attempt(:'S', :'ORG', 'in_progress', 'finalize', NULL, 0, '{"messages": 2}', false, NULL, NULL);
SELECT public.finalize_submission(:'S', pg_temp.mf());
SELECT public.finalize_submission(:'S2', jsonb_build_object('message_ids', '[]'::jsonb, 'attachments', '[]'::jsonb, 'checklists', null));
RESET ROLE;
SELECT pg_temp.ok(outcome = 'committed' AND stage = 'finalize' AND ended_at IS NOT NULL AND counts = '{"messages": 2}', 'T6 existing ' || outcome)
  FROM public.submission_attempts WHERE submission_id = :'S';
SELECT pg_temp.ok(outcome = 'committed' AND user_id = :'A' AND organization_id = :'ORG', 'T6 created ' || outcome)
  FROM public.submission_attempts WHERE submission_id = :'S2';
SELECT pg_temp.ok((SELECT count(*) FROM public.submission_attempts WHERE submission_id IN (:'S', :'S2')) = 2, 'T6 two rows');
