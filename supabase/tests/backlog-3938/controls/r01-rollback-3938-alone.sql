-- harness: rollback-only
-- R01 (SR R7): rollback-3938.sql run alone, with the 3940 file still applied.
DO $$ BEGIN
  PERFORM pg_temp.check('r01 fixed 3938 fingerprint differed from production', current_setting('t3938.fn_fixed') <> pg_temp.fn_prod(), current_setting('t3938.fn_fixed'));
  PERFORM pg_temp.check('r01 three functions: md5 + ACL equal production', pg_temp.fn_now() = pg_temp.fn_prod(), pg_temp.fn_now());
  PERFORM pg_temp.check('r01 3940 half intact (links policy unchanged)', pg_temp.links_now() = current_setting('t3938.links_fixed'), pg_temp.links_now());
  PERFORM pg_temp.check('r01 links policy is the 3940 one', pg_temp.links_now() LIKE 'support_ticket_backlog_links_internal_all|ALL|{authenticated}|%', pg_temp.links_now());
END $$;
