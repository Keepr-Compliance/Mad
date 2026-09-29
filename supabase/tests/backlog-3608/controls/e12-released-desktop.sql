-- E12: the released desktop's submit sequence, as the agent, statement for
-- statement (origin/main electron/services/submissionService.ts):
--   :749-754  select stale 'uploading' rows for (org, local transaction)
--   :757-770  delete them (messages, attachments, submission)
--   :772-774  insert the mapToSubmission record (:1360-1410) with
--             status 'uploading', version, parent_submission_id,
--             submission_metadata; no reviewed_*, no status_history
--   :887-890  update({ status: finalStatus }) on that row
-- for a first submit (v1 -> submitted) and a resubmit after a needs_changes
-- decision (v2 -> resubmitted), plus :1618-1622 delete of an uploading row.
-- Each finalize: rows:1 and exactly one untyped status entry.
DO $e12$
DECLARE
  agent  uuid := pg_temp.id('u_t1_agent');
  broker uuid := pg_temp.id('u_t1_broker');
  org    uuid := pg_temp.id('o_t1');
  v1 uuid := gen_random_uuid(); v2 uuid := gen_random_uuid(); stale uuid := gen_random_uuid(); v9 uuid := gen_random_uuid();
  ins text := $q$INSERT INTO public.transaction_submissions (id, organization_id, submitted_by, local_transaction_id, property_address,
      property_city, property_state, property_zip, transaction_type, listing_price, sale_price, started_at, closed_at, status, version,
      parent_submission_id, message_count, attachment_count, submission_metadata)
    VALUES (%L, %L, %L, 'fixture-3608-e12', '12 Fixture Way', 'City', 'ST', '00000', 'other', 500000, NULL, now() - interval '30 days', NULL,
      'uploading', %s, %L, 2, 1, '{"desktop_version":"2.38.1","detection_source":"manual","detection_confidence":null}'::jsonb)$q$;
BEGIN
  PERFORM pg_temp.act_as(agent);
  -- a stale uploading row from a failed attempt, then the cleanup
  PERFORM pg_temp.expect('E12 insert stale uploading row', format(ins, stale, org, agent, 1, NULL), 'rows:1');
  PERFORM pg_temp.check(pg_temp.n(format($q$SELECT count(*) FROM public.transaction_submissions WHERE organization_id = %L AND local_transaction_id = 'fixture-3608-e12' AND status = 'uploading'$q$, org)) = 1,
                        'E12 stale select finds it');
  PERFORM pg_temp.expect('E12 delete stale row', format('DELETE FROM public.transaction_submissions WHERE id IN (%L)', stale), 'rows:1');
  -- v1: insert, finalize
  PERFORM pg_temp.expect('E12 insert v1', format(ins, v1, org, agent, 1, NULL), 'rows:1');
  PERFORM pg_temp.expect('E12 finalize v1 -> submitted', format($q$UPDATE public.transaction_submissions SET status = 'submitted' WHERE id = %L$q$, v1), 'rows:1');
  PERFORM pg_temp.act_as(broker);
  PERFORM pg_temp.expect('E12 broker decision needs_changes',
    format($q$UPDATE public.transaction_submissions SET status = 'needs_changes', reviewed_by = %L, reviewed_at = now(), review_notes = 'Fix it' WHERE id = %L AND status IN ('submitted','resubmitted','under_review')$q$, broker, v1), 'rows:1');
  -- v2: insert with parent, finalize as resubmitted
  PERFORM pg_temp.act_as(agent);
  PERFORM pg_temp.expect('E12 insert v2', format(ins, v2, org, agent, 2, v1), 'rows:1');
  PERFORM pg_temp.expect('E12 finalize v2 -> resubmitted', format($q$UPDATE public.transaction_submissions SET status = 'resubmitted' WHERE id = %L$q$, v2), 'rows:1');
  -- an uploading row the app deletes (:1618-1622)
  PERFORM pg_temp.expect('E12 insert v9', format(ins, v9, org, agent, 3, v2), 'rows:1');
  PERFORM pg_temp.expect('E12 delete uploading v9', format('DELETE FROM public.transaction_submissions WHERE id = %L', v9), 'rows:1');
  PERFORM pg_temp.act_owner();
  PERFORM pg_temp.check((SELECT string_agg(x.e ->> 'status', ',' ORDER BY o) FROM jsonb_array_elements(pg_temp.hist(v1)) WITH ORDINALITY AS x(e, o))
                          = 'submitted,needs_changes', 'E12 v1 history submitted,needs_changes');
  PERFORM pg_temp.check(jsonb_array_length(pg_temp.hist(v2)) = 1 AND pg_temp.hist(v2) -> 0 ->> 'status' = 'resubmitted'
                        AND NOT (pg_temp.hist(v2) -> 0 ? 'type'), 'E12 v2 one untyped resubmitted entry');
  PERFORM pg_temp.check((SELECT status = 'needs_changes' FROM public.transaction_submissions WHERE id = v1), 'E12 v1 keeps its decision');
END
$e12$;
