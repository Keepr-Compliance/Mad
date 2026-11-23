-- c6g_skip B (after the gate): the scrub (live, or the own-name mutant) for the owner, then RAISE.
DO $b$ DECLARE t0 timestamptz := clock_timestamp(); run uuid; r jsonb; BEGIN
  PERFORM set_config('lock_timeout', '8s', true);
  PERFORM set_config('request.jwt.claims', json_build_object('role', 'service_role')::text, true);
  PERFORM set_config('request.jwt.claim.role', 'service_role', true);
  -- the switch on for this transaction only (rolled back by the RAISE); no write when it is already on
  UPDATE public.cloud_release_switches SET one_computer = true WHERE id AND NOT one_computer;
  INSERT INTO public.cloud_blob_erase_runs (mode, counts) VALUES ('live', '{"p4263c": 1}') RETURNING id INTO run;
  r := public.__SCRUB_FN__(run, '__U__', false, 1000);
  RAISE EXCEPTION 'P_B %', jsonb_build_object('t_start', t0, 't_end', clock_timestamp(), 'answer', r);
END $b$;
