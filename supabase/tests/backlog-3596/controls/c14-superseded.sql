-- C14 / C14b (addendum 1, ruling a3f70fe0 4): once a newer version exists --
-- in ANY status, uploading included -- the older version refuses ticks.
-- Outsiders still read not_authorized. The newer version ticks normally. A
-- needs_changes version with no newer version still ticks.
DO $c14$
DECLARE
  agent  uuid := pg_temp.id('u_t1_agent');
  broker uuid := pg_temp.id('u_t1_broker');
  v1     uuid := pg_temp.build_v1('fixture-3596-c14');
  v2     uuid;
  lone   uuid;
  t1     text;
  n1     integer;
  i4     uuid;
BEGIN
  t1 := pg_temp.tick_state(v1); n1 := jsonb_array_length(pg_temp.hist(v1));
  v2 := pg_temp.new_version(v1, 2);   -- uploading, no copy yet
  PERFORM pg_temp.act_as(broker);
  PERFORM pg_temp.expect('C14b tick on v1 while v2 uploads', format('SELECT public.set_submission_checklist_reviewer_check(%L, true)', pg_temp.item(v1, 'L-item-4')), '~^42501:superseded$');
  PERFORM pg_temp.expect('C14b untick on v1 while v2 uploads', format('SELECT public.set_submission_checklist_reviewer_check(%L, false)', pg_temp.item(v1, 'L-item-1')), '~^42501:superseded$');
  PERFORM pg_temp.act_owner();
  i4 := pg_temp.item(v1, 'L-item-4');   -- read as the owner: outsiders cannot see the row
  PERFORM pg_temp.act_as(pg_temp.id('u_t2_broker'));
  PERFORM pg_temp.expect('C14 other org broker', format('SELECT public.set_submission_checklist_reviewer_check(%L, true)', i4), '~^42501:not_authorized$');
  PERFORM pg_temp.act_as(agent);
  PERFORM pg_temp.expect('C14 the submitter', format('SELECT public.set_submission_checklist_reviewer_check(%L, true)', i4), '~^42501:not_authorized$');
  PERFORM pg_temp.act_owner();

  PERFORM pg_temp.snap_as(agent, v2, pg_temp.base_payload());
  PERFORM pg_temp.set_status(v2, 'resubmitted');
  PERFORM pg_temp.act_as(broker);
  PERFORM pg_temp.expect('C14 tick on v1 once v2 is resubmitted', format('SELECT public.set_submission_checklist_reviewer_check(%L, true)', pg_temp.item(v1, 'L-item-4')), '~^42501:superseded$');
  PERFORM pg_temp.expect('C14 v2 ticks', format('SELECT public.set_submission_checklist_reviewer_check(%L, true)', pg_temp.item(v2, 'L-item-4')), 'rows:1');
  PERFORM pg_temp.act_owner();
  PERFORM pg_temp.check(pg_temp.tick_state(v1) = t1 AND jsonb_array_length(pg_temp.hist(v1)) = n1, 'C14 v1 unchanged');

  lone := pg_temp.build_v1('fixture-3596-c14-lone');
  n1 := jsonb_array_length(pg_temp.hist(lone));
  PERFORM pg_temp.check(NOT (SELECT reviewer_checked FROM public.submission_checklist_items WHERE id = pg_temp.item(lone, 'L-item-4')),
                        'C14 lone: L-item-4 starts unticked');
  PERFORM pg_temp.act_as(broker);
  PERFORM pg_temp.expect('C14 needs_changes with no newer version still ticks', format('SELECT public.set_submission_checklist_reviewer_check(%L, true)', pg_temp.item(lone, 'L-item-4')), 'rows:1');
  PERFORM pg_temp.act_owner();
  -- The history append on a needs_changes row relies on the function owner
  -- (the 3592 UPDATE rule no longer admits a reviewer there): the tick must
  -- land AND its one Status History entry must be written.
  PERFORM pg_temp.check((SELECT reviewer_checked AND reviewer_checked_by = broker FROM public.submission_checklist_items
                          WHERE id = pg_temp.item(lone, 'L-item-4')), 'C14 lone: L-item-4 is ticked by the broker');
  PERFORM pg_temp.check(jsonb_array_length(pg_temp.hist(lone)) = n1 + 1, 'C14 lone: status_history grew by exactly one');
  PERFORM pg_temp.check(pg_temp.hist(lone) -> -1 ->> 'type' = 'checklist_review'
                        AND (pg_temp.hist(lone) -> -1 ->> 'changed_by')::uuid = broker
                        AND pg_temp.hist(lone) -> -1 ->> 'item_id' = pg_temp.item(lone, 'L-item-4')::text,
                        'C14 lone: the new entry is a checklist_review by the broker for L-item-4');
END
$c14$;
