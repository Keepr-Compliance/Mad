-- attach B (after the gate): the claim (live, or the own-name mutant) ends in RAISE; its orphan arm locks X through
-- _cloud_fence_unreferenced and must wait for A.
DO $b$ DECLARE t0 timestamptz := clock_timestamp(); r jsonb; BEGIN
  PERFORM set_config('lock_timeout', '8s', true);
  PERFORM set_config('request.jwt.claims', json_build_object('role', 'service_role')::text, true);
  PERFORM set_config('request.jwt.claim.role', 'service_role', true);
  r := public.__CLAIM_FN__(false, 1000, 20000);
  RAISE EXCEPTION 'P_B %', jsonb_build_object('t_start', t0, 't_end', clock_timestamp(),
    'fenced', (SELECT purge_requested_at IS NOT NULL FROM public.cloud_blobs WHERE id = '__X__'));
END $b$;
