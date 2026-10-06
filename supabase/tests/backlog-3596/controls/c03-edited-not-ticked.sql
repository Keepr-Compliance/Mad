-- C03 (plan C3): an item the reviewer never ticked gets no marker and no
-- entry, however much it changed.
--   I4 gains a note and a link -> not ticked, no cleared columns, no entry;
--   the five ticked items still carry.
-- Wrong build this catches: a marker / entry for every changed item.
DO $c03$
DECLARE
  agent uuid := pg_temp.id('u_t1_agent');
  v1    uuid := pg_temp.build_v1('fixture-3596-c03');
  v2    uuid := pg_temp.new_version(v1, 2);
  p     jsonb := pg_temp.base_payload();
  res   jsonb;
BEGIN
  p := pg_temp.item_set(p, 'L-item-4', 'note', to_jsonb('now with a note'::text));
  p := pg_temp.item_set(p, 'L-item-4', 'links', jsonb_build_array(jsonb_build_object('kind', 'attachment', 'label', 'New', 'local_ids', jsonb_build_array('L-att-9'))));
  res := pg_temp.snap_as(agent, v2, p);
  PERFORM pg_temp.check((res -> 'carry' ->> 'carried')::int = 5 AND (res -> 'carry' ->> 'cleared')::int = 0
                        AND (res -> 'carry' ->> 'removed')::int = 0, 'C03 carry result: ' || res::text);
  PERFORM pg_temp.check((SELECT NOT reviewer_checked AND cleared_reviewer_id IS NULL AND cleared_at IS NULL
                           FROM public.submission_checklist_items WHERE id = pg_temp.item(v2, 'L-item-4')),
                        'C03 I4: no tick, no marker');
  PERFORM pg_temp.check(jsonb_array_length(pg_temp.hist(v2)) = 0, 'C03 no entry');
  PERFORM pg_temp.check(pg_temp.tick_state(v2) = pg_temp.base_ticks(), 'C03 the ticked items carried');
END
$c03$;
