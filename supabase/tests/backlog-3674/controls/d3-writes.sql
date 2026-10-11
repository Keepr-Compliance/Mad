-- The app's write as a signed-in user: own row 1 row; second write 0 rows and
-- the first value kept (is-null guard); another user's row 0 rows; anon refused.
DO $$ DECLARE m text; v text; BEGIN
  m := pg_temp.as_user(pg_temp.id('u_a'), pg_temp.app_dismiss('u_a', '2026-01-01T00:00:00Z'), true);
  PERFORM pg_temp.check('d3 own row: first write updates 1 row', m = 'OK rows=1', m);
  SELECT tour_dismissed_at::text INTO v FROM public.users WHERE id = pg_temp.id('u_a');
  PERFORM pg_temp.check('d3 own row: value set', v IS NOT NULL, v);

  m := pg_temp.as_user(pg_temp.id('u_a'), pg_temp.app_dismiss('u_a', '2026-02-02T00:00:00Z'), true);
  PERFORM pg_temp.check('d3 own row: second write updates 0 rows', m = 'OK rows=0', m);
  PERFORM pg_temp.check('d3 own row: first value kept',
    (SELECT tour_dismissed_at FROM public.users WHERE id = pg_temp.id('u_a')) = '2026-01-01T00:00:00Z'::timestamptz,
    (SELECT tour_dismissed_at::text FROM public.users WHERE id = pg_temp.id('u_a')));

  m := pg_temp.as_user(pg_temp.id('u_a'), pg_temp.app_dismiss('u_b', '2026-01-01T00:00:00Z'), true);
  PERFORM pg_temp.check('d3 another user''s row: 0 rows', m = 'OK rows=0', m);
  PERFORM pg_temp.check('d3 another user''s row: still null',
    (SELECT tour_dismissed_at FROM public.users WHERE id = pg_temp.id('u_b')) IS NULL);

  m := pg_temp.as_anon($q$update public.users set tour_dismissed_at = now() where id = '{u_b}'$q$);
  PERFORM pg_temp.check('d3 anon: permission denied (42501)', m LIKE 'ERR 42501 %', m);
END $$;
