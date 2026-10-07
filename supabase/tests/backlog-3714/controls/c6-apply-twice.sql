-- harness: apply-twice
-- A second apply raises nothing and leaves the same privilege set as one apply.
DO $$ BEGIN
  PERFORM pg_temp.check('c6 apply twice: authenticated UPDATE columns = the 16',
    pg_temp.priv_cols('authenticated', 'UPDATE') = pg_temp.sorted(pg_temp.keep_cols()),
    pg_temp.priv_cols('authenticated', 'UPDATE')::text);
  PERFORM pg_temp.check('c6 apply twice: anon UPDATE columns = none',
    pg_temp.priv_cols('anon', 'UPDATE') = '{}', pg_temp.priv_cols('anon', 'UPDATE')::text);
  PERFORM pg_temp.check('c6 apply twice: attacl set on exactly the 16',
    pg_temp.attacl_cols() = pg_temp.sorted(pg_temp.keep_cols()), pg_temp.attacl_cols()::text);
END $$;
