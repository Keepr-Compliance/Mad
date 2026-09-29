-- E03: every status move the desktop and the portal make AS THE CLIENT ROLE
-- still succeeds and still gets exactly one status entry from
-- track_submission_status_changes (which runs after the guard):
--   desktop finalize            uploading -> submitted / resubmitted   (agent)
--   portal markUnderReview      submitted -> under_review              (broker)
--   portal ReviewActions        under_review -> needs_changes/approved (broker, reviewed_by/at/notes)
-- The update statements are the ones the apps send (column sets copied from
-- electron/services/submissionService.ts finalize, broker-portal
-- lib/submissions/markUnderReview.ts and components/submission/ReviewActions.tsx).
DO $e03$
DECLARE
  agent  uuid := pg_temp.id('u_t1_agent');
  broker uuid := pg_temp.id('u_t1_broker');
  v1 uuid; v2 uuid; e jsonb;
BEGIN
  -- version 1: uploading -> submitted by the agent
  v1 := pg_temp.mk_sub('fixture-3608-e03', 1, NULL, 'uploading');
  PERFORM pg_temp.act_as(agent);
  PERFORM pg_temp.expect('E03 desktop finalize v1', format($q$UPDATE public.transaction_submissions SET status = 'submitted' WHERE id = %L$q$, v1), 'rows:1');
  PERFORM pg_temp.act_owner();
  e := pg_temp.hist(v1) -> -1;
  PERFORM pg_temp.check(jsonb_array_length(pg_temp.hist(v1)) = 1 AND e ->> 'status' = 'submitted' AND NOT (e ? 'type'),
                        'E03 finalize wrote one status entry: ' || COALESCE(pg_temp.hist(v1)::text, 'null'));
  -- under_review by the broker
  PERFORM pg_temp.act_as(broker);
  PERFORM pg_temp.expect('E03 portal markUnderReview', format($q$UPDATE public.transaction_submissions SET status = 'under_review' WHERE id = %L$q$, v1), 'rows:1');
  -- needs_changes decision
  PERFORM pg_temp.expect('E03 portal decision needs_changes',
    format($q$UPDATE public.transaction_submissions SET status = 'needs_changes', reviewed_by = %L, reviewed_at = now(), review_notes = 'Fix it' WHERE id = %L AND status IN ('submitted','resubmitted','under_review')$q$, broker, v1), 'rows:1');
  PERFORM pg_temp.act_owner();
  e := pg_temp.hist(v1) -> -1;
  PERFORM pg_temp.check(jsonb_array_length(pg_temp.hist(v1)) = 3 AND e ->> 'status' = 'needs_changes'
                        AND (e ->> 'changed_by')::uuid = broker AND e ->> 'notes' = 'Fix it',
                        'E03 decision wrote one status entry naming the broker');
  -- version 2: uploading -> resubmitted by the agent, then approved
  v2 := pg_temp.mk_sub('fixture-3608-e03', 2, v1, 'uploading');
  PERFORM pg_temp.act_as(agent);
  PERFORM pg_temp.expect('E03 desktop finalize v2 (resubmitted)', format($q$UPDATE public.transaction_submissions SET status = 'resubmitted' WHERE id = %L$q$, v2), 'rows:1');
  PERFORM pg_temp.act_as(broker);
  PERFORM pg_temp.expect('E03 portal decision approved',
    format($q$UPDATE public.transaction_submissions SET status = 'approved', reviewed_by = %L, reviewed_at = now(), review_notes = NULL WHERE id = %L AND status IN ('submitted','resubmitted','under_review')$q$, broker, v2), 'rows:1');
  PERFORM pg_temp.act_owner();
  PERFORM pg_temp.check((SELECT string_agg(x.e ->> 'status', ',' ORDER BY o) FROM jsonb_array_elements(pg_temp.hist(v2)) WITH ORDINALITY AS x(e, o))
                        = 'resubmitted,approved', 'E03 v2 history is resubmitted,approved');
END
$e03$;
