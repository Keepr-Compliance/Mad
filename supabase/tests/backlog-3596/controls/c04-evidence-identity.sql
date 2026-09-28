-- C04 (plan C13, ruling a3f70fe0 1, SR C-6): "changed" is a set comparison
-- of the DESKTOP's own evidence ids plus the note, one deal per case.
--   a  links relabelled and regrouped, same files -> unchanged (carried)
--   b  note '' vs NULL vs whitespace              -> unchanged (carried)
--   c  a linked file not uploaded on v2 (a re-cache dropped the link)
--                                                 -> changed
--   d  re-linked to a different file              -> changed
--   e  one more file on the same link             -> changed
DO $c04$
DECLARE
  agent uuid := pg_temp.id('u_t1_agent');
  v1    uuid;
  v2    uuid;
  p     jsonb;
  res   jsonb;
BEGIN
  -- a
  v1 := pg_temp.build_v1('fixture-3596-c04a'); v2 := pg_temp.new_version(v1, 2);
  p := pg_temp.item_set(pg_temp.base_payload(), 'L-item-3', 'links', jsonb_build_array(
         jsonb_build_object('kind', 'email', 'label', 'Renamed thread', 'sort_order', 0, 'local_ids', jsonb_build_array('L-msg-2')),
         jsonb_build_object('kind', 'attachment', 'label', 'Renamed doc', 'sort_order', 1, 'local_ids', jsonb_build_array('L-att-2'))));
  p := pg_temp.item_set(p, 'L-item-1', 'links', jsonb_build_array(
         jsonb_build_object('kind', 'attachment', 'label', 'Doc 1a', 'local_ids', jsonb_build_array('L-att-1')),
         jsonb_build_object('kind', 'attachment', 'label', 'Doc 1b', 'local_ids', jsonb_build_array('L-att-1'))));
  res := pg_temp.snap_as(agent, v2, p);
  PERFORM pg_temp.check(pg_temp.tick_state(v2) = pg_temp.base_ticks() AND jsonb_array_length(pg_temp.hist(v2)) = 0,
                        'C04a relabel/regroup carries: ' || res::text);
  -- b
  v1 := pg_temp.build_v1('fixture-3596-c04b'); v2 := pg_temp.new_version(v1, 2);
  p := pg_temp.item_set(pg_temp.base_payload(), 'L-item-6', 'note', to_jsonb('   '::text));
  p := pg_temp.item_set(p, 'L-item-2', 'note', to_jsonb(''::text));
  p := pg_temp.item_set(p, 'L-item-1', 'note', to_jsonb(' n1 '::text));
  res := pg_temp.snap_as(agent, v2, p);
  PERFORM pg_temp.check(pg_temp.tick_state(v2) = pg_temp.base_ticks() AND jsonb_array_length(pg_temp.hist(v2)) = 0,
                        'C04b blank notes and outer spaces are equal: ' || res::text);
  -- c
  v1 := pg_temp.build_v1('fixture-3596-c04c'); v2 := pg_temp.new_version(v1, 2, ARRAY['L-att-2', 'L-att-3']);
  res := pg_temp.snap_as(agent, v2, pg_temp.base_payload());
  PERFORM pg_temp.check((res ->> 'dropped_links')::int = 1 AND (res -> 'carry' ->> 'cleared')::int = 1
                        AND (SELECT cleared_reviewer_id IS NOT NULL AND NOT reviewer_checked
                               FROM public.submission_checklist_items WHERE id = pg_temp.item(v2, 'L-item-1')),
                        'C04c link lost to a re-cache clears I1: ' || res::text);
  -- d
  v1 := pg_temp.build_v1('fixture-3596-c04d'); v2 := pg_temp.new_version(v1, 2);
  p := pg_temp.item_set(pg_temp.base_payload(), 'L-item-1', 'links', jsonb_build_array(
         jsonb_build_object('kind', 'attachment', 'label', 'Doc 1', 'local_ids', jsonb_build_array('L-att-9'))));
  res := pg_temp.snap_as(agent, v2, p);
  PERFORM pg_temp.check((res -> 'carry' ->> 'cleared')::int = 1 AND (res -> 'carry' ->> 'carried')::int = 4
                        AND (SELECT cleared_reviewer_id IS NOT NULL FROM public.submission_checklist_items WHERE id = pg_temp.item(v2, 'L-item-1')),
                        'C04d re-linked to another file clears I1: ' || res::text);
  -- e
  v1 := pg_temp.build_v1('fixture-3596-c04e'); v2 := pg_temp.new_version(v1, 2);
  p := pg_temp.item_set(pg_temp.base_payload(), 'L-item-1', 'links', jsonb_build_array(
         jsonb_build_object('kind', 'attachment', 'label', 'Doc 1', 'local_ids', jsonb_build_array('L-att-1', 'L-att-9'))));
  res := pg_temp.snap_as(agent, v2, p);
  PERFORM pg_temp.check((res -> 'carry' ->> 'cleared')::int = 1 AND (res -> 'carry' ->> 'carried')::int = 4,
                        'C04e an added file clears I1: ' || res::text);
END
$c04$;
