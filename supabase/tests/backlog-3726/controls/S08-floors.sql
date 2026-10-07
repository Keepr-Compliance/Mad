-- Allowed range: stall >= 2 h (founder), grace >= 15 min, orphan age >= 3 d.
DO $$ DECLARE ok1 boolean := false; ok2 boolean := false; ok3 boolean := false; r jsonb;
BEGIN
  PERFORM pg_temp.as_role('service_role'); SET LOCAL ROLE service_role;
  BEGIN PERFORM public.submission_sweep_claim(true, interval '1 hour 59 minutes'); EXCEPTION WHEN sqlstate '22023' THEN ok1 := true; END;
  BEGIN PERFORM public.submission_sweep_claim(true, interval '2 hours', interval '1 hour', interval '1 day'); EXCEPTION WHEN sqlstate '22023' THEN ok2 := true; END;
  BEGIN PERFORM public.submission_sweep_claim(NULL); EXCEPTION WHEN sqlstate '22023' THEN ok3 := true; END;
  r := public.submission_sweep_claim(true, interval '2 hours');
  RESET ROLE;
  PERFORM pg_temp.ok(ok1, 'S08 stall of 1h59m refused');
  PERFORM pg_temp.ok(ok2, 'S08 orphan age of 1 day refused');
  PERFORM pg_temp.ok(ok3, 'S08 NULL dry_run refused');
  PERFORM pg_temp.ok(r ? 'run_id', 'S08 stall of exactly 2 h accepted');
END $$;
