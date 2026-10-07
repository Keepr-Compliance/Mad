-- D04 (C-3): the previous version has NO checklist copy at all (snapshot
-- refused, pre-checklist desktop, or feature off then). Every checklist on
-- the new version is recorded with neutral copy: parent_had_none ("On this
-- version, not on version 1"), never as a plain agent add.
DO $d04$
DECLARE
  agent uuid := pg_temp.id('u_t1_agent');
  v1 uuid; v2 uuid;
BEGIN
  v1 := pg_temp.mk_sub('fixture-3607-d04', 1, NULL, 'uploading');
  PERFORM pg_temp.set_status(v1, 'submitted');
  PERFORM pg_temp.set_status(v1, 'needs_changes');
  v2 := pg_temp.new_version(v1, 2);
  PERFORM pg_temp.snap_as(agent, v2, pg_temp.base_payload());
  PERFORM pg_temp.check(pg_temp.vd(v2) = 'checklist_added:Fixture custom B:parent_had_none,checklist_added:Fixture starter A:parent_had_none',
                        'D04 neutral adds: ' || pg_temp.vd(v2));
END
$d04$;
