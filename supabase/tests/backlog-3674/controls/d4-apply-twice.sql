-- harness: apply-twice
-- A second apply is a no-op: no error, one column, authenticated UPDATE still 17.
DO $$ BEGIN
  PERFORM pg_temp.check('d4 after two applies: column present', pg_temp.has_col());
  PERFORM pg_temp.check('d4 after two applies: authenticated UPDATE = 17',
    pg_temp.priv_count('authenticated', 'UPDATE') = 17, pg_temp.priv_count('authenticated', 'UPDATE')::text);
END $$;
