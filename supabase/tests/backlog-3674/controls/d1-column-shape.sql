-- The column exists as nullable timestamptz with no default; pre-existing rows stay null (no backfill).
DO $$ DECLARE r record; BEGIN
  SELECT data_type, is_nullable, column_default INTO r FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'users' AND column_name = 'tour_dismissed_at';
  PERFORM pg_temp.check('d1 column exists', FOUND);
  PERFORM pg_temp.check('d1 type timestamptz', r.data_type = 'timestamp with time zone', r.data_type);
  PERFORM pg_temp.check('d1 nullable, no default', r.is_nullable = 'YES' AND r.column_default IS NULL,
    r.is_nullable || ' / ' || coalesce(r.column_default, '<none>'));
  PERFORM pg_temp.check('d1 fixture rows are null (no backfill)',
    (SELECT count(*) FROM public.users WHERE id IN (pg_temp.id('u_a'), pg_temp.id('u_b')) AND tour_dismissed_at IS NULL) = 2);
  PERFORM pg_temp.check('d1 column comment set',
    col_description('public.users'::regclass,
      (SELECT attnum FROM pg_attribute WHERE attrelid = 'public.users'::regclass AND attname = 'tour_dismissed_at')) LIKE 'BACKLOG-3674:%');
END $$;
