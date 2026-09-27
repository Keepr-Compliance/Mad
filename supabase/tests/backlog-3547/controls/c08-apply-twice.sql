-- harness: apply-twice
-- C08: applying the migration a second time leaves the policy set unchanged.
DO $c08$
DECLARE
  diff int;
BEGIN
  SELECT count(*) INTO diff FROM (
    (SELECT policyname, cmd, roles::text, coalesce(qual,''), coalesce(with_check,'') FROM pg_policies
      WHERE schemaname = 'public' AND tablename = 'transaction_submissions'
     EXCEPT SELECT * FROM t3547_s1)
    UNION ALL
    (SELECT * FROM t3547_s1
     EXCEPT SELECT policyname, cmd, roles::text, coalesce(qual,''), coalesce(with_check,'') FROM pg_policies
      WHERE schemaname = 'public' AND tablename = 'transaction_submissions')) d;
  PERFORM pg_temp.check(diff = 0, format('C08 policy rows differ after a second apply: %s', diff));
  PERFORM pg_temp.check((SELECT count(*) FROM t3547_s1) > 0, 'C08 snapshot not empty');
END
$c08$;
