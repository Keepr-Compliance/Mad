-- harness: apply-twice
-- C14: the file is safe to apply twice. run.sh snapshots the catalog after
-- the first apply (t3477_s1), applies the file again, and this control
-- compares: every column, constraint, index, policy, function (body, security,
-- search_path, grants) and trigger is identical both ways.
DO $c14$
DECLARE
  n1 bigint; a bigint; b bigint;
BEGIN
  SELECT count(*) INTO n1 FROM t3477_s1;
  SELECT count(*) INTO a FROM (SELECT * FROM t3477_s1 EXCEPT SELECT * FROM pg_temp.snap3477()) d;
  SELECT count(*) INTO b FROM (SELECT * FROM pg_temp.snap3477() EXCEPT SELECT * FROM t3477_s1) d;
  PERFORM pg_temp.check(n1 > 40, 'C14 snapshot has rows: ' || n1);
  PERFORM pg_temp.check(a = 0 AND b = 0, format('C14 second apply changed nothing: only-first %s, only-second %s', a, b));
END
$c14$;
