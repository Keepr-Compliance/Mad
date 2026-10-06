-- D01 (C-6 + plan §1): the version diff, keyed on template (name when no
-- template). (a) the identical set -> ZERO entries (catches a header-id key:
-- cloud header ids are new every version); (b) the agent removes B (no
-- template) -> one checklist_removed naming B, by the agent; (c) the agent
-- adds template B -> one checklist_added, by the agent.
DO $d01$
DECLARE
  agent uuid := pg_temp.id('u_t1_agent');
  v1 uuid; v2 uuid; e jsonb;
BEGIN
  v1 := pg_temp.build_v1('fixture-3607-d01a');
  v2 := pg_temp.new_version(v1, 2);
  PERFORM pg_temp.snap_as(agent, v2, pg_temp.base_payload());
  PERFORM pg_temp.check(pg_temp.vd(v2) = '', 'D01a identical set -> no entry: ' || pg_temp.vd(v2));

  v1 := pg_temp.build_v1('fixture-3607-d01b');
  v2 := pg_temp.new_version(v1, 2);
  PERFORM pg_temp.snap_as(agent, v2, jsonb_build_array(pg_temp.base_payload() -> 0));
  PERFORM pg_temp.check(pg_temp.vd(v2) = 'checklist_removed:Fixture custom B', 'D01b B removed: ' || pg_temp.vd(v2));
  e := pg_temp.typed(v2, 'checklist_removed') -> 0;
  PERFORM pg_temp.check((e ->> 'changed_by')::uuid = agent AND (e ->> 'from_version')::int = 1
                        AND e ->> 'checklist_key' = 'name:Fixture custom B' AND e ->> 'template_id' IS NULL
                        AND (e ->> 'removed_checklist_id')::uuid = pg_temp.hdr(v1, 'Fixture custom B'),
                        'D01b entry fields: ' || COALESCE(e::text, 'missing'));

  v1 := pg_temp.build_v1('fixture-3607-d01c');
  v2 := pg_temp.new_version(v1, 2);
  PERFORM pg_temp.snap_as(agent, v2, pg_temp.base_payload() || jsonb_build_array(jsonb_build_object(
            'template_id', pg_temp.id('tpl_t1_b')::text, 'template_name', 'Fixture B tpl', 'sort_order', 2,
            'items', jsonb_build_array(jsonb_build_object('title', 'New one', 'local_item_id', 'L-new-1')))));
  PERFORM pg_temp.check(pg_temp.vd(v2) = 'checklist_added:Fixture B tpl', 'D01c added: ' || pg_temp.vd(v2));
  e := pg_temp.typed(v2, 'checklist_added') -> 0;
  PERFORM pg_temp.check((e ->> 'changed_by')::uuid = agent AND (e ->> 'template_id')::uuid = pg_temp.id('tpl_t1_b'),
                        'D01c entry fields: ' || COALESCE(e::text, 'missing'));
END
$d01$;
