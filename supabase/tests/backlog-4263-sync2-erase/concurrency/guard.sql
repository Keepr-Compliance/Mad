-- guard.sql: a byte copy of ../../backlog-4263-sync2-s1/concurrency/guard.sql below this line (offline_check.py compares them);
-- run.sh puts it first in every file it sends.
DO $guard4263s1cc$
DECLARE n bigint := 0;
BEGIN
  IF pg_catalog.to_regclass('public.pm_backlog_items') IS NOT NULL THEN
    EXECUTE 'SELECT count(*) FROM public.pm_backlog_items' INTO n;
  END IF;
  IF n > 100 OR coalesce((SELECT s.n_live_tup FROM pg_catalog.pg_stat_user_tables s WHERE s.relid = pg_catalog.to_regclass('public.pm_backlog_items')), 0) > 100 THEN
    RAISE EXCEPTION 'refuses to run: TEST DATABASE ONLY (production tracker rows present)';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM auth.users u WHERE md5(u.id::text) = '53a385187695375e2e8695625a20a77a') THEN
    RAISE EXCEPTION 'refuses to run: TEST DATABASE ONLY (test database marker absent)';
  END IF;
END
$guard4263s1cc$;
