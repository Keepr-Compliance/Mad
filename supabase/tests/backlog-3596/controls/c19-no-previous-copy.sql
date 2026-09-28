-- C19 (SR C-4, ruling a3f70fe0 3): the parent has no checklist copy.
--   a  v1 ticked, v2 has no copy, v3 -> nothing carried, ONE
--      checklist_review_unavailable entry, reason 'no_previous_copy'
--   b  v1 has a copy but no tick, v2 no copy, v3 -> NO entry
--   c  no copy before v3 at all (checklists first added at v3) -> NO entry
DO $c19$
DECLARE
  agent uuid := pg_temp.id('u_t1_agent');
  v1    uuid;
  v2    uuid;
  v3    uuid;
  res   jsonb;
  e     jsonb;
BEGIN
  v1 := pg_temp.build_v1('fixture-3596-c19a');
  v2 := pg_temp.new_version(v1, 2); PERFORM pg_temp.set_status(v2, 'needs_changes');
  v3 := pg_temp.new_version(v2, 3);
  res := pg_temp.snap_as(agent, v3, pg_temp.base_payload());
  e := pg_temp.hist(v3) -> 0;
  PERFORM pg_temp.check(jsonb_array_length(pg_temp.hist(v3)) = 1 AND e ->> 'type' = 'checklist_review_unavailable'
                        AND e ->> 'reason' = 'no_previous_copy' AND (e ->> 'changed_by')::uuid = agent,
                        'C19a one entry: ' || pg_temp.hist(v3)::text);
  PERFORM pg_temp.check(pg_temp.tick_state(v3) = '', 'C19a nothing carried: ' || res::text);

  v1 := pg_temp.build_v1('fixture-3596-c19b', NULL, false);
  v2 := pg_temp.new_version(v1, 2); PERFORM pg_temp.set_status(v2, 'needs_changes');
  v3 := pg_temp.new_version(v2, 3);
  res := pg_temp.snap_as(agent, v3, pg_temp.base_payload());
  PERFORM pg_temp.check(jsonb_array_length(pg_temp.hist(v3)) = 0, 'C19b never ticked: no entry: ' || res::text);

  v1 := pg_temp.mk_sub('fixture-3596-c19c', 1, NULL, 'needs_changes');
  v2 := pg_temp.new_version(v1, 2); PERFORM pg_temp.set_status(v2, 'needs_changes');
  v3 := pg_temp.new_version(v2, 3);
  res := pg_temp.snap_as(agent, v3, pg_temp.base_payload());
  PERFORM pg_temp.check(jsonb_array_length(pg_temp.hist(v3)) = 0, 'C19c first copy at v3: no entry: ' || res::text);
END
$c19$;
