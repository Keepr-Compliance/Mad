-- C13 (plan D3, SR C-3, C-5): a reviewer-ticked parent item with no match
-- gets ONE 'removed' entry. A match needs local_item_id AND title AND the
-- checklist's template.
--   I5 dropped; I1 renamed (same local id); I2 moved to the template-less
--   checklist (same local id) -> 3 removed entries (item_id NULL,
--   cleared_from_item_id = the v1 item, v1's title); the renamed / moved v2
--   rows are neither ticked nor marked. I3, I6 carry.
DO $c13$
DECLARE
  agent uuid := pg_temp.id('u_t1_agent');
  v1    uuid := pg_temp.build_v1('fixture-3596-c13');
  v2    uuid := pg_temp.new_version(v1, 2);
  p     jsonb := pg_temp.base_payload();
  i2    jsonb := (SELECT x.it FROM jsonb_array_elements(pg_temp.base_payload() -> 0 -> 'items') AS x(it) WHERE x.it ->> 'local_item_id' = 'L-item-2');
  res   jsonb;
  e     jsonb;
  r     record;
BEGIN
  p := pg_temp.item_drop(p, 'L-item-5');
  p := pg_temp.item_set(p, 'L-item-1', 'title', to_jsonb('Item one (renamed)'::text));
  p := pg_temp.item_drop(p, 'L-item-2');
  p := jsonb_set(p, '{1,items}', (p -> 1 -> 'items') || jsonb_build_array(i2));
  res := pg_temp.snap_as(agent, v2, p);
  PERFORM pg_temp.check((res -> 'carry' ->> 'removed')::int = 3 AND (res -> 'carry' ->> 'carried')::int = 2
                        AND (res -> 'carry' ->> 'cleared')::int = 0, 'C13 carry result: ' || res::text);
  FOR r IN SELECT * FROM (VALUES ('L-item-1', 'Item one'), ('L-item-2', 'Item two'), ('L-item-5', 'Item five')) v(loc, title) LOOP
    SELECT x.e INTO e FROM jsonb_array_elements(pg_temp.typed(v2, 'checklist_review_cleared')) AS x(e)
     WHERE x.e ->> 'cleared_from_item_id' = pg_temp.item(v1, r.loc)::text;
    PERFORM pg_temp.check(e IS NOT NULL AND e ->> 'reason' = 'removed' AND e -> 'item_id' = 'null'::jsonb
                          AND e ->> 'item_title' = r.title AND (e ->> 'changed_by')::uuid = agent
                          AND (e ->> 'cleared_reviewer_id')::uuid = pg_temp.id('u_t1_broker'),
                          'C13 removed entry for ' || r.loc || ': ' || COALESCE(e::text, 'missing'));
  END LOOP;
  PERFORM pg_temp.check(jsonb_array_length(pg_temp.hist(v2)) = 3, 'C13 exactly three entries');
  PERFORM pg_temp.check((SELECT count(*) FROM public.submission_checklist_items
                          WHERE submission_id = v2 AND local_item_id IN ('L-item-1', 'L-item-2')
                            AND NOT reviewer_checked AND cleared_reviewer_id IS NULL) = 2,
                        'C13 renamed / moved rows neither ticked nor marked');
  PERFORM pg_temp.check(pg_temp.tick_state(v2) =
                          'L-item-3:' || pg_temp.id('u_t1_broker') || ':2026-09-01 10:03,L-item-6:' || pg_temp.id('u_t1_admin') || ':2026-09-01 10:06',
                        'C13 I3, I6 carried: ' || pg_temp.tick_state(v2));
END
$c13$;
