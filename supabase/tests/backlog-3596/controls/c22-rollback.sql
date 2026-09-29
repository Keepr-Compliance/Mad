-- harness: rollback
-- C22 (SR C-9): rollback.sql restores the catalogue exactly. run.sh
-- snapshots it before the migration (t3596_s0) and after it (t3596_s2), then
-- runs rollback.sql. Then, on the restored functions: the snapshot RPC
-- accepts a payload carrying local_item_id (the desktop change can ship
-- before this migration is applied).
DO $c22$
DECLARE
  a bigint; b bigint; d bigint;
  s   uuid;
  res jsonb;
BEGIN
  SELECT count(*) INTO d FROM (SELECT * FROM t3596_s2 EXCEPT SELECT * FROM t3596_s0) x;
  PERFORM pg_temp.check(d >= 8, 'C22 the migration changed the catalogue: ' || d || ' rows');
  SELECT count(*) INTO a FROM (SELECT * FROM t3596_s0 EXCEPT SELECT * FROM pg_temp.snap3596()) x;
  SELECT count(*) INTO b FROM (SELECT * FROM pg_temp.snap3596() EXCEPT SELECT * FROM t3596_s0) x;
  PERFORM pg_temp.check(a = 0 AND b = 0, format('C22 rollback restores everything: only-before %s, only-after %s', a, b));

  s := pg_temp.mk_sub('fixture-3596-c22', 1, NULL, 'uploading');
  PERFORM pg_temp.mk_uploads(s, pg_temp.v1_att(), pg_temp.v_msg());
  res := pg_temp.snap_as(pg_temp.id('u_t1_agent'), s, pg_temp.base_payload());
  PERFORM pg_temp.check((res ->> 'items')::int = 6 AND NOT (res ? 'carry'), 'C22 restored snapshot takes the new payload: ' || res::text);
END
$c22$;
