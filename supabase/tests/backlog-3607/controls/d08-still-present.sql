-- D08 (plan §2 "already resubmitted"): the broker removed A at review, but
-- the agent's next version still carries A (the pull failed, 3599). It is
-- recorded as after_broker_removal, and A's old ticks do not carry.
DO $d08$
DECLARE
  agent  uuid := pg_temp.id('u_t1_agent');
  broker uuid := pg_temp.id('u_t1_broker');
  v1 uuid; v2 uuid; res jsonb;
BEGIN
  v1 := pg_temp.build_v1('fixture-3607-d08');
  PERFORM pg_temp.set_status(v1, 'under_review');
  PERFORM pg_temp.remove_as(broker, pg_temp.hdr(v1, 'Fixture starter A'));
  PERFORM pg_temp.set_status(v1, 'needs_changes');
  v2 := pg_temp.new_version(v1, 2);
  res := pg_temp.snap_as(agent, v2, pg_temp.base_payload());
  PERFORM pg_temp.check(pg_temp.vd(v2) = 'checklist_added:Fixture starter A:after_broker_removal', 'D08 vd=' || pg_temp.vd(v2));
  PERFORM pg_temp.check((res -> 'carry' ->> 'carried')::int = 1, 'D08 only B carries: ' || (res -> 'carry')::text);

  -- a checklist the broker ADDED at review that is not on the next version
  -- (agent removed it, or the pull failed): flagged added_at_review.
  v1 := pg_temp.added_v1('fixture-3607-d08b');
  PERFORM pg_temp.add_as(broker, v1, pg_temp.id('tpl_t1_a'));
  PERFORM pg_temp.set_status(v1, 'needs_changes');
  v2 := pg_temp.new_version(v1, 2);
  PERFORM pg_temp.snap_as(agent, v2, pg_temp.pb());
  PERFORM pg_temp.check(pg_temp.vd(v2) = 'checklist_removed:' || (SELECT name FROM public.checklist_templates WHERE id = pg_temp.id('tpl_t1_a')) || ':added_at_review',
                        'D08b vd=' || pg_temp.vd(v2));
END
$d08$;
