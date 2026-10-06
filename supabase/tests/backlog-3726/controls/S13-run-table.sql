-- service_role reads the run table but cannot write it; rows older than 30 days are purged.
DO $$ DECLARE okw boolean := false; okc boolean := false; old uuid; r jsonb;
BEGIN
  INSERT INTO submission_sweep_runs (started_at, mode) VALUES (now() - interval '31 days', 'live') RETURNING id INTO old;
  PERFORM pg_temp.as_role('service_role'); SET LOCAL ROLE service_role;
  BEGIN INSERT INTO public.submission_sweep_runs (mode) VALUES ('live'); EXCEPTION WHEN insufficient_privilege THEN okw := true; END;
  PERFORM count(*) FROM public.submission_sweep_runs;
  RESET ROLE;
  PERFORM pg_temp.as_role('authenticated', pg_temp.agent()); SET LOCAL ROLE authenticated;
  BEGIN PERFORM count(*) FROM public.submission_sweep_runs; EXCEPTION WHEN insufficient_privilege THEN okc := true; END;
  RESET ROLE;
  r := pg_temp.claim(true);
  PERFORM pg_temp.ok(okw, 'S13 service_role cannot insert run rows');
  PERFORM pg_temp.ok(okc, 'S13 authenticated cannot read run rows');
  PERFORM pg_temp.ok(NOT EXISTS (SELECT 1 FROM submission_sweep_runs WHERE id = old), 'S13 31-day-old run row purged');
END $$;
