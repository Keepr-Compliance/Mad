-- harness: rollback-refusals
-- C25: rollback-refusals.sql restores the catalogue exactly as
-- 20260928120000 left it. run.sh snapshots after that file (t3596_r0), applies
-- the refusals file, snapshots again (t3596_r1), runs rollback-refusals.sql.
-- Then, behaviour on the restored bodies: a lone needs_changes version ticks
-- again (the 20260928120000 behaviour).
DO $c25$
DECLARE
  a bigint; b bigint; d bigint;
  lone uuid;
BEGIN
  SELECT count(*) INTO d FROM (SELECT * FROM t3596_r1 EXCEPT SELECT * FROM t3596_r0) x;
  PERFORM pg_temp.check(d = 2, 'C25 the refusals file changed exactly two catalogue rows: ' || d);
  SELECT count(*) INTO a FROM (SELECT * FROM t3596_r0 EXCEPT SELECT * FROM pg_temp.snap3596()) x;
  SELECT count(*) INTO b FROM (SELECT * FROM pg_temp.snap3596() EXCEPT SELECT * FROM t3596_r0) x;
  PERFORM pg_temp.check(a = 0 AND b = 0, format('C25 rollback-refusals restores everything: only-before %s, only-after %s', a, b));

  lone := pg_temp.build_v1('fixture-3596-c25');
  PERFORM pg_temp.act_as(pg_temp.id('u_t1_broker'));
  PERFORM pg_temp.expect('C25 restored tick accepts a lone needs_changes version',
                         format('SELECT public.set_submission_checklist_reviewer_check(%L, true)', pg_temp.item(lone, 'L-item-4')), 'rows:1');
  PERFORM pg_temp.act_owner();
END
$c25$;
