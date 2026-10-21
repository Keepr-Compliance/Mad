-- C-race mutant (keepr-test, committed for the duration of one race run; restore.sql puts the body back).
DO $m$
DECLARE d text := pg_get_functiondef('public._guard_last_admin()'::regprocedure);
        f text := '  PERFORM 1 FROM public.organizations o WHERE o.id = OLD.organization_id FOR UPDATE;';
        n int;
BEGIN
  n := (length(d) - length(replace(d, f, ''))) / length(f);
  IF n <> 1 THEN RAISE EXCEPTION 'MUTATION NOT APPLIED: % matches', n; END IF;
  EXECUTE replace(d, f, '  -- lock removed (mutant)');
  RAISE NOTICE 'MUTATION APPLIED % -> %', left(md5(d), 8), left(md5(pg_get_functiondef('public._guard_last_admin()'::regprocedure)), 8);
END $m$;
SELECT 'MUTATION APPLIED' AS s, left(md5(pg_get_functiondef('public._guard_last_admin()'::regprocedure)), 8) AS md5,
       position('lock removed (mutant)' in pg_get_functiondef('public._guard_last_admin()'::regprocedure)) > 0 AS mutated;
