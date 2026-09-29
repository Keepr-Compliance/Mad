-- C24 (SR addendum 80f5ae11, coordinator 5b7fda6f): add-at-review refuses a
-- version that already has a newer version, in any status (uploading
-- included), after the authorization checks.
--
-- FIXTURE HONESTY: the refused state is the crafted-request state only. The
-- desktop creates a new version only when the latest is needs_changes, and
-- add refuses needs_changes. Here the agent moves its OWN needs_changes v1
-- back to 'resubmitted' after v2 exists, through the submitter branch of
-- transaction_submissions_update_public -- the one path that reopens it.
-- Shipped code never sends that request.
DO $c24$
DECLARE
  agent   uuid := pg_temp.id('u_t1_agent');
  broker  uuid := pg_temp.id('u_t1_broker');
  tpl     uuid := pg_temp.id('tpl_t1_a');
  payload jsonb := jsonb_build_array(pg_temp.base_payload() -> 1);   -- checklist B only: tpl_t1_a is not on it
  add_q   text := 'SELECT public.add_submission_checklist_at_review(%L, %L)';
  v1      uuid;
  v2      uuid;
  open1   uuid;
  n1      integer;
  h1      integer;
  res     jsonb;
BEGIN
  v1 := pg_temp.build_v1('fixture-3596-c24', payload, false);        -- ends needs_changes
  v2 := pg_temp.new_version(v1, 2);                                   -- uploading
  PERFORM pg_temp.act_as(agent);
  PERFORM pg_temp.expect('C24 crafted: the agent reopens its own needs_changes v1',
                         format('UPDATE public.transaction_submissions SET status = %L WHERE id = %L', 'resubmitted', v1), 'rows:1');
  PERFORM pg_temp.act_owner();
  PERFORM pg_temp.check((SELECT status FROM public.transaction_submissions WHERE id = v1) = 'resubmitted', 'C24 v1 is open again (crafted)');
  n1 := jsonb_array_length(pg_temp.hist(v1));
  SELECT count(*) INTO h1 FROM public.submission_checklists WHERE submission_id = v1;

  -- newer version still uploading
  PERFORM pg_temp.act_as(broker);
  PERFORM pg_temp.expect('C24 add on v1 while v2 uploads', format(add_q, v1, tpl), '~^42501:superseded$');
  PERFORM pg_temp.act_as(pg_temp.id('u_t2_broker'));
  PERFORM pg_temp.expect('C24 other org broker on superseded v1', format(add_q, v1, tpl), '~^42501:not_authorized$');
  PERFORM pg_temp.act_as(agent);
  PERFORM pg_temp.expect('C24 the submitter on superseded v1', format(add_q, v1, tpl), '~^42501:not_authorized$');
  PERFORM pg_temp.act_owner();

  -- newer version landed
  PERFORM pg_temp.snap_as(agent, v2, payload);
  PERFORM pg_temp.set_status(v2, 'resubmitted');
  PERFORM pg_temp.act_as(broker);
  PERFORM pg_temp.expect('C24 add on v1 once v2 is resubmitted', format(add_q, v1, tpl), '~^42501:superseded$');
  PERFORM pg_temp.act_owner();

  PERFORM pg_temp.check((SELECT count(*) FROM public.submission_checklists WHERE submission_id = v1) = h1
                        AND NOT EXISTS (SELECT 1 FROM public.submission_checklists WHERE submission_id = v1 AND added_at_review_by IS NOT NULL),
                        'C24 no checklist added to v1');
  PERFORM pg_temp.check(jsonb_array_length(pg_temp.hist(v1)) = n1, 'C24 v1 status_history did not grow');

  -- the newer version itself, open with no newer one: add still works
  PERFORM pg_temp.act_as(broker);
  res := public.add_submission_checklist_at_review(v2, tpl);
  PERFORM pg_temp.act_owner();
  PERFORM pg_temp.check(res ->> 'status' = 'added', 'C24 add on open v2 (no newer version): ' || res::text);

  -- an open version with no newer version, never superseded
  open1 := pg_temp.build_v1('fixture-3596-c24-open', payload, false);
  PERFORM pg_temp.set_status(open1, 'under_review');
  n1 := jsonb_array_length(pg_temp.hist(open1));
  PERFORM pg_temp.act_as(broker);
  res := public.add_submission_checklist_at_review(open1, tpl);
  PERFORM pg_temp.act_owner();
  PERFORM pg_temp.check(res ->> 'status' = 'added', 'C24 add on an unsuperseded open version: ' || res::text);
  PERFORM pg_temp.check(EXISTS (SELECT 1 FROM public.submission_checklists WHERE submission_id = open1 AND template_id = tpl AND added_at_review_by = broker)
                        AND pg_temp.hist(open1) -> -1 ->> 'type' = 'checklist_added'
                        AND jsonb_array_length(pg_temp.hist(open1)) > n1,
                        'C24 the added checklist and its checklist_added entry exist');
END
$c24$;
