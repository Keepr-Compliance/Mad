/*p_hold:__RUN__*/
-- The holding statement (the DO below) starts with the marker: a transport that submits statement by statement
-- shows only the current statement in pg_stat_activity.query. hold-marker.sql, first in the call, serves one that
-- submits the whole call as one text (the activity view keeps its first 1 kB).
-- c6g_skip A: takes the owner's settings row FOR UPDATE (what cloud_claim_install does), holds 4 s, RAISE.
DO $a$ DECLARE t0 timestamptz := clock_timestamp(); th timestamptz; BEGIN
  PERFORM set_config('lock_timeout', '3s', true);
  PERFORM 1 FROM public.cloud_autosave_settings WHERE user_id = '__U__' FOR UPDATE;
  th := clock_timestamp();
  PERFORM pg_sleep(4);
  RAISE EXCEPTION 'P_A %', jsonb_build_object('t_start', t0, 't_hold', th, 't_end', clock_timestamp());
END $a$;
