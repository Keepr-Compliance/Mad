-- D07 (C-7, SR2): a checklist the broker removed at review is not the
-- agent's removal. Both keys: (a) B (no template) removed, v2 sends A only;
-- (b) A (template) removed, v2 sends B only. No item line blames the agent,
-- no checklist-level entry, the other checklist still carries.
DO $d07$
DECLARE
  agent  uuid := pg_temp.id('u_t1_agent');
  broker uuid := pg_temp.id('u_t1_broker');
  v1 uuid; v2 uuid; res jsonb;
BEGIN
  v1 := pg_temp.build_v1('fixture-3607-d07a');
  PERFORM pg_temp.set_status(v1, 'under_review');
  PERFORM pg_temp.remove_as(broker, pg_temp.hdr(v1, 'Fixture custom B'));
  PERFORM pg_temp.set_status(v1, 'needs_changes');
  v2 := pg_temp.new_version(v1, 2);
  res := pg_temp.snap_as(agent, v2, jsonb_build_array(pg_temp.base_payload() -> 0));
  PERFORM pg_temp.check((res -> 'carry' ->> 'carried')::int = 4 AND (res -> 'carry' ->> 'removed')::int = 0
                        AND jsonb_array_length(pg_temp.typed(v2, 'checklist_review_cleared')) = 0 AND pg_temp.vd(v2) = '',
                        'D07a: ' || (res -> 'carry')::text || ' vd=' || pg_temp.vd(v2));

  v1 := pg_temp.build_v1('fixture-3607-d07b');
  PERFORM pg_temp.set_status(v1, 'under_review');
  PERFORM pg_temp.remove_as(broker, pg_temp.hdr(v1, 'Fixture starter A'));
  PERFORM pg_temp.set_status(v1, 'needs_changes');
  v2 := pg_temp.new_version(v1, 2);
  res := pg_temp.snap_as(agent, v2, pg_temp.pb());
  PERFORM pg_temp.check((res -> 'carry' ->> 'carried')::int = 1 AND (res -> 'carry' ->> 'removed')::int = 0
                        AND jsonb_array_length(pg_temp.typed(v2, 'checklist_review_cleared')) = 0 AND pg_temp.vd(v2) = '',
                        'D07b: ' || (res -> 'carry')::text || ' vd=' || pg_temp.vd(v2));
END
$d07$;
