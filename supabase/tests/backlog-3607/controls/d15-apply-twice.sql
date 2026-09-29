-- harness: apply-twice
-- D15: the 3607 file is safe to run twice: the second run changes no
-- catalogue row (t3607_s1 = after the first run).
DO $d15$
DECLARE a bigint; b bigint;
BEGIN
  SELECT count(*) INTO a FROM (SELECT * FROM t3607_s1 EXCEPT SELECT * FROM pg_temp.snap3607()) x;
  SELECT count(*) INTO b FROM (SELECT * FROM pg_temp.snap3607() EXCEPT SELECT * FROM t3607_s1) x;
  PERFORM pg_temp.check(a = 0 AND b = 0, format('D15 second apply changes nothing: %s / %s', a, b));
END
$d15$;
