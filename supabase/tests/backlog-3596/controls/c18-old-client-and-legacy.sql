-- C18 (SR C-5, C-7, ruling bea72fda, D5):
--   a  an older desktop (no local_item_id on any item), parent ticked
--      -> nothing carried, ONE checklist_review_unavailable entry, reason
--         'unmatched_client', changed_by = the agent; no cleared entries
--   b  a parent written before this migration (no local ids), ticked, and a
--      current desktop -> nothing carried, NO entry
--   c  an older desktop, parent never ticked -> NO entry
DO $c18$
DECLARE
  agent uuid := pg_temp.id('u_t1_agent');
  v1    uuid;
  v2    uuid;
  res   jsonb;
  e     jsonb;
BEGIN
  v1 := pg_temp.build_v1('fixture-3596-c18a'); v2 := pg_temp.new_version(v1, 2);
  res := pg_temp.snap_as(agent, v2, pg_temp.strip_ids(pg_temp.base_payload()));
  e := pg_temp.hist(v2) -> 0;
  PERFORM pg_temp.check(jsonb_array_length(pg_temp.hist(v2)) = 1 AND e ->> 'type' = 'checklist_review_unavailable'
                        AND e ->> 'reason' = 'unmatched_client' AND (e ->> 'changed_by')::uuid = agent AND e ? 'changed_at',
                        'C18a one unavailable entry: ' || pg_temp.hist(v2)::text);
  PERFORM pg_temp.check(pg_temp.tick_state(v2) = '' AND res -> 'carry' ->> 'unavailable' = 'unmatched_client', 'C18a nothing carried: ' || res::text);

  v1 := pg_temp.build_v1('fixture-3596-c18b', pg_temp.strip_ids(pg_temp.base_payload())); v2 := pg_temp.new_version(v1, 2);
  PERFORM pg_temp.check((SELECT count(*) FROM public.submission_checklist_items WHERE submission_id = v1 AND reviewer_checked) = 5, 'C18b legacy parent is ticked');
  res := pg_temp.snap_as(agent, v2, pg_temp.base_payload());
  PERFORM pg_temp.check(pg_temp.tick_state(v2) = '' AND jsonb_array_length(pg_temp.hist(v2)) = 0, 'C18b legacy parent: no carry, no entry: ' || res::text);

  v1 := pg_temp.build_v1('fixture-3596-c18c', NULL, false); v2 := pg_temp.new_version(v1, 2);
  res := pg_temp.snap_as(agent, v2, pg_temp.strip_ids(pg_temp.base_payload()));
  PERFORM pg_temp.check(jsonb_array_length(pg_temp.hist(v2)) = 0, 'C18c no ticks anywhere: no entry: ' || res::text);
END
$c18$;
