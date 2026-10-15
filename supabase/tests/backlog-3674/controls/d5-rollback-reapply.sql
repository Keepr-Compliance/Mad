-- harness: rollback
-- harness: reapply
-- rollback-3674.sql drops the column (and its grant); the migration then applies again.
DO $$ DECLARE m text; BEGIN
  PERFORM pg_temp.check('d5 after rollback + reapply: column present', pg_temp.has_col());
  PERFORM pg_temp.check('d5 after rollback + reapply: authenticated UPDATE = 17',
    pg_temp.priv_count('authenticated', 'UPDATE') = 17, pg_temp.priv_count('authenticated', 'UPDATE')::text);
  m := pg_temp.as_user(pg_temp.id('u_a'), pg_temp.app_dismiss('u_a', '2026-01-01T00:00:00Z'));
  PERFORM pg_temp.check('d5 after rollback + reapply: own-row write works', m = 'OK rows=1', m);
END $$;
