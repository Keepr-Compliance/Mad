-- C08 (plan C8): a version sent with no checklists gets nothing carried and
-- no entry, even though its parent was reviewed.
DO $c08$
DECLARE
  v1  uuid := pg_temp.build_v1('fixture-3596-c08');
  v2  uuid := pg_temp.new_version(v1, 2);
  res jsonb;
BEGIN
  res := pg_temp.snap_as(pg_temp.id('u_t1_agent'), v2, '[]'::jsonb);
  PERFORM pg_temp.check(res -> 'carry' = '{"status": "no_checklists"}'::jsonb, 'C08 carry result: ' || res::text);
  PERFORM pg_temp.check(jsonb_array_length(pg_temp.hist(v2)) = 0, 'C08 no entry');
END
$c08$;
