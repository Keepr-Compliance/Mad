-- C06 (plan C6, addendum 2): a second carry writes nothing.
--   deal A: I1 edited, I5 removed -> 1 edited + 1 removed entry, 4 carried;
--           a direct second call -> 0/0/0, history and ticks unchanged
--   deal B: an older desktop (no item ids) -> 1 unavailable entry; a second
--           call adds no second one
DO $c06$
DECLARE
  agent uuid := pg_temp.id('u_t1_agent');
  v1    uuid;
  v2    uuid;
  res   jsonb;
  h     jsonb;
  t     text;
BEGIN
  v1 := pg_temp.build_v1('fixture-3596-c06a'); v2 := pg_temp.new_version(v1, 2);
  res := pg_temp.snap_as(agent, v2, pg_temp.item_drop(pg_temp.item_set(pg_temp.base_payload(), 'L-item-1', 'note', to_jsonb('edited'::text)), 'L-item-5'));
  PERFORM pg_temp.check((res -> 'carry' ->> 'cleared')::int = 1 AND (res -> 'carry' ->> 'removed')::int = 1
                        AND (res -> 'carry' ->> 'carried')::int = 3, 'C06a first call: ' || res::text);
  h := pg_temp.hist(v2); t := pg_temp.tick_state(v2);
  PERFORM pg_temp.act_as(agent);
  res := public.carry_submission_checklist_reviews(v2);
  PERFORM pg_temp.act_owner();
  PERFORM pg_temp.check((res ->> 'carried')::int = 0 AND (res ->> 'cleared')::int = 0 AND (res ->> 'removed')::int = 0,
                        'C06a second call: ' || res::text);
  PERFORM pg_temp.check(pg_temp.hist(v2) = h AND pg_temp.tick_state(v2) = t AND jsonb_array_length(h) = 2,
                        'C06a nothing written twice');

  v1 := pg_temp.build_v1('fixture-3596-c06b'); v2 := pg_temp.new_version(v1, 2);
  res := pg_temp.snap_as(agent, v2, pg_temp.strip_ids(pg_temp.base_payload()));
  PERFORM pg_temp.act_as(agent);
  res := public.carry_submission_checklist_reviews(v2);
  PERFORM pg_temp.act_owner();
  PERFORM pg_temp.check(jsonb_array_length(pg_temp.typed(v2, 'checklist_review_unavailable')) = 1
                        AND jsonb_array_length(pg_temp.hist(v2)) = 1, 'C06b one unavailable entry after two calls: ' || res::text);
END
$c06$;
