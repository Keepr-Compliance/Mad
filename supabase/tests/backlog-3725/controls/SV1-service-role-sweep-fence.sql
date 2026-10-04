-- SV1: the service role (a server sweep) can set abandoned_at on an uploading row; so can a SECURITY DEFINER function owned by postgres
SELECT set_config('request.jwt.claims', '{"role": "service_role"}', true);
SET LOCAL ROLE service_role;
WITH u AS (UPDATE public.transaction_submissions SET abandoned_at = now()
           WHERE id = :'S' AND status = 'uploading' AND abandoned_at IS NULL RETURNING 1) SELECT pg_temp.ok(count(*) = 1, 'SV1 service_role fence 1 row') FROM u;
RESET ROLE;
CREATE FUNCTION pg_temp.sweep_fence(p uuid) RETURNS int LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE n int;
BEGIN
  UPDATE public.transaction_submissions SET abandoned_at = now() WHERE id = p AND status = 'uploading' AND abandoned_at IS NULL;
  GET DIAGNOSTICS n = ROW_COUNT; RETURN n;
END $$;
SELECT pg_temp.claims(:'A'); SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims', '{"role": "service_role"}', true);
SELECT pg_temp.ok(pg_temp.sweep_fence(:'S2') = 1, 'SV1 definer fence 1 row');
