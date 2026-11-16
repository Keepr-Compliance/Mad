-- BACKLOG-4238 control C8 (single session): a statement timeout that fires inside the read block
-- is returned as {"ok":false,"error":"timeout"} and the call's log row is kept.
-- The timeout is set for the driver statement only (PostgreSQL 13+ applies statement_timeout to
-- each statement of a multi-statement query). Fixtures as in controls.sql (invented).

CREATE FUNCTION pg_temp.run() RETURNS jsonb LANGUAGE plpgsql AS $run$
DECLARE
  r jsonb := '{}'::jsonb; A uuid := pg_temp.fx(1); c jsonb; t text; t0 timestamptz;
BEGIN
  INSERT INTO auth.users (id, email, aud, role, instance_id, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
  VALUES (A, 'p4238-1@example.test', 'authenticated', 'authenticated', '00000000-0000-0000-0000-000000000000', '{"provider":"email"}', '{}', now(), now());
  UPDATE public.mcp_settings SET enabled = true, connect_requires_cloud = false,
         portal_secret_sha256 = sha256(convert_to(pg_temp.sec(), 'UTF8')) WHERE id;
  EXECUTE $s$CREATE TABLE public.cloud_p4238_state (owner uuid PRIMARY KEY, sleep_s int NOT NULL DEFAULT 0)$s$;
  EXECUTE $s$ALTER TABLE public.cloud_p4238_state ENABLE ROW LEVEL SECURITY$s$;
  EXECUTE $s$CREATE POLICY p4238_own ON public.cloud_p4238_state FOR SELECT TO authenticated USING (owner = (SELECT auth.uid()))$s$;
  EXECUTE $s$REVOKE ALL ON public.cloud_p4238_state FROM anon, authenticated$s$;
  EXECUTE $s$GRANT SELECT ON public.cloud_p4238_state TO authenticated$s$;
  EXECUTE $s$CREATE FUNCTION public.get_my_cloud_autosave_state() RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path = '' AS $g$
    DECLARE x int;
    BEGIN
      SELECT sleep_s INTO x FROM public.cloud_p4238_state WHERE owner = auth.uid();
      IF x > 0 THEN PERFORM pg_sleep(x); END IF;
      RETURN jsonb_build_object('schema_version', 1, 'user_id', auth.uid(), 'licensed', true, 'entitled', true, 'path', 'solo',
        'organization_id', NULL, 'reason', NULL, 'settings', jsonb_build_object('enabled', true, 'notice_version', 1, 'accepted_at', NULL),
        'current_notice_version', 1, 'storage', jsonb_build_object('used_bytes', 0, 'quota_bytes', NULL));
    END $g$$s$;
  EXECUTE $s$REVOKE ALL ON FUNCTION public.get_my_cloud_autosave_state() FROM PUBLIC, anon, authenticated, service_role$s$;
  EXECUTE $s$GRANT EXECUTE ON FUNCTION public.get_my_cloud_autosave_state() TO authenticated$s$;
  INSERT INTO public.cloud_p4238_state (owner) VALUES (A);

  c := pg_temp.connect(A, 'c8');
  t := pg_temp.st('at-c8');
  r := r || jsonb_build_object('C8_positive_fast_call', pg_temp.pass(pg_temp.err(t) = 'OK', c::text || ' / ' || t));
  UPDATE public.cloud_p4238_state SET sleep_s = 10 WHERE owner = A;
  t0 := clock_timestamp();
  t := pg_temp.st('at-c8');
  r := r || jsonb_build_object('C8_timeout_in_read_block', pg_temp.pass(
    pg_temp.j(t) = '{"ok": false, "error": "timeout"}'::jsonb
    AND (SELECT outcome FROM public.mcp_call_log WHERE user_id = A AND tool = 'get_status' ORDER BY id DESC LIMIT 1) = 'timeout'
    AND clock_timestamp() - t0 < interval '9 seconds',
    t || ' elapsed=' || (clock_timestamp() - t0)::text
      || ' last_outcome=' || coalesce((SELECT outcome FROM public.mcp_call_log WHERE user_id = A ORDER BY id DESC LIMIT 1), '-')));
  RETURN r;
END
$run$;

SET LOCAL statement_timeout = '4s';

DO $drv4238$
DECLARE v_r jsonb;
BEGIN
  v_r := pg_temp.run();
  RAISE EXCEPTION 'P4238_RESULT %', jsonb_build_object(
    'total', (SELECT count(*) FROM jsonb_each_text(v_r)),
    'pass', (SELECT count(*) FROM jsonb_each_text(v_r) e WHERE e.value = 'PASS'),
    'fail', (SELECT count(*) FROM jsonb_each_text(v_r) e WHERE e.value <> 'PASS'),
    'reds', (SELECT coalesce(jsonb_object_agg(e.key, e.value), '{}'::jsonb) FROM jsonb_each_text(v_r) e WHERE e.value <> 'PASS'));
END
$drv4238$;
