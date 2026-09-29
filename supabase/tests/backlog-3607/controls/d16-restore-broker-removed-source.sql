-- D16 (C-4.2 "not broker-removed"): the one shape where the history check
-- alone would admit a broker-removed source: two no-template checklists with
-- the SAME name on v1 (the key is the name), the broker removed one, the
-- agent's v2 has neither. v2's history records the agent's removal of that
-- name, so only the source's own removal marker refuses the broker-removed
-- copy ('not_removed'); the other copy restores.
DO $d16$
DECLARE
  agent  uuid := pg_temp.id('u_t1_agent');
  broker uuid := pg_temp.id('u_t1_broker');
  v1 uuid; v2 uuid; b1 uuid; b2 uuid; res jsonb;
BEGIN
  v1 := pg_temp.build_v1('fixture-3607-d16', pg_temp.base_payload() || jsonb_build_array(jsonb_build_object(
          'template_name', 'Fixture custom B', 'sort_order', 2,
          'items', jsonb_build_array(jsonb_build_object('title', 'Item seven', 'local_item_id', 'L-item-7')))), false);
  PERFORM pg_temp.set_status(v1, 'under_review');
  SELECT id INTO b1 FROM public.submission_checklists WHERE submission_id = v1 AND template_name = 'Fixture custom B' AND sort_order = 1;
  SELECT id INTO b2 FROM public.submission_checklists WHERE submission_id = v1 AND template_name = 'Fixture custom B' AND sort_order = 2;
  PERFORM pg_temp.remove_as(broker, b2);
  PERFORM pg_temp.set_status(v1, 'needs_changes');
  v2 := pg_temp.new_version(v1, 2);
  PERFORM pg_temp.snap_as(agent, v2, jsonb_build_array(pg_temp.base_payload() -> 0));
  PERFORM pg_temp.set_status(v2, 'resubmitted');
  PERFORM pg_temp.check(pg_temp.vd(v2) = 'checklist_removed:Fixture custom B', 'D16 agent removal recorded: ' || pg_temp.vd(v2));
  -- the entry names the header the portal must restore: the agent-removed copy, never the broker-removed one
  PERFORM pg_temp.check((pg_temp.typed(v2, 'checklist_removed') -> 0 ->> 'removed_checklist_id')::uuid = b1,
                        'D16 removed_checklist_id is the agent-removed copy: ' || (pg_temp.typed(v2, 'checklist_removed') -> 0)::text);
  res := pg_temp.restore_as(broker, v2, b2);
  PERFORM pg_temp.check(res ->> 'status' = 'not_removed', 'D16 broker-removed source refused: ' || res::text);
  res := pg_temp.restore_as(broker, v2, b1);
  PERFORM pg_temp.check(res ->> 'status' = 'restored', 'D16 the agent-removed copy restores: ' || res::text);
END
$d16$;
