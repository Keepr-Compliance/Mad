-- C14 / C14b (addendum 1, ruling a3f70fe0 4): once a newer version exists --
-- in ANY status, uploading included -- the older version refuses ticks.
-- Outsiders still read not_authorized. The newer version ticks normally. A
-- needs_changes version with no newer version refuses new ticks and unticks
-- (not_open_for_review, the refusals file), and writes nothing.
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

  -- A lone needs_changes version (no newer version) is closed to NEW ticks
  -- and unticks (the refusals file, 20260928130000). PR 1 pinned the
  -- opposite: that assertion described the BACKLOG-3477 status list and
  -- exposed an RLS dependency of the history append (SR C-12); it was not a
  -- product decision. Ticks made before Request Changes stay: see c23.
  lone := pg_temp.build_v1('fixture-3596-c14-lone');
  n1 := jsonb_array_length(pg_temp.hist(lone));
  t1 := pg_temp.tick_state(lone);
  PERFORM pg_temp.check(NOT (SELECT reviewer_checked FROM public.submission_checklist_items WHERE id = pg_temp.item(lone, 'L-item-4')),
                        'C14 lone: L-item-4 starts unticked');
  PERFORM pg_temp.act_as(broker);
  PERFORM pg_temp.expect('C14 lone needs_changes refuses a new tick', format('SELECT public.set_submission_checklist_reviewer_check(%L, true)', pg_temp.item(lone, 'L-item-4')), '~^42501:not_open_for_review$');
  PERFORM pg_temp.expect('C14 lone needs_changes refuses an untick', format('SELECT public.set_submission_checklist_reviewer_check(%L, false)', pg_temp.item(lone, 'L-item-1')), '~^42501:not_open_for_review$');
  PERFORM pg_temp.act_owner();
  PERFORM pg_temp.check(NOT (SELECT reviewer_checked FROM public.submission_checklist_items WHERE id = pg_temp.item(lone, 'L-item-4')),
                        'C14 lone: L-item-4 is still unticked');
  PERFORM pg_temp.check(pg_temp.tick_state(lone) = t1, 'C14 lone: tick state unchanged: ' || pg_temp.tick_state(lone));
  PERFORM pg_temp.check(jsonb_array_length(pg_temp.hist(lone)) = n1, 'C14 lone: status_history did not grow');
END
$c14$;
