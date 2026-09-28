-- C23 (coordinator conditions 6fa8c7ae): the needs_changes refusal stops only
-- NEW ticks and unticks. Both ways:
--   (a) on a needs_changes version, a new tick, an untick and an admin untick
--       are refused (not_open_for_review) and nothing is written;
--   (b) the ticks made BEFORE Request Changes stay on that version and carry
--       to the next version with their original reviewer and time.
-- The wrong form -- "no reviewer values on a needs_changes row" -- passes (a)
-- and fails (b); m45 is that form.
DO $c23$
DECLARE
  agent  uuid := pg_temp.id('u_t1_agent');
  broker uuid := pg_temp.id('u_t1_broker');
  admin  uuid := pg_temp.id('u_t1_admin');
  v1     uuid := pg_temp.build_v1('fixture-3596-c23');   -- ticked while submitted, then needs_changes
  v2     uuid;
  n1     integer;
  res    jsonb;
BEGIN
  PERFORM pg_temp.check((SELECT status FROM public.transaction_submissions WHERE id = v1) = 'needs_changes', 'C23 v1 is needs_changes');
  PERFORM pg_temp.check(pg_temp.tick_state(v1) = pg_temp.base_ticks(), 'C23 v1 keeps the ticks made before Request Changes: ' || pg_temp.tick_state(v1));
  n1 := jsonb_array_length(pg_temp.hist(v1));

  -- (a)
  PERFORM pg_temp.act_as(broker);
  PERFORM pg_temp.expect('C23 new tick on needs_changes', format('SELECT public.set_submission_checklist_reviewer_check(%L, true)', pg_temp.item(v1, 'L-item-4')), '~^42501:not_open_for_review$');
  PERFORM pg_temp.expect('C23 untick on needs_changes', format('SELECT public.set_submission_checklist_reviewer_check(%L, false)', pg_temp.item(v1, 'L-item-1')), '~^42501:not_open_for_review$');
  PERFORM pg_temp.expect('C23 re-tick of a ticked item on needs_changes', format('SELECT public.set_submission_checklist_reviewer_check(%L, true)', pg_temp.item(v1, 'L-item-2')), '~^42501:not_open_for_review$');
  PERFORM pg_temp.act_as(admin);
  PERFORM pg_temp.expect('C23 admin untick on needs_changes', format('SELECT public.set_submission_checklist_reviewer_check(%L, false)', pg_temp.item(v1, 'L-item-6')), '~^42501:not_open_for_review$');
  PERFORM pg_temp.act_owner();
  PERFORM pg_temp.check(pg_temp.tick_state(v1) = pg_temp.base_ticks(), 'C23 (a) v1 ticks unchanged: ' || pg_temp.tick_state(v1));
  PERFORM pg_temp.check(jsonb_array_length(pg_temp.hist(v1)) = n1, 'C23 (a) v1 status_history did not grow');

  -- (b)
  v2 := pg_temp.new_version(v1, 2);
  res := pg_temp.snap_as(agent, v2, pg_temp.base_payload());
  PERFORM pg_temp.check((res -> 'carry' ->> 'carried')::int = 5, 'C23 (b) carry result: ' || (res -> 'carry')::text);
  PERFORM pg_temp.check(pg_temp.tick_state(v2) = pg_temp.base_ticks(),
                        'C23 (b) v2 carries every earlier tick with its original reviewer and time: ' || pg_temp.tick_state(v2));
  PERFORM pg_temp.check(jsonb_array_length(pg_temp.typed(v2, 'checklist_review_cleared')) = 0
                        AND jsonb_array_length(pg_temp.typed(v2, 'checklist_review_unavailable')) = 0,
                        'C23 (b) nothing cleared or unavailable on v2');
END
$c23$;
