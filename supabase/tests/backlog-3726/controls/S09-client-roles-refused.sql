DO $$ DECLARE oka boolean := false; okn boolean := false; okf boolean := false; oks boolean := false;
BEGIN
  PERFORM pg_temp.as_role('authenticated', pg_temp.agent()); SET LOCAL ROLE authenticated;
  BEGIN PERFORM public.submission_sweep_claim(true); EXCEPTION WHEN insufficient_privilege THEN oka := true; END;
  BEGIN PERFORM public.submission_sweep_finish(gen_random_uuid(), '{}', '{}', 'ok'); EXCEPTION WHEN insufficient_privilege THEN okf := true; END;
  BEGIN PERFORM public.submission_sweep_secret(); EXCEPTION WHEN insufficient_privilege THEN oks := true; END;
  RESET ROLE; PERFORM pg_temp.as_role('anon'); SET LOCAL ROLE anon;
  BEGIN PERFORM public.submission_sweep_claim(true); EXCEPTION WHEN insufficient_privilege THEN okn := true; END;
  RESET ROLE;
  PERFORM pg_temp.ok(oka AND okf AND oks, 'S09 authenticated refused on claim, finish and secret');
  PERFORM pg_temp.ok(okn, 'S09 anon refused');
END $$;
