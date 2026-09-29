-- C09 (plan C9): v1 -> v2 -> v3, unchanged throughout: v3 still shows v1's
-- reviewer and time (v2 held the carried tick verbatim).
DO $c09$
DECLARE
  agent uuid := pg_temp.id('u_t1_agent');
  v1    uuid := pg_temp.build_v1('fixture-3596-c09');
  v2    uuid := pg_temp.new_version(v1, 2);
  v3    uuid;
BEGIN
  PERFORM pg_temp.snap_as(agent, v2, pg_temp.base_payload());
  PERFORM pg_temp.set_status(v2, 'resubmitted');
  PERFORM pg_temp.set_status(v2, 'needs_changes');
  v3 := pg_temp.new_version(v2, 3);
  PERFORM pg_temp.snap_as(agent, v3, pg_temp.base_payload());
  PERFORM pg_temp.check(pg_temp.tick_state(v3) = pg_temp.base_ticks(), 'C09 v3 ticks: ' || pg_temp.tick_state(v3));
  PERFORM pg_temp.check(jsonb_array_length(pg_temp.hist(v3)) = 0, 'C09 silent on v3');
END
$c09$;
