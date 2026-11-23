/*p_hold:__RUN__*/
-- session A: the hold marker above is FIRST in the call (pg_stat_activity.query keeps the first 1 kB only).
-- c6g_wait A: the own-name scrub copy with a 4 s sleep right after its settings lock (or, mutant, before it), RAISE.
DO $a$ DECLARE t0 timestamptz; run uuid; r jsonb; BEGIN
  PERFORM set_config('lock_timeout', '3s', true);
  PERFORM set_config('request.jwt.claims', json_build_object('role', 'service_role')::text, true);
  PERFORM set_config('request.jwt.claim.role', 'service_role', true);
  -- the switch on for this transaction only (rolled back by the RAISE); no write when it is already on
  UPDATE public.cloud_release_switches SET one_computer = true WHERE id AND NOT one_computer;
  INSERT INTO public.cloud_blob_erase_runs (mode, counts) VALUES ('live', '{"p4263c": 1}') RETURNING id INTO run;
  t0 := clock_timestamp();
  r := public.__SCRUB_FN__(run, '__U__', false, 1000);
  RAISE EXCEPTION 'P_A %', jsonb_build_object('t_start', t0, 't_end', clock_timestamp(), 'answer', r);
END $a$;
