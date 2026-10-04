-- With EXECUTE (role service_role) but claims saying authenticated, the body guard refuses.
DO $$ DECLARE ok1 boolean := false; ok2 boolean := false; ok3 boolean := false;
BEGIN
  PERFORM pg_temp.as_role('authenticated', pg_temp.agent()); SET LOCAL ROLE service_role;
  BEGIN PERFORM public.submission_sweep_claim(true); EXCEPTION WHEN insufficient_privilege THEN ok1 := true; END;
  BEGIN PERFORM public.submission_sweep_finish(gen_random_uuid(), '{}', '{}', 'ok'); EXCEPTION WHEN insufficient_privilege THEN ok2 := true; END;
  BEGIN PERFORM public.submission_sweep_secret(); EXCEPTION WHEN insufficient_privilege THEN ok3 := true; END;
  RESET ROLE;
  PERFORM pg_temp.ok(ok1, 'S09b claim body guard'); PERFORM pg_temp.ok(ok2, 'S09b finish body guard'); PERFORM pg_temp.ok(ok3, 'S09b secret body guard');
END $$;
