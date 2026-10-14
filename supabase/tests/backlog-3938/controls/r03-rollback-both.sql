-- harness: rollback-only
-- R03: both rollbacks, every pinned object equals production (lib/pins-3938.sql is re-run by run.sh).
DO $$ BEGIN
  PERFORM pg_temp.check('r03 functions equal production', pg_temp.fn_now() = pg_temp.fn_prod(), pg_temp.fn_now());
  PERFORM pg_temp.check('r03 links policies equal production', pg_temp.links_now() = pg_temp.links_prod(), pg_temp.links_now());
END $$;
