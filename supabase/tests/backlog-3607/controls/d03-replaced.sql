-- D03 (C-2): (a) the agent removed checklist A and picked it again (new
-- local item ids) -> removed + added, both flagged replaced; (b) an older
-- desktop (no local item ids at all) resubmits the identical set -> ZERO
-- checklist-level entries (SR3b).
DO $d03$
DECLARE
  agent uuid := pg_temp.id('u_t1_agent');
  v1 uuid; v2 uuid; p jsonb;
BEGIN
  v1 := pg_temp.build_v1('fixture-3607-d03a');
  v2 := pg_temp.new_version(v1, 2);
  p := pg_temp.base_payload();
  FOR i IN 1..5 LOOP
    p := pg_temp.item_set(p, 'L-item-' || i, 'local_item_id', to_jsonb('L-again-' || i));
  END LOOP;
  PERFORM pg_temp.snap_as(agent, v2, p);
  PERFORM pg_temp.check(pg_temp.vd(v2) = 'checklist_removed:Fixture starter A:replaced,checklist_added:Fixture starter A:replaced',
                        'D03a replaced: ' || pg_temp.vd(v2));

  v1 := pg_temp.build_v1('fixture-3607-d03b');
  v2 := pg_temp.new_version(v1, 2);
  PERFORM pg_temp.snap_as(agent, v2, pg_temp.strip_ids(pg_temp.base_payload()));
  PERFORM pg_temp.check(pg_temp.vd(v2) = '', 'D03b older desktop, same set -> no entry: ' || pg_temp.vd(v2));
END
$d03$;
