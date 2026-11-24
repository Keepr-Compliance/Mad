-- dryrun-foreign-rows.sql — DRY-RUN DATABASE ONLY. Never sent to the hosted test database or to production.
-- BACKLOG-4265: rows that do NOT belong to the harness's fixtures, so that a dry run sees tables that are not empty.
-- Every dry run of the 4265 harness puts this file in front of the harness text, in the SAME call, which then ends in
-- the harness's RAISE: nothing here persists.
-- The harness hashes every row that exists before its fixtures (pg_temp.t65_pre, lib/helpers.sql) and checks before its
-- RAISE that each one is still there, unchanged ('foreign_rows' in the result).
-- What this inserts (all values invented; addresses @example.test; ids start 00000000-):
--   one user F (auth.users) with Keepr Cloud settings, one deal, one message and one blob row;
--   one app registration (mcp_oauth_clients) and F's active connection with an access token; one mcp_call_log row of F.
-- Sent ALONE it COMMITS its rows (it has no RAISE of its own): only ever send it composed in front of a harness file.
-- Guard: refuses unless the dry-run database's marker row is present and the hosted test database's marker row is not.
DO $guard4265fr$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM auth.users u WHERE md5(u.id::text) = 'bbde4ef0aae0710f8ce0c22454224882')
     OR EXISTS (SELECT 1 FROM auth.users u WHERE md5(u.id::text) = '53a385187695375e2e8695625a20a77a') THEN
    RAISE EXCEPTION 'dryrun-foreign-rows.sql refuses to run: DRY-RUN DATABASE ONLY';
  END IF;
END
$guard4265fr$;
DO $foreign4265$
DECLARE v_f uuid := ('00000000-0000-4000-8000-0000426590' || '01')::uuid; v_d uuid := ('00000000-0000-4000-8000-0000426590' || '02')::uuid;
        v_b uuid := ('00000000-0000-4000-8000-0000426590' || '03')::uuid; v_k uuid := ('00000000-0000-4000-8000-0000426590' || '04')::uuid;
        v_i uuid := ('00000000-0000-4000-8000-0000426590' || '05')::uuid; v_c text := 'kpr_c_' || substr(md5('h4265-foreign-client'), 1, 22);
BEGIN
  SET LOCAL session_replication_role = replica;
  INSERT INTO auth.users (id, email, aud, role, instance_id, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
  VALUES (v_f, 'h4265-foreign@example.test', 'authenticated', 'authenticated', '00000000-0000-0000-0000-000000000000',
          '{"provider":"email"}', '{}', now() - interval '3 days', now() - interval '3 days');
  SET LOCAL session_replication_role = origin;
  INSERT INTO public.cloud_autosave_settings (user_id, enabled, notice_version, accepted_at, enabled_at)
  VALUES (v_f, true, 1, now() - interval '3 days', now() - interval '3 days');
  INSERT INTO public.cloud_deals (id, owner_user_id, source_install_id, local_transaction_id, content_hash)
  VALUES (v_d, v_f, v_i, 'h4265-foreign-deal', encode(sha256(convert_to('h4265-foreign-deal', 'UTF8')), 'hex'));
  INSERT INTO public.cloud_deal_messages (owner_user_id, cloud_deal_id, channel_kind, local_message_id, subject, body_text, thread_key, content_hash)
  VALUES (v_f, v_d, 'email', 'h4265-foreign-message', 'Foreign subject', 'Foreign body', 'h4265-thread',
          encode(sha256(convert_to('h4265-foreign-message', 'UTF8')), 'hex'));
  INSERT INTO public.cloud_blobs (id, owner_user_id, sha256, size_bytes, storage_path)
  VALUES (v_b, v_f, encode(sha256(convert_to('h4265-foreign-blob', 'UTF8')), 'hex'), 10, v_f::text || '/' || v_b::text);
  INSERT INTO public.mcp_oauth_clients (client_id, client_name, redirect_uris, ip_sha256, created_at)
  VALUES (v_c, 'Foreign app', ARRAY['https://claude.ai/api/mcp/auth_callback'], sha256(convert_to('h4265-foreign-ip', 'UTF8')), now() - interval '3 days');
  INSERT INTO public.mcp_connections (id, user_id, client_id, provider, client_name, redirect_uri, resource, scope, notice_version, status,
                                      consented_at, activated_at)
  VALUES (v_k, v_f, v_c, 'anthropic', 'Foreign app', 'https://claude.ai/api/mcp/auth_callback', 'https://h65-foreign.example.test/api/mcp',
          'mcp:read', 1, 'active', now() - interval '2 days', now() - interval '2 days');
  INSERT INTO public.mcp_tokens (token_sha256, connection_id, kind, pepper_version, issued_at, expires_at)
  VALUES (sha256(convert_to('h4265-foreign-at', 'UTF8')), v_k, 'access', 1, now() - interval '10 minutes', now() + interval '50 minutes');
  INSERT INTO public.mcp_call_log (user_id, connection_id, provider, event, outcome, started_at, ended_at)
  VALUES (v_f, v_k, 'anthropic', 'call', 'ok', now() - interval '1 hour', now() - interval '1 hour');
END
$foreign4265$;
