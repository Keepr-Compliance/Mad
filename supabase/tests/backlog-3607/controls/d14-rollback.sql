-- harness: rollback-3607
-- D14 (C-4.10): rollback-3607.sql restores the catalogue exactly as the three
-- 3596 files left it (t3607_s0 = before the 3607 file, t3607_s1 = after it).
DO $d14$
DECLARE a bigint; b bigint; d bigint;
BEGIN
  SELECT count(*) INTO d FROM (SELECT * FROM t3607_s1 EXCEPT SELECT * FROM t3607_s0) x;
  PERFORM pg_temp.check(d > 0, 'D14 the 3607 file changed the catalogue: ' || d);
  SELECT count(*) INTO a FROM (SELECT * FROM t3607_s0 EXCEPT SELECT * FROM pg_temp.snap3607()) x;
  SELECT count(*) INTO b FROM (SELECT * FROM pg_temp.snap3607() EXCEPT SELECT * FROM t3607_s0) x;
  PERFORM pg_temp.check(a = 0 AND b = 0, format('D14 rollback restores everything: only-before %s, only-after %s', a, b));
END
$d14$;
