-- dryrun-foreign-rows.sql — DRY-RUN DATABASE ONLY. Never sent to the hosted test database or to production.
-- BACKLOG-4266: stand-in rows that do NOT belong to the harness's fixture, so that a dry run sees a table that is not
-- empty, as the hosted test database's is. Every dry run of the 4266 harness puts this file in front of the harness
-- text, in the SAME call, which then ends in the harness's RAISE: nothing here persists.
-- The harness snapshots every row that exists before its fixtures (pg_temp.t66_pre, lib/helpers.sql) and checks before
-- its RAISE that each one is still there, unchanged ('foreign_rows' in the result).
-- What this inserts (all values invented; addresses @example.test; ids start 00000000-):
--   one user F (auth.users), one app registration (mcp_oauth_clients);
--   F's ACTIVE connection to the same redirect address the fixture uses for anthropic, with an access and a refresh
--     token; F's PENDING openai connection with one USED and one UNUSED authorization code;
--   one PENDING authorization request that expires in one hour;
--   three ai_app_connect_notices rows of F: due, sent and failed;
--   three mcp_call_log rows of F.
-- Guard: refuses unless the dry-run database's marker row is present and the hosted test database's marker row is not.
DO $guard4266fr$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM auth.users u WHERE md5(u.id::text) = 'bbde4ef0aae0710f8ce0c22454224882')
     OR EXISTS (SELECT 1 FROM auth.users u WHERE md5(u.id::text) = '53a385187695375e2e8695625a20a77a') THEN
    RAISE EXCEPTION 'dryrun-foreign-rows.sql refuses to run: DRY-RUN DATABASE ONLY';
  END IF;
END
$guard4266fr$;
DO $foreign4266$
-- invented ids, built as the fixture builds its own (00000000-0000-4000-8000-0000426690nn)
DECLARE v_f uuid := ('00000000-0000-4000-8000-0000426690' || '01')::uuid; v_c text := 'kpr_c_' || substr(md5('h4266-foreign-client'), 1, 22);
        v_a uuid := ('00000000-0000-4000-8000-0000426691' || '01')::uuid; v_p uuid := ('00000000-0000-4000-8000-0000426691' || '02')::uuid;
BEGIN
  SET LOCAL session_replication_role = replica;
  INSERT INTO auth.users (id, email, aud, role, instance_id, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
  VALUES (v_f, 'h4266-foreign@example.test', 'authenticated', 'authenticated', '00000000-0000-0000-0000-000000000000',
          '{"provider":"email"}', '{}', now() - interval '3 days', now() - interval '3 days');
  SET LOCAL session_replication_role = origin;
  INSERT INTO public.mcp_oauth_clients (client_id, client_name, redirect_uris, ip_sha256, created_at)
  VALUES (v_c, 'Foreign app', ARRAY['https://claude.ai/api/mcp/auth_callback', 'https://chatgpt.com/connector_platform_oauth_redirect'],
          sha256(convert_to('h4266-foreign-ip', 'UTF8')), now() - interval '3 days');
  INSERT INTO public.mcp_connections (id, user_id, client_id, provider, client_name, redirect_uri, resource, scope, notice_version, status,
                                      consented_at, activated_at)
  VALUES (v_a, v_f, v_c, 'anthropic', 'Foreign app', 'https://claude.ai/api/mcp/auth_callback', 'https://h66-fixture.example.test/api/mcp',
          'mcp:read', 1, 'active', now() - interval '2 days', now() - interval '2 days'),
         (v_p, v_f, v_c, 'openai', 'Foreign app', 'https://chatgpt.com/connector_platform_oauth_redirect', 'https://h66-fixture.example.test/api/mcp',
          'mcp:read', 1, 'pending', now() - interval '1 minute', NULL);
  INSERT INTO public.mcp_tokens (token_sha256, connection_id, kind, pepper_version, issued_at, expires_at)
  VALUES (sha256(convert_to('h4266-foreign-at', 'UTF8')), v_a, 'access', 1, now() - interval '10 minutes', now() + interval '50 minutes'),
         (sha256(convert_to('h4266-foreign-rt', 'UTF8')), v_a, 'refresh', 1, now() - interval '10 minutes', now() + interval '29 days');
  INSERT INTO public.mcp_authorization_codes (code_sha256, connection_id, client_id, redirect_uri, code_challenge, resource, created_at, expires_at, used_at)
  VALUES (sha256(convert_to('h4266-foreign-code-used', 'UTF8')), v_p, v_c, 'https://chatgpt.com/connector_platform_oauth_redirect',
          public._mcp_b64url(sha256(convert_to('h4266-foreign-verifier-1', 'UTF8'))), 'https://h66-fixture.example.test/api/mcp',
          now() - interval '1 minute', now() + interval '1 minute', now() - interval '30 seconds'),
         (sha256(convert_to('h4266-foreign-code-unused', 'UTF8')), v_p, v_c, 'https://chatgpt.com/connector_platform_oauth_redirect',
          public._mcp_b64url(sha256(convert_to('h4266-foreign-verifier-2', 'UTF8'))), 'https://h66-fixture.example.test/api/mcp',
          now(), now() + interval '1 minute', NULL);
  INSERT INTO public.mcp_authorization_requests (id, client_id, redirect_uri, code_challenge, resource, scope, browser_binding_sha256, expires_at)
  VALUES (substr(replace(replace(encode(sha256(convert_to('h4266-foreign-request', 'UTF8')), 'base64'), '+', '-'), '/', '_'), 1, 22), v_c,
          'https://claude.ai/api/mcp/auth_callback', public._mcp_b64url(sha256(convert_to('h4266-foreign-verifier-3', 'UTF8'))),
          'https://h66-fixture.example.test/api/mcp', 'mcp:read', sha256(convert_to('h4266-foreign-bind', 'UTF8')), now() + interval '1 hour');
  INSERT INTO public.ai_app_connect_notices (user_id, provider, replaced, connected_at, status, attempts, sent_at, last_error)
  VALUES (v_f, 'anthropic', false, now() - interval '2 days', 'sent', 1, now() - interval '2 days', NULL),
         (v_f, 'anthropic', true, now() - interval '1 day', 'failed', 5, NULL, 'send_failed'),
         (v_f, 'openai', false, now() - interval '1 hour', 'due', 0, NULL, NULL);
  INSERT INTO public.mcp_call_log (user_id, connection_id, provider, event, outcome, started_at, ended_at)
  VALUES (v_f, v_a, 'anthropic', 'call', 'ok', now() - interval '1 hour', now() - interval '1 hour'),
         (v_f, v_a, 'anthropic', 'reconnect_replaced', 'ok', now() - interval '2 days', now() - interval '2 days'),
         (v_f, NULL, NULL, 'disconnect_all', 'ok', now() - interval '3 days', now() - interval '3 days');
END
$foreign4266$;
