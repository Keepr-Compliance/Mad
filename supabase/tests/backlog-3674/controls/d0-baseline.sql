-- harness: baseline
-- Before 3674 (3673 + 3714 layered, as production is): no column, and the
-- privilege state 3714 left: authenticated UPDATE on 16 columns, anon none.
DO $$ BEGIN
  PERFORM pg_temp.check('d0 baseline: column absent', NOT pg_temp.has_col());
  PERFORM pg_temp.check('d0 baseline: authenticated UPDATE = 16 columns',
    pg_temp.priv_count('authenticated', 'UPDATE') = 16, pg_temp.priv_count('authenticated', 'UPDATE')::text);
  PERFORM pg_temp.check('d0 baseline: anon UPDATE = 0 columns',
    pg_temp.priv_count('anon', 'UPDATE') = 0, pg_temp.priv_count('anon', 'UPDATE')::text);
END $$;
