-- C02 (plan C2, ruling f581efb4 1-2): a changed, reviewer-ticked item arrives
-- UNticked, marked, with ONE typed entry naming the resubmitting agent.
--   I1 note changed; I2's email swapped for another; I3 lost its email link.
--   -> I1, I2, I3 unticked; cleared_reviewer_id = the broker; cleared_at set
--   -> exactly 3 checklist_review_cleared entries, reason 'edited',
--      changed_by = the agent, item_id = v2 item, cleared_from_item_id = v1
--      item, cleared_reviewer_checked_at = v1's original time
--   -> I5, I6 carried; every entry on v2 names the agent (no other actor)
DO $c02$
DECLARE
  agent  uuid := pg_temp.id('u_t1_agent');
  broker uuid := pg_temp.id('u_t1_broker');
  v1     uuid := pg_temp.build_v1('fixture-3596-c02');
  v2     uuid := pg_temp.new_version(v1, 2);
  p      jsonb := pg_temp.base_payload();
  res    jsonb;
  e      jsonb;
  r      record;
BEGIN
  p := pg_temp.item_set(p, 'L-item-1', 'note', to_jsonb('n1 edited'::text));
  p := pg_temp.item_set(p, 'L-item-2', 'links', jsonb_build_array(jsonb_build_object('kind', 'email', 'label', 'Thread 1', 'local_ids', jsonb_build_array('L-msg-2'))));
  p := pg_temp.item_set(p, 'L-item-3', 'links', jsonb_build_array(jsonb_build_object('kind', 'attachment', 'label', 'Doc 2', 'local_ids', jsonb_build_array('L-att-2'))));
  res := pg_temp.snap_as(agent, v2, p);
  PERFORM pg_temp.check((res -> 'carry' ->> 'carried')::int = 2 AND (res -> 'carry' ->> 'cleared')::int = 3
                        AND (res -> 'carry' ->> 'removed')::int = 0, 'C02 carry result: ' || res::text);
  PERFORM pg_temp.check(pg_temp.tick_state(v2) =
                          'L-item-5:broker:2026-09-01 10:05,L-item-6:admin:2026-09-01 10:06',
                        'C02 only I5, I6 carried: ' || pg_temp.tick_state(v2));
  FOR r IN SELECT * FROM (VALUES ('L-item-1', 'Item one', 1), ('L-item-2', 'Item two', 2), ('L-item-3', 'Item three', 3)) v(loc, title, n) LOOP
    PERFORM pg_temp.check((SELECT NOT reviewer_checked AND reviewer_checked_by IS NULL AND cleared_reviewer_id = broker AND cleared_at IS NOT NULL
                             FROM public.submission_checklist_items WHERE id = pg_temp.item(v2, r.loc)),
                          'C02 ' || r.loc || ' unticked and marked');
    SELECT x.e INTO e FROM jsonb_array_elements(pg_temp.typed(v2, 'checklist_review_cleared')) AS x(e)
     WHERE x.e ->> 'item_id' = pg_temp.item(v2, r.loc)::text;
    PERFORM pg_temp.check(e IS NOT NULL
                          AND e ->> 'reason' = 'edited'
                          AND (e ->> 'changed_by')::uuid = agent
                          AND e ? 'changed_at'
                          AND NOT (e ? 'status')
                          AND (e ->> 'cleared_from_item_id')::uuid = pg_temp.item(v1, r.loc)
                          AND (e ->> 'cleared_reviewer_id')::uuid = broker
                          AND (e ->> 'cleared_reviewer_checked_at')::timestamptz = ('2026-09-01 10:0' || r.n || ':00+00')::timestamptz
                          AND e ->> 'item_title' = r.title
                          AND e ->> 'checklist_name' = 'Fixture starter A',
                          'C02 entry for ' || r.loc || ': ' || COALESCE(e::text, 'missing'));
  END LOOP;
  PERFORM pg_temp.check(jsonb_array_length(pg_temp.typed(v2, 'checklist_review_cleared')) = 3, 'C02 exactly three cleared entries');
  PERFORM pg_temp.check(jsonb_array_length(pg_temp.hist(v2)) = 3, 'C02 nothing else appended');
  PERFORM pg_temp.check(NOT EXISTS (SELECT 1 FROM jsonb_array_elements(pg_temp.hist(v2)) AS x(e)
                                     WHERE x.e ->> 'changed_by' IS DISTINCT FROM agent::text),
                        'C02 every entry names the agent');
END
$c02$;
