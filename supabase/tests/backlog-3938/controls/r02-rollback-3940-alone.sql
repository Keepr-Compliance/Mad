-- harness: rollback-only
-- R02 (SR R7): rollback-3940.sql run alone, with the 3938 file still applied.
DO $$ BEGIN
  PERFORM pg_temp.check('r02 fixed links fingerprint differed from production', current_setting('t3938.links_fixed') <> pg_temp.links_prod(), current_setting('t3938.links_fixed'));
  PERFORM pg_temp.check('r02 links policies equal production', pg_temp.links_now() = pg_temp.links_prod(), pg_temp.links_now());
  PERFORM pg_temp.check('r02 3938 half intact (function md5 + ACL unchanged)', pg_temp.fn_now() = current_setting('t3938.fn_fixed'), pg_temp.fn_now());
  PERFORM pg_temp.check('r02 3938 half is not production', pg_temp.fn_now() <> pg_temp.fn_prod(), pg_temp.fn_now());
END $$;
