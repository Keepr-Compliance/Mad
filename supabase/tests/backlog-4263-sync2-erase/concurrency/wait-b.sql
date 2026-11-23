-- c6g_wait B (after the gate): moves the active computer (what the claim writes), RAISE.
DO $b$ DECLARE t0 timestamptz := clock_timestamp(); BEGIN
  PERFORM set_config('lock_timeout', '8s', true);
  UPDATE public.cloud_autosave_settings SET active_install_id = '__I2__', active_since = now() WHERE user_id = '__U__';
  RAISE EXCEPTION 'P_B %', jsonb_build_object('t_start', t0, 't_end', clock_timestamp());
END $b$;
