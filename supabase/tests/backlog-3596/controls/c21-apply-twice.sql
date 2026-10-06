-- harness: apply-twice
-- C21: the file is safe to apply twice. run.sh snapshots the catalogue after
-- the first apply (t3596_s1), applies the file again, and this control
-- compares every policy, column, constraint, index, function, trigger and
-- table grant.
DO $c21$
DECLARE
  n1 bigint; a bigint; b bigint;
BEGIN
  SELECT count(*) INTO n1 FROM t3596_s1;
  SELECT count(*) INTO a FROM (SELECT * FROM t3596_s1 EXCEPT SELECT * FROM pg_temp.snap3596()) d;
  SELECT count(*) INTO b FROM (SELECT * FROM pg_temp.snap3596() EXCEPT SELECT * FROM t3596_s1) d;
  PERFORM pg_temp.check(n1 > 60, 'C21 snapshot has rows: ' || n1);
  PERFORM pg_temp.check(a = 0 AND b = 0, format('C21 second apply changed nothing: only-first %s, only-second %s', a, b));
END
$c21$;
