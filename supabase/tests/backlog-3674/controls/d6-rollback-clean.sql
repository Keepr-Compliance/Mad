-- harness: rollback
-- rollback-3674.sql returns the table to 3714's state: no column, authenticated UPDATE 16.
DO $$ BEGIN
  PERFORM pg_temp.check('d6 after rollback: column absent', NOT pg_temp.has_col());
  PERFORM pg_temp.check('d6 after rollback: authenticated UPDATE = 16',
    pg_temp.priv_count('authenticated', 'UPDATE') = 16, pg_temp.priv_count('authenticated', 'UPDATE')::text);
END $$;
