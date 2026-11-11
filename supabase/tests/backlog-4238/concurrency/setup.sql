-- BACKLOG-4238 concurrency fixtures. Needs the migration APPLIED (committed) on the test project.
-- COMMITS: fixture user fx(1), a secret hash, one client, one connection with access token 'at-cc',
-- and an unredeemed code 'c-cc2' for a second connection. teardown.sql removes all of it.
-- Every value is invented (see ../lib/helpers.sql for the digest scheme).
DO $cc$
DECLARE A uuid := ('00000000-0000-4238-8000-' || lpad('1', 12, '0'))::uuid; v_conn uuid; v_conn2 uuid;
BEGIN
  INSERT INTO auth.users (id, email, aud, role, instance_id, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
  VALUES (A, 'p4238-1@example.test', 'authenticated', 'authenticated', '00000000-0000-0000-0000-000000000000', '{"provider":"email"}', '{}', now(), now());
  UPDATE public.mcp_settings SET enabled = true, portal_secret_sha256 = sha256(convert_to('p4238-secret-current', 'UTF8')) WHERE id;
  INSERT INTO public.mcp_oauth_clients (client_id, client_name, redirect_uris, ip_sha256)
  VALUES ('kpr_c_ccxxxxxxxxxxxxxxxxxxxx', 'Fixture app cc', ARRAY['https://claude.ai/api/mcp/auth_callback'], sha256(convert_to('ip-cc', 'UTF8')));
  INSERT INTO public.mcp_connections (user_id, client_id, provider, client_name, redirect_uri, resource, scope, notice_version, status, activated_at)
  VALUES (A, 'kpr_c_ccxxxxxxxxxxxxxxxxxxxx', 'anthropic', 'Fixture app cc', 'https://claude.ai/api/mcp/auth_callback',
          'https://portal.example.test/api/mcp', 'mcp:read', 1, 'active', now()) RETURNING id INTO v_conn;
  INSERT INTO public.mcp_tokens (token_sha256, connection_id, kind, pepper_version, expires_at)
  VALUES (sha256(sha256(convert_to('p4238:at-cc', 'UTF8'))), v_conn, 'access', 1, now() + interval '1 hour');
  INSERT INTO public.mcp_connections (user_id, client_id, provider, client_name, redirect_uri, resource, scope, notice_version, status)
  VALUES (A, 'kpr_c_ccxxxxxxxxxxxxxxxxxxxx', 'anthropic', 'Fixture app cc', 'https://claude.ai/api/mcp/auth_callback',
          'https://portal.example.test/api/mcp', 'mcp:read', 1, 'pending') RETURNING id INTO v_conn2;
  INSERT INTO public.mcp_authorization_codes (code_sha256, connection_id, client_id, redirect_uri, code_challenge, resource, expires_at)
  VALUES (sha256(sha256(convert_to('p4238:c-cc2', 'UTF8'))), v_conn2, 'kpr_c_ccxxxxxxxxxxxxxxxxxxxx', 'https://claude.ai/api/mcp/auth_callback',
          'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM', 'https://portal.example.test/api/mcp', now() + interval '10 minutes');
END
$cc$;
