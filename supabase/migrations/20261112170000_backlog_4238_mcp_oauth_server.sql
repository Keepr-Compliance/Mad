-- BACKLOG-4238 PR-1: OAuth server tables and functions for the hosted read-only MCP endpoint.
--
-- Objects:
--   role      mcp_reader (NOLOGIN, member of authenticated): owns the _mcp_r_* reader functions
--   tables    mcp_settings, mcp_redirect_allowlist, mcp_oauth_clients, mcp_authorization_requests,
--             mcp_connections, mcp_authorization_codes, mcp_tokens, mcp_rate_counters, mcp_call_log
--             (row level security on, no policies, no client privileges)
--   type      mcp_gate
--   anon      mcp_register_client, mcp_authorize_begin, mcp_exchange_code, mcp_refresh,
--             mcp_check_access, mcp_get_status (each takes the portal secret)
--   signed in mcp_authorize_view, mcp_authorize_approve, mcp_authorize_deny,
--             mcp_list_my_connections, mcp_disconnect, mcp_disconnect_all_mine
--   internal  _mcp_secret_ok, _mcp_refuse, _mcp_b64url, _mcp_window, _mcp_bump, _mcp_token_fail,
--             _mcp_impersonating, _mcp_reader_ok, _mcp_enter, _mcp_finish, _mcp_disconnect_all_for,
--             _mcp_entitlement_now
--   reader    _mcp_r_entitlement (owner mcp_reader, STABLE)
--
-- Digests: the portal sends d = HMAC-SHA256(pepper, token) (32 bytes); the tables store sha256(d).
-- Every function returns jsonb; a refusal is {"ok": false, "error": <code>}.
-- Rollback: supabase/tests/backlog-4238/rollback-4238.sql

-- ---------------------------------------------------------------------------
-- Role
-- ---------------------------------------------------------------------------
DO $role$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'mcp_reader') THEN
    CREATE ROLE mcp_reader NOLOGIN;
  END IF;
END
$role$;
ALTER ROLE mcp_reader NOLOGIN NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION INHERIT;
GRANT authenticated TO mcp_reader;
GRANT mcp_reader TO postgres WITH INHERIT FALSE, SET TRUE;

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.mcp_settings (
  id                        boolean PRIMARY KEY DEFAULT true CHECK (id),
  enabled                   boolean NOT NULL DEFAULT false,
  connect_requires_cloud    boolean NOT NULL DEFAULT true,
  portal_secret_sha256      bytea NULL CHECK (portal_secret_sha256 IS NULL OR octet_length(portal_secret_sha256) = 32),
  portal_secret_prev_sha256 bytea NULL CHECK (portal_secret_prev_sha256 IS NULL OR octet_length(portal_secret_prev_sha256) = 32),
  pepper_version            smallint NOT NULL DEFAULT 1 CHECK (pepper_version > 0),
  notice_version            smallint NOT NULL DEFAULT 1 CHECK (notice_version > 0),
  updated_at                timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.mcp_settings ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.mcp_settings FROM PUBLIC, anon, authenticated;
INSERT INTO public.mcp_settings (id) VALUES (true) ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS public.mcp_redirect_allowlist (
  redirect_uri text PRIMARY KEY CHECK (redirect_uri ~ '^https://[A-Za-z0-9.-]+/[^?#[:space:]]*$'),
  provider     text NOT NULL CHECK (provider IN ('anthropic', 'openai')),
  created_at   timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.mcp_redirect_allowlist ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.mcp_redirect_allowlist FROM PUBLIC, anon, authenticated;
INSERT INTO public.mcp_redirect_allowlist (redirect_uri, provider) VALUES
  ('https://claude.ai/api/mcp/auth_callback', 'anthropic'),
  ('https://chatgpt.com/connector_platform_oauth_redirect', 'openai')
ON CONFLICT (redirect_uri) DO NOTHING;

CREATE TABLE IF NOT EXISTS public.mcp_oauth_clients (
  client_id     text PRIMARY KEY CHECK (client_id ~ '^kpr_c_[A-Za-z0-9_-]{22}$'),
  client_name   text NOT NULL CHECK (char_length(client_name) BETWEEN 1 AND 100),
  redirect_uris text[] NOT NULL CHECK (cardinality(redirect_uris) BETWEEN 1 AND 3),
  ip_sha256     bytea NOT NULL CHECK (octet_length(ip_sha256) = 32),
  created_at    timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.mcp_oauth_clients ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.mcp_oauth_clients FROM PUBLIC, anon, authenticated;

CREATE TABLE IF NOT EXISTS public.mcp_authorization_requests (
  id                     text PRIMARY KEY CHECK (id ~ '^[A-Za-z0-9_-]{22}$'),
  client_id              text NOT NULL REFERENCES public.mcp_oauth_clients (client_id) ON DELETE CASCADE,
  redirect_uri           text NOT NULL,
  code_challenge         text NOT NULL CHECK (code_challenge ~ '^[A-Za-z0-9_-]{43}$'),
  resource               text NOT NULL CHECK (char_length(resource) BETWEEN 1 AND 300),
  scope                  text NOT NULL CHECK (scope = 'mcp:read'),
  state                  text NULL CHECK (state IS NULL OR char_length(state) <= 512),
  browser_binding_sha256 bytea NOT NULL CHECK (octet_length(browser_binding_sha256) = 32),
  status                 text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'denied')),
  claimed_by             uuid NULL REFERENCES auth.users (id) ON DELETE CASCADE,
  consent_nonce_sha256   bytea NULL CHECK (consent_nonce_sha256 IS NULL OR octet_length(consent_nonce_sha256) = 32),
  created_at             timestamptz NOT NULL DEFAULT now(),
  expires_at             timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS mcp_authorization_requests_expires_idx ON public.mcp_authorization_requests (expires_at);
ALTER TABLE public.mcp_authorization_requests ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.mcp_authorization_requests FROM PUBLIC, anon, authenticated;

CREATE TABLE IF NOT EXISTS public.mcp_connections (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        uuid NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
  client_id      text NOT NULL REFERENCES public.mcp_oauth_clients (client_id) ON DELETE CASCADE,
  provider       text NOT NULL CHECK (provider IN ('anthropic', 'openai')),
  client_name    text NOT NULL,
  redirect_uri   text NOT NULL,
  resource       text NOT NULL,
  scope          text NOT NULL CHECK (scope = 'mcp:read'),
  notice_version smallint NOT NULL,
  status         text NOT NULL CHECK (status IN ('pending', 'active')),
  consented_at   timestamptz NOT NULL DEFAULT now(),
  activated_at   timestamptz NULL,
  last_used_at   timestamptz NULL,
  CHECK ((status = 'active') = (activated_at IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS mcp_connections_user_redirect_idx ON public.mcp_connections (user_id, redirect_uri);
CREATE INDEX IF NOT EXISTS mcp_connections_client_idx ON public.mcp_connections (client_id);
ALTER TABLE public.mcp_connections ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.mcp_connections FROM PUBLIC, anon, authenticated;

CREATE TABLE IF NOT EXISTS public.mcp_authorization_codes (
  code_sha256    bytea PRIMARY KEY CHECK (octet_length(code_sha256) = 32),
  connection_id  uuid NOT NULL REFERENCES public.mcp_connections (id) ON DELETE CASCADE,
  client_id      text NOT NULL,
  redirect_uri   text NOT NULL,
  code_challenge text NOT NULL,
  resource       text NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  expires_at     timestamptz NOT NULL,
  used_at        timestamptz NULL
);
CREATE INDEX IF NOT EXISTS mcp_authorization_codes_connection_idx ON public.mcp_authorization_codes (connection_id);
ALTER TABLE public.mcp_authorization_codes ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.mcp_authorization_codes FROM PUBLIC, anon, authenticated;

CREATE TABLE IF NOT EXISTS public.mcp_tokens (
  token_sha256   bytea PRIMARY KEY CHECK (octet_length(token_sha256) = 32),
  connection_id  uuid NOT NULL REFERENCES public.mcp_connections (id) ON DELETE CASCADE,
  kind           text NOT NULL CHECK (kind IN ('access', 'refresh')),
  pepper_version smallint NOT NULL,
  issued_at      timestamptz NOT NULL DEFAULT now(),
  expires_at     timestamptz NOT NULL,
  used_at        timestamptz NULL,
  CHECK (expires_at >= issued_at + interval '300 seconds'),
  CHECK (kind = 'refresh' OR used_at IS NULL)
);
CREATE INDEX IF NOT EXISTS mcp_tokens_connection_idx ON public.mcp_tokens (connection_id);
ALTER TABLE public.mcp_tokens ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.mcp_tokens FROM PUBLIC, anon, authenticated;

CREATE TABLE IF NOT EXISTS public.mcp_rate_counters (
  bucket       text NOT NULL,
  window_start timestamptz NOT NULL,
  count        integer NOT NULL CHECK (count > 0),
  PRIMARY KEY (bucket, window_start)
);
ALTER TABLE public.mcp_rate_counters ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.mcp_rate_counters FROM PUBLIC, anon, authenticated;

CREATE TABLE IF NOT EXISTS public.mcp_call_log (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id       uuid NULL REFERENCES auth.users (id) ON DELETE CASCADE,
  connection_id uuid NULL,
  provider      text NULL,
  event         text NOT NULL CHECK (event IN ('call', 'refresh_reuse', 'code_replay', 'code_rejected', 'disconnect', 'disconnect_all', 'cloud_off', 'reconnect_replaced')),
  tool          text NULL CHECK (tool IS NULL OR tool IN ('get_status')),
  outcome       text NOT NULL CHECK (outcome IN ('pending', 'ok', 'not_connected', 'disabled', 'rate_limited', 'busy', 'not_entitled', 'timeout', 'error')),
  started_at    timestamptz NOT NULL DEFAULT now(),
  ended_at      timestamptz NULL,
  rows_returned integer NULL,
  duration_ms   integer NULL
);
CREATE INDEX IF NOT EXISTS mcp_call_log_user_idx ON public.mcp_call_log (user_id, started_at);
ALTER TABLE public.mcp_call_log ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.mcp_call_log FROM PUBLIC, anon, authenticated;
REVOKE ALL ON SEQUENCE public.mcp_call_log_id_seq FROM PUBLIC, anon, authenticated;

DO $type$
BEGIN
  IF to_regtype('public.mcp_gate') IS NULL THEN
    CREATE TYPE public.mcp_gate AS (call_id bigint, user_id uuid, connection_id uuid, provider text, outcome text);
  END IF;
END
$type$;
REVOKE ALL ON TYPE public.mcp_gate FROM PUBLIC, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Internal helpers (no API role holds EXECUTE)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public._mcp_secret_ok(p_secret text)
RETURNS boolean LANGUAGE sql STABLE SECURITY INVOKER SET search_path = '' AS $fn$
  SELECT coalesce((
    SELECT p_secret IS NOT NULL
       AND s.portal_secret_sha256 IS NOT NULL
       AND (sha256(convert_to(p_secret, 'UTF8')) = s.portal_secret_sha256
            OR (s.portal_secret_prev_sha256 IS NOT NULL
                AND sha256(convert_to(p_secret, 'UTF8')) = s.portal_secret_prev_sha256))
      FROM public.mcp_settings s
     WHERE s.id), false)
$fn$;
REVOKE ALL ON FUNCTION public._mcp_secret_ok(text) FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public._mcp_refuse(p_code text)
RETURNS jsonb LANGUAGE sql IMMUTABLE SECURITY INVOKER SET search_path = '' AS $fn$
  SELECT jsonb_build_object('ok', false, 'error', coalesce(p_code, 'error'))
$fn$;
REVOKE ALL ON FUNCTION public._mcp_refuse(text) FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public._mcp_b64url(p bytea)
RETURNS text LANGUAGE sql IMMUTABLE SECURITY INVOKER SET search_path = '' AS $fn$
  SELECT rtrim(translate(encode(p, 'base64'), E'+/\n', '-_'), '=')
$fn$;
REVOKE ALL ON FUNCTION public._mcp_b64url(bytea) FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public._mcp_window(p_window interval)
RETURNS timestamptz LANGUAGE sql STABLE SECURITY INVOKER SET search_path = '' AS $fn$
  SELECT to_timestamp(floor(extract(epoch FROM now()) / extract(epoch FROM p_window)) * extract(epoch FROM p_window))
$fn$;
REVOKE ALL ON FUNCTION public._mcp_window(interval) FROM PUBLIC, anon, authenticated, service_role;

-- Returns 'ok', 'rate_limited' or 'busy' (row lock not obtained within 1 s).
CREATE OR REPLACE FUNCTION public._mcp_bump(p_bucket text, p_window interval, p_limit integer)
RETURNS text LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path = '' AS $fn$
DECLARE
  v_n   integer;
  v_old text := current_setting('lock_timeout');
BEGIN
  PERFORM set_config('lock_timeout', '1000ms', true);
  BEGIN
    DELETE FROM public.mcp_rate_counters o
     WHERE o.bucket = p_bucket AND o.window_start < now() - interval '1 day';
    INSERT INTO public.mcp_rate_counters AS rc (bucket, window_start, count)
    VALUES (p_bucket, public._mcp_window(p_window), 1)
    ON CONFLICT (bucket, window_start) DO UPDATE SET count = rc.count + 1
    RETURNING rc.count INTO v_n;
  EXCEPTION WHEN lock_not_available THEN
    PERFORM set_config('lock_timeout', v_old, true);
    RETURN 'busy';
  END;
  PERFORM set_config('lock_timeout', v_old, true);
  IF v_n <= p_limit THEN
    RETURN 'ok';
  END IF;
  RETURN 'rate_limited';
END
$fn$;
REVOKE ALL ON FUNCTION public._mcp_bump(text, interval, integer) FROM PUBLIC, anon, authenticated, service_role;

-- Token endpoint failure: counts it for the client id; returns the refusal, or 'rate_limited'
-- after more than 20 failures in the current minute. Called on failure paths only.
CREATE OR REPLACE FUNCTION public._mcp_token_fail(p_client_id text, p_code text)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path = '' AS $fn$
BEGIN
  IF public._mcp_bump('tok_fail:' || coalesce(p_client_id, ''), interval '1 minute', 20) IS NOT DISTINCT FROM 'ok' THEN
    RETURN public._mcp_refuse(p_code);
  END IF;
  RETURN public._mcp_refuse('rate_limited');
END
$fn$;
REVOKE ALL ON FUNCTION public._mcp_token_fail(text, text) FROM PUBLIC, anon, authenticated, service_role;

-- true when the user has an impersonation session in progress as the admin
CREATE OR REPLACE FUNCTION public._mcp_impersonating(p_user_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY INVOKER SET search_path = '' AS $fn$
  SELECT p_user_id IS NULL OR EXISTS (
    SELECT 1 FROM public.impersonation_sessions i
     WHERE i.admin_user_id = p_user_id
       AND i.status IN ('active', 'validated')
       AND i.session_expires_at > now())
$fn$;
REVOKE ALL ON FUNCTION public._mcp_impersonating(uuid) FROM PUBLIC, anon, authenticated, service_role;

-- true when the function is owned by mcp_reader, STABLE and SECURITY DEFINER
CREATE OR REPLACE FUNCTION public._mcp_reader_ok(p_fn regprocedure)
RETURNS boolean LANGUAGE sql STABLE SECURITY INVOKER SET search_path = '' AS $fn$
  SELECT EXISTS (SELECT 1 FROM pg_catalog.pg_proc p
                  WHERE p.oid = p_fn
                    AND p.proowner = (SELECT r.oid FROM pg_catalog.pg_roles r WHERE r.rolname = 'mcp_reader')
                    AND p.provolatile = 's'
                    AND p.prosecdef)
$fn$;
REVOKE ALL ON FUNCTION public._mcp_reader_ok(regprocedure) FROM PUBLIC, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Reader (owner mcp_reader)
-- ---------------------------------------------------------------------------
GRANT CREATE ON SCHEMA public TO mcp_reader;
SET ROLE mcp_reader;

CREATE OR REPLACE FUNCTION public._mcp_r_entitlement()
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $fn$
DECLARE
  v_state jsonb;
BEGIN
  IF to_regprocedure('public.get_my_cloud_autosave_state()') IS NULL THEN
    RETURN jsonb_build_object('entitled', false, 'reason', 'cloud_not_built');
  END IF;
  BEGIN
    EXECUTE 'SELECT public.get_my_cloud_autosave_state()' INTO v_state;
  EXCEPTION WHEN OTHERS THEN
    RETURN jsonb_build_object('entitled', false, 'reason', 'state_unavailable');
  END;
  IF (v_state -> 'schema_version') IS DISTINCT FROM to_jsonb(1) THEN
    RETURN jsonb_build_object('entitled', false, 'reason', 'state_unavailable');
  END IF;
  IF (v_state -> 'entitled') IS DISTINCT FROM to_jsonb(true) THEN
    RETURN jsonb_build_object('entitled', false, 'reason', coalesce(v_state ->> 'reason', 'not_entitled'));
  END IF;
  RETURN jsonb_build_object('entitled', true, 'reason', NULL);
END
$fn$;
REVOKE ALL ON FUNCTION public._mcp_r_entitlement() FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public._mcp_r_entitlement() TO postgres;

RESET ROLE;
REVOKE CREATE ON SCHEMA public FROM mcp_reader;

-- ---------------------------------------------------------------------------
-- Gate and finish (internal)
-- ---------------------------------------------------------------------------
-- outcome: 'ok' | 'not_connected' | 'disabled' | 'rate_limited' | 'busy'; a log row is written
-- for every outcome except 'not_connected'.
CREATE OR REPLACE FUNCTION public._mcp_enter(p_at_digest bytea, p_resource text, p_tool text)
RETURNS public.mcp_gate LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path = '' AS $fn$
DECLARE
  g   public.mcp_gate;
  v_b text;
BEGIN
  SELECT c.id, c.user_id, c.provider INTO g.connection_id, g.user_id, g.provider
    FROM public.mcp_tokens t
    JOIN public.mcp_connections c ON c.id = t.connection_id
    JOIN public.mcp_settings s ON s.id
   WHERE t.token_sha256 = sha256(p_at_digest)
     AND octet_length(p_at_digest) = 32
     AND t.kind = 'access'
     AND t.expires_at > now()
     AND t.pepper_version = s.pepper_version
     AND c.status = 'active'
     AND c.resource = p_resource;
  IF g.connection_id IS NULL OR g.user_id IS NULL THEN
    g.connection_id := NULL;
    g.user_id := NULL;
    g.outcome := 'not_connected';
    RETURN g;
  END IF;

  IF (SELECT s.enabled FROM public.mcp_settings s WHERE s.id) IS NOT TRUE THEN
    g.outcome := 'disabled';
  ELSE
    v_b := public._mcp_bump('call_conn:' || g.connection_id::text, interval '1 minute', 30);
    IF v_b IS NOT DISTINCT FROM 'ok' THEN
      v_b := public._mcp_bump('call_user:' || g.user_id::text, interval '1 minute', 60);
    END IF;
    g.outcome := coalesce(v_b, 'busy');
  END IF;

  IF g.outcome = 'ok' THEN
    UPDATE public.mcp_connections SET last_used_at = now() WHERE id = g.connection_id;
  END IF;

  INSERT INTO public.mcp_call_log (user_id, connection_id, provider, event, tool, outcome, ended_at)
  VALUES (g.user_id, g.connection_id, g.provider, 'call', p_tool,
          CASE WHEN g.outcome = 'ok' THEN 'pending' ELSE g.outcome END,
          CASE WHEN g.outcome = 'ok' THEN NULL ELSE now() END)
  RETURNING id INTO g.call_id;
  RETURN g;
END
$fn$;
REVOKE ALL ON FUNCTION public._mcp_enter(bytea, text, text) FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public._mcp_finish(p_call_id bigint, p_outcome text, p_rows integer, p_started timestamptz)
RETURNS void LANGUAGE sql VOLATILE SECURITY INVOKER SET search_path = '' AS $fn$
  UPDATE public.mcp_call_log
     SET outcome = coalesce(p_outcome, 'error'),
         ended_at = now(),
         rows_returned = p_rows,
         duration_ms = (extract(epoch FROM clock_timestamp() - p_started) * 1000)::integer
   WHERE id = p_call_id AND outcome = 'pending'
$fn$;
REVOKE ALL ON FUNCTION public._mcp_finish(bigint, text, integer, timestamptz) FROM PUBLIC, anon, authenticated, service_role;

-- Entitlement of the signed-in caller, read through the reader in a read-only block that is
-- always rolled back. Returns {entitled, reason}.
CREATE OR REPLACE FUNCTION public._mcp_entitlement_now()
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path = '' AS $fn$
DECLARE
  v_ent jsonb;
BEGIN
  IF public._mcp_reader_ok('public._mcp_r_entitlement()'::regprocedure) IS NOT TRUE THEN
    RETURN jsonb_build_object('entitled', false, 'reason', 'state_unavailable');
  END IF;
  BEGIN
    PERFORM set_config('transaction_read_only', 'on', true);
    v_ent := public._mcp_r_entitlement();
    RAISE EXCEPTION USING ERRCODE = 'MC000', MESSAGE = 'mcp read block done';
  EXCEPTION
    WHEN SQLSTATE 'MC000' THEN NULL;
    WHEN OTHERS THEN v_ent := NULL;
  END;
  RETURN coalesce(v_ent, jsonb_build_object('entitled', false, 'reason', 'state_unavailable'));
END
$fn$;
REVOKE ALL ON FUNCTION public._mcp_entitlement_now() FROM PUBLIC, anon, authenticated, service_role;

-- Disconnects every AI app of a user. p_event: 'disconnect_all' | 'cloud_off'.
CREATE OR REPLACE FUNCTION public._mcp_disconnect_all_for(p_user_id uuid, p_event text)
RETURNS integer LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path = '' AS $fn$
DECLARE
  v_n integer;
BEGIN
  IF (p_user_id IS NOT NULL AND p_event IN ('disconnect_all', 'cloud_off')) IS NOT TRUE THEN
    RAISE EXCEPTION 'invalid argument' USING ERRCODE = '22023';
  END IF;
  DELETE FROM public.mcp_connections c WHERE c.user_id = p_user_id;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  DELETE FROM public.mcp_authorization_requests r WHERE r.claimed_by = p_user_id;
  INSERT INTO public.mcp_call_log (user_id, event, outcome, ended_at, rows_returned)
  VALUES (p_user_id, p_event, 'ok', now(), v_n);
  RETURN v_n;
END
$fn$;
REVOKE ALL ON FUNCTION public._mcp_disconnect_all_for(uuid, text) FROM PUBLIC, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Anon functions (broker portal server; portal secret checked inside)
-- ---------------------------------------------------------------------------
-- Returns {ok, client_id, client_name, redirect_uris}
-- errors: invalid_client_metadata | invalid_redirect_uri | rate_limited | busy
-- Intentionally callable by anon: OAuth dynamic client registration
CREATE OR REPLACE FUNCTION public.mcp_register_client(p_secret text, p_client_id text, p_client_name text, p_redirect_uris text[], p_ip_sha256 bytea)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = '' AS $fn$
DECLARE
  v_b text;
BEGIN
  IF public._mcp_secret_ok(p_secret) IS NOT TRUE THEN
    RETURN public._mcp_refuse('invalid_client_metadata');
  END IF;
  IF (octet_length(p_ip_sha256) = 32) IS NOT TRUE THEN
    RETURN public._mcp_refuse('invalid_client_metadata');
  END IF;
  v_b := public._mcp_bump('reg_ip:' || encode(p_ip_sha256, 'hex'), interval '1 hour', 10);
  IF v_b IS NOT DISTINCT FROM 'ok' THEN
    v_b := public._mcp_bump('reg_all', interval '1 day', 500);
  END IF;
  IF v_b IS DISTINCT FROM 'ok' THEN
    RETURN public._mcp_refuse(coalesce(v_b, 'busy'));
  END IF;
  IF (p_client_id ~ '^kpr_c_[A-Za-z0-9_-]{22}$'
      AND char_length(p_client_name) BETWEEN 1 AND 100) IS NOT TRUE THEN
    RETURN public._mcp_refuse('invalid_client_metadata');
  END IF;
  IF (cardinality(p_redirect_uris) BETWEEN 1 AND 3
      AND array_position(p_redirect_uris, NULL) IS NULL
      AND NOT EXISTS (SELECT 1 FROM unnest(p_redirect_uris) u(uri)
                       WHERE NOT EXISTS (SELECT 1 FROM public.mcp_redirect_allowlist a WHERE a.redirect_uri = u.uri))) IS NOT TRUE THEN
    RETURN public._mcp_refuse('invalid_redirect_uri');
  END IF;
  INSERT INTO public.mcp_oauth_clients (client_id, client_name, redirect_uris, ip_sha256)
  VALUES (p_client_id, p_client_name, p_redirect_uris, p_ip_sha256)
  ON CONFLICT (client_id) DO NOTHING;
  IF NOT FOUND THEN
    RETURN public._mcp_refuse('invalid_client_metadata');
  END IF;
  RETURN jsonb_build_object('ok', true, 'client_id', p_client_id, 'client_name', p_client_name,
                            'redirect_uris', to_jsonb(p_redirect_uris));
END
$fn$;
REVOKE ALL ON FUNCTION public.mcp_register_client(text, text, text, text[], bytea) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.mcp_register_client(text, text, text, text[], bytea) TO anon;

-- Returns {ok, request_id, expires_in}
-- or {ok:false, error, show:'page'}       errors: invalid_client | temporarily_unavailable
-- or {ok:false, error, show:'redirect', redirect_uri, state}   errors: invalid_request | invalid_scope
-- Intentionally callable by anon: OAuth authorization request from a registered client
CREATE OR REPLACE FUNCTION public.mcp_authorize_begin(p_secret text, p_client_id text, p_redirect_uri text, p_code_challenge text, p_code_challenge_method text,
                                                      p_resource text, p_scope text, p_state text, p_browser_binding_sha256 bytea, p_ip_sha256 bytea)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = '' AS $fn$
DECLARE
  v_b  text;
  v_id text;
BEGIN
  IF public._mcp_secret_ok(p_secret) IS NOT TRUE THEN
    RETURN public._mcp_refuse('invalid_client') || jsonb_build_object('show', 'page');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.mcp_oauth_clients c
                   JOIN public.mcp_redirect_allowlist a ON a.redirect_uri = p_redirect_uri
                  WHERE c.client_id = p_client_id
                    AND p_redirect_uri = ANY (c.redirect_uris)) THEN
    RETURN public._mcp_refuse('invalid_client') || jsonb_build_object('show', 'page');
  END IF;
  IF (SELECT s.enabled FROM public.mcp_settings s WHERE s.id) IS NOT TRUE
     OR (octet_length(p_ip_sha256) = 32) IS NOT TRUE THEN
    RETURN public._mcp_refuse('temporarily_unavailable') || jsonb_build_object('show', 'page');
  END IF;
  v_b := public._mcp_bump('authz_ip:' || encode(p_ip_sha256, 'hex'), interval '10 minutes', 30);
  IF v_b IS DISTINCT FROM 'ok' THEN
    RETURN public._mcp_refuse('temporarily_unavailable') || jsonb_build_object('show', 'page');
  END IF;
  IF (p_code_challenge_method = 'S256'
      AND p_code_challenge ~ '^[A-Za-z0-9_-]{43}$'
      AND char_length(p_resource) BETWEEN 1 AND 300
      AND octet_length(p_browser_binding_sha256) = 32
      AND (p_state IS NULL OR char_length(p_state) <= 512)) IS NOT TRUE THEN
    RETURN public._mcp_refuse('invalid_request')
           || jsonb_build_object('show', 'redirect', 'redirect_uri', p_redirect_uri, 'state', p_state);
  END IF;
  IF p_scope IS DISTINCT FROM 'mcp:read' THEN
    RETURN public._mcp_refuse('invalid_scope')
           || jsonb_build_object('show', 'redirect', 'redirect_uri', p_redirect_uri, 'state', p_state);
  END IF;
  DELETE FROM public.mcp_authorization_requests r
   WHERE r.id IN (SELECT x.id FROM public.mcp_authorization_requests x WHERE x.expires_at < now() LIMIT 200);
  v_id := public._mcp_b64url(uuid_send(gen_random_uuid()));
  INSERT INTO public.mcp_authorization_requests (id, client_id, redirect_uri, code_challenge, resource, scope, state,
                                                 browser_binding_sha256, expires_at)
  VALUES (v_id, p_client_id, p_redirect_uri, p_code_challenge, p_resource, p_scope, p_state,
          p_browser_binding_sha256, now() + interval '10 minutes');
  RETURN jsonb_build_object('ok', true, 'request_id', v_id, 'expires_in', 600);
END
$fn$;
REVOKE ALL ON FUNCTION public.mcp_authorize_begin(text, text, text, text, text, text, text, text, bytea, bytea) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.mcp_authorize_begin(text, text, text, text, text, text, text, text, bytea, bytea) TO anon;

-- Returns {ok, token_type:'Bearer', expires_in:3600, scope:'mcp:read'}
-- errors: invalid_grant | invalid_request | rate_limited
-- Intentionally callable by anon: OAuth token exchange for a registered client
CREATE OR REPLACE FUNCTION public.mcp_exchange_code(p_secret text, p_code_digest bytea, p_code_verifier text, p_client_id text, p_redirect_uri text,
                                                    p_resource text, p_at_digest bytea, p_rt_digest bytea)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = '' AS $fn$
DECLARE
  v_code   public.mcp_authorization_codes%ROWTYPE;
  v_user   uuid;
  v_redir  text;
  v_pepper smallint;
  v_n      integer;
BEGIN
  IF public._mcp_secret_ok(p_secret) IS NOT TRUE THEN
    RETURN public._mcp_refuse('invalid_grant');
  END IF;
  IF (octet_length(p_code_digest) = 32 AND octet_length(p_at_digest) = 32 AND octet_length(p_rt_digest) = 32
      AND p_at_digest IS DISTINCT FROM p_rt_digest) IS NOT TRUE THEN
    RETURN public._mcp_token_fail(p_client_id, 'invalid_request');
  END IF;

  UPDATE public.mcp_authorization_codes k
     SET used_at = now()
   WHERE k.code_sha256 = sha256(p_code_digest)
     AND k.used_at IS NULL
     AND k.expires_at > now()
  RETURNING k.* INTO v_code;

  IF v_code.code_sha256 IS NULL THEN
    SELECT c.user_id INTO v_user
      FROM public.mcp_authorization_codes k
      JOIN public.mcp_connections c ON c.id = k.connection_id
     WHERE k.code_sha256 = sha256(p_code_digest)
       AND k.used_at IS NOT NULL;
    IF FOUND THEN
      DELETE FROM public.mcp_connections c
       WHERE c.id = (SELECT k.connection_id FROM public.mcp_authorization_codes k WHERE k.code_sha256 = sha256(p_code_digest));
      INSERT INTO public.mcp_call_log (user_id, event, outcome, ended_at) VALUES (v_user, 'code_replay', 'ok', now());
    END IF;
    RETURN public._mcp_token_fail(p_client_id, 'invalid_grant');
  END IF;

  -- a rejected redemption uses up the code and removes its pending connection
  IF (v_code.client_id = p_client_id
      AND v_code.redirect_uri = p_redirect_uri
      AND v_code.resource = p_resource
      AND EXISTS (SELECT 1 FROM public.mcp_redirect_allowlist a WHERE a.redirect_uri = p_redirect_uri)
      AND p_code_verifier ~ '^[A-Za-z0-9._~-]{43,128}$'
      AND public._mcp_b64url(sha256(convert_to(p_code_verifier, 'UTF8'))) = v_code.code_challenge) IS NOT TRUE THEN
    DELETE FROM public.mcp_connections c
     WHERE c.id = v_code.connection_id AND c.status = 'pending'
    RETURNING c.user_id INTO v_user;
    INSERT INTO public.mcp_call_log (user_id, connection_id, event, outcome, ended_at)
    VALUES (v_user, v_code.connection_id, 'code_rejected', 'ok', now());
    RETURN public._mcp_token_fail(p_client_id, 'invalid_grant');
  END IF;

  UPDATE public.mcp_connections c
     SET status = 'active', activated_at = now()
   WHERE c.id = v_code.connection_id
     AND c.status = 'pending'
  RETURNING c.user_id, c.redirect_uri INTO v_user, v_redir;
  IF v_user IS NULL THEN
    RETURN public._mcp_refuse('invalid_grant');
  END IF;

  DELETE FROM public.mcp_connections c
   WHERE c.user_id = v_user AND c.redirect_uri = v_redir AND c.id <> v_code.connection_id AND c.status = 'active';
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n > 0 THEN
    INSERT INTO public.mcp_call_log (user_id, connection_id, event, outcome, ended_at, rows_returned)
    VALUES (v_user, v_code.connection_id, 'reconnect_replaced', 'ok', now(), v_n);
  END IF;

  SELECT s.pepper_version INTO v_pepper FROM public.mcp_settings s WHERE s.id;
  BEGIN
    INSERT INTO public.mcp_tokens (token_sha256, connection_id, kind, pepper_version, expires_at) VALUES
      (sha256(p_at_digest), v_code.connection_id, 'access', v_pepper, now() + interval '1 hour'),
      (sha256(p_rt_digest), v_code.connection_id, 'refresh', v_pepper, now() + interval '30 days');
  EXCEPTION WHEN unique_violation OR not_null_violation THEN
    RETURN public._mcp_refuse('invalid_request');
  END;
  RETURN jsonb_build_object('ok', true, 'token_type', 'Bearer', 'expires_in', 3600, 'scope', 'mcp:read');
END
$fn$;
REVOKE ALL ON FUNCTION public.mcp_exchange_code(text, bytea, text, text, text, text, bytea, bytea) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.mcp_exchange_code(text, bytea, text, text, text, text, bytea, bytea) TO anon;

-- Returns {ok, token_type:'Bearer', expires_in:3600, scope:'mcp:read'}
-- errors: invalid_grant | invalid_request | rate_limited
-- Intentionally callable by anon: OAuth refresh token grant for a registered client
CREATE OR REPLACE FUNCTION public.mcp_refresh(p_secret text, p_rt_digest bytea, p_client_id text, p_resource text, p_new_at_digest bytea, p_new_rt_digest bytea)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = '' AS $fn$
DECLARE
  v_conn   uuid;
  v_user   uuid;
  v_pepper smallint;
BEGIN
  IF public._mcp_secret_ok(p_secret) IS NOT TRUE THEN
    RETURN public._mcp_refuse('invalid_grant');
  END IF;
  IF (octet_length(p_rt_digest) = 32 AND octet_length(p_new_at_digest) = 32 AND octet_length(p_new_rt_digest) = 32
      AND p_new_at_digest IS DISTINCT FROM p_new_rt_digest) IS NOT TRUE THEN
    RETURN public._mcp_token_fail(p_client_id, 'invalid_request');
  END IF;

  UPDATE public.mcp_tokens t
     SET used_at = now()
    FROM public.mcp_connections c, public.mcp_settings s
   WHERE t.token_sha256 = sha256(p_rt_digest)
     AND t.kind = 'refresh'
     AND t.used_at IS NULL
     AND t.expires_at > now()
     AND s.id
     AND t.pepper_version = s.pepper_version
     AND c.id = t.connection_id
     AND c.status = 'active'
     AND c.client_id = p_client_id
     AND c.resource = p_resource
  RETURNING t.connection_id, c.user_id, s.pepper_version INTO v_conn, v_user, v_pepper;

  IF v_conn IS NULL THEN
    SELECT t.connection_id, c.user_id INTO v_conn, v_user
      FROM public.mcp_tokens t
      JOIN public.mcp_connections c ON c.id = t.connection_id
     WHERE t.token_sha256 = sha256(p_rt_digest)
       AND t.kind = 'refresh'
       AND t.used_at IS NOT NULL;
    IF v_conn IS NOT NULL THEN
      DELETE FROM public.mcp_connections c WHERE c.id = v_conn;
      INSERT INTO public.mcp_call_log (user_id, connection_id, event, outcome, ended_at) VALUES (v_user, v_conn, 'refresh_reuse', 'ok', now());
    END IF;
    RETURN public._mcp_token_fail(p_client_id, 'invalid_grant');
  END IF;

  BEGIN
    INSERT INTO public.mcp_tokens (token_sha256, connection_id, kind, pepper_version, expires_at) VALUES
      (sha256(p_new_at_digest), v_conn, 'access', v_pepper, now() + interval '1 hour'),
      (sha256(p_new_rt_digest), v_conn, 'refresh', v_pepper, now() + interval '30 days');
  EXCEPTION WHEN unique_violation OR not_null_violation THEN
    RETURN public._mcp_refuse('invalid_request');
  END;
  DELETE FROM public.mcp_tokens o
   WHERE o.connection_id = v_conn AND o.expires_at < now() - interval '1 day';
  RETURN jsonb_build_object('ok', true, 'token_type', 'Bearer', 'expires_in', 3600, 'scope', 'mcp:read');
END
$fn$;
REVOKE ALL ON FUNCTION public.mcp_refresh(text, bytea, text, text, bytea, bytea) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.mcp_refresh(text, bytea, text, text, bytea, bytea) TO anon;

-- Returns {ok:true} | {ok:false, error:'not_connected'}. Not counted, not logged.
-- Intentionally callable by anon: MCP request access check from the broker portal server
CREATE OR REPLACE FUNCTION public.mcp_check_access(p_secret text, p_at_digest bytea, p_resource text)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $fn$
BEGIN
  IF public._mcp_secret_ok(p_secret) IS NOT TRUE THEN
    RETURN public._mcp_refuse('not_connected');
  END IF;
  IF EXISTS (SELECT 1
               FROM public.mcp_tokens t
               JOIN public.mcp_connections c ON c.id = t.connection_id
               JOIN public.mcp_settings s ON s.id
              WHERE t.token_sha256 = sha256(p_at_digest)
                AND octet_length(p_at_digest) = 32
                AND t.kind = 'access'
                AND t.expires_at > now()
                AND t.pepper_version = s.pepper_version
                AND s.enabled
                AND c.status = 'active'
                AND c.resource = p_resource) THEN
    RETURN jsonb_build_object('ok', true);
  END IF;
  RETURN public._mcp_refuse('not_connected');
END
$fn$;
REVOKE ALL ON FUNCTION public.mcp_check_access(text, bytea, text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.mcp_check_access(text, bytea, text) TO anon;

-- Tool get_status.
-- Returns {ok:true, result:{connected:true, provider, entitled, reason}}
-- errors: not_connected | disabled | rate_limited | busy | timeout | error
-- Intentionally callable by anon: MCP tool call get_status from the broker portal server
CREATE OR REPLACE FUNCTION public.mcp_get_status(p_secret text, p_at_digest bytea, p_resource text)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = '' AS $fn$
DECLARE
  g     public.mcp_gate;
  v_ent jsonb;
  v_out text := 'ok';
  v_t0  timestamptz := clock_timestamp();
BEGIN
  IF public._mcp_secret_ok(p_secret) IS NOT TRUE THEN
    RETURN public._mcp_refuse('not_connected');
  END IF;
  g := public._mcp_enter(p_at_digest, p_resource, 'get_status');
  IF g.outcome IS DISTINCT FROM 'ok' THEN
    RETURN public._mcp_refuse(g.outcome);
  END IF;
  IF public._mcp_reader_ok('public._mcp_r_entitlement()'::regprocedure) IS NOT TRUE THEN
    v_out := 'error';
  ELSE
    BEGIN
      PERFORM set_config('transaction_read_only', 'on', true);
      PERFORM set_config('request.jwt.claims', jsonb_build_object('sub', g.user_id, 'role', 'authenticated')::text, true);
      PERFORM set_config('request.jwt.claim.sub', g.user_id::text, true);
      PERFORM set_config('request.jwt.claim.role', 'authenticated', true);
      v_ent := public._mcp_r_entitlement();
      RAISE EXCEPTION USING ERRCODE = 'MC000', MESSAGE = 'mcp read block done';
    EXCEPTION
      WHEN SQLSTATE 'MC000' THEN NULL;
      WHEN query_canceled THEN v_out := 'timeout'; v_ent := NULL;
      WHEN OTHERS THEN v_out := 'error'; v_ent := NULL;
    END;
  END IF;
  PERFORM public._mcp_finish(g.call_id, v_out, CASE WHEN v_out = 'ok' THEN 1 END, v_t0);
  IF v_out IS DISTINCT FROM 'ok' THEN
    RETURN public._mcp_refuse(v_out);
  END IF;
  RETURN jsonb_build_object('ok', true, 'result', jsonb_build_object(
    'connected', true,
    'provider', g.provider,
    'entitled', (v_ent -> 'entitled') IS NOT DISTINCT FROM to_jsonb(true),
    'reason', v_ent -> 'reason'));
END
$fn$;
REVOKE ALL ON FUNCTION public.mcp_get_status(text, bytea, text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.mcp_get_status(text, bytea, text) TO anon;

-- ---------------------------------------------------------------------------
-- Signed-in functions (broker portal user)
-- ---------------------------------------------------------------------------
-- Returns {ok, request_id, client_name, provider, redirect_host, scope, notice_version, nonce}
-- errors: not_signed_in | impersonating | disabled | request_invalid
CREATE OR REPLACE FUNCTION public.mcp_authorize_view(p_request_id text, p_browser_binding_sha256 bytea)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = '' AS $fn$
DECLARE
  v_uid   uuid := auth.uid();
  v_nonce text;
  v_req   public.mcp_authorization_requests%ROWTYPE;
  v_r     jsonb;
BEGIN
  IF v_uid IS NULL THEN
    RETURN public._mcp_refuse('not_signed_in');
  END IF;
  IF public._mcp_impersonating(v_uid) IS NOT FALSE THEN
    RETURN public._mcp_refuse('impersonating');
  END IF;
  IF (SELECT s.enabled FROM public.mcp_settings s WHERE s.id) IS NOT TRUE THEN
    RETURN public._mcp_refuse('disabled');
  END IF;
  v_nonce := public._mcp_b64url(uuid_send(gen_random_uuid()) || uuid_send(gen_random_uuid()));
  UPDATE public.mcp_authorization_requests r
     SET claimed_by = v_uid,
         consent_nonce_sha256 = sha256(convert_to(v_nonce, 'UTF8'))
   WHERE r.id = p_request_id
     AND r.status = 'pending'
     AND r.expires_at > now()
     AND r.browser_binding_sha256 = p_browser_binding_sha256
     AND (r.claimed_by IS NULL OR r.claimed_by = v_uid)
  RETURNING r.* INTO v_req;
  IF v_req.id IS NULL THEN
    RETURN public._mcp_refuse('request_invalid');
  END IF;
  SELECT jsonb_build_object(
           'ok', true,
           'request_id', v_req.id,
           'client_name', c.client_name,
           'provider', a.provider,
           'redirect_host', substring(v_req.redirect_uri FROM '^https://([^/]+)'),
           'scope', v_req.scope,
           'notice_version', s.notice_version,
           'nonce', v_nonce)
    INTO v_r
    FROM public.mcp_oauth_clients c
    JOIN public.mcp_redirect_allowlist a ON a.redirect_uri = v_req.redirect_uri
    JOIN public.mcp_settings s ON s.id
   WHERE c.client_id = v_req.client_id;
  RETURN coalesce(v_r, public._mcp_refuse('request_invalid'));
END
$fn$;
REVOKE ALL ON FUNCTION public.mcp_authorize_view(text, bytea) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.mcp_authorize_view(text, bytea) TO authenticated;

-- Returns {ok, redirect_uri, state}
-- errors: not_signed_in | impersonating | disabled | not_entitled | invalid_request | request_invalid
CREATE OR REPLACE FUNCTION public.mcp_authorize_approve(p_request_id text, p_browser_binding_sha256 bytea, p_nonce text, p_code_digest bytea)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = '' AS $fn$
DECLARE
  v_uid  uuid := auth.uid();
  v_req  public.mcp_authorization_requests%ROWTYPE;
  v_conn uuid;
BEGIN
  IF v_uid IS NULL THEN
    RETURN public._mcp_refuse('not_signed_in');
  END IF;
  IF public._mcp_impersonating(v_uid) IS NOT FALSE THEN
    RETURN public._mcp_refuse('impersonating');
  END IF;
  IF (SELECT s.enabled FROM public.mcp_settings s WHERE s.id) IS NOT TRUE THEN
    RETURN public._mcp_refuse('disabled');
  END IF;
  IF (octet_length(p_code_digest) = 32) IS NOT TRUE THEN
    RETURN public._mcp_refuse('invalid_request');
  END IF;
  IF (SELECT s.connect_requires_cloud FROM public.mcp_settings s WHERE s.id) IS NOT FALSE
     AND (public._mcp_entitlement_now() -> 'entitled') IS DISTINCT FROM to_jsonb(true) THEN
    RETURN public._mcp_refuse('not_entitled');
  END IF;

  UPDATE public.mcp_authorization_requests r
     SET status = 'approved', consent_nonce_sha256 = NULL
   WHERE r.id = p_request_id
     AND r.status = 'pending'
     AND r.expires_at > now()
     AND r.browser_binding_sha256 = p_browser_binding_sha256
     AND r.claimed_by = v_uid
     AND r.consent_nonce_sha256 = sha256(convert_to(p_nonce, 'UTF8'))
  RETURNING r.* INTO v_req;
  IF v_req.id IS NULL THEN
    RETURN public._mcp_refuse('request_invalid');
  END IF;

  DELETE FROM public.mcp_connections c
   WHERE c.user_id = v_uid AND c.status = 'pending' AND c.consented_at < now() - interval '15 minutes';

  INSERT INTO public.mcp_connections (user_id, client_id, provider, client_name, redirect_uri, resource, scope, notice_version, status)
  SELECT v_uid, c.client_id, a.provider, c.client_name, v_req.redirect_uri, v_req.resource, v_req.scope, s.notice_version, 'pending'
    FROM public.mcp_oauth_clients c
    JOIN public.mcp_redirect_allowlist a ON a.redirect_uri = v_req.redirect_uri
    JOIN public.mcp_settings s ON s.id
   WHERE c.client_id = v_req.client_id
     AND v_req.redirect_uri = ANY (c.redirect_uris)
  RETURNING id INTO v_conn;
  IF v_conn IS NULL THEN
    RETURN public._mcp_refuse('request_invalid');
  END IF;

  INSERT INTO public.mcp_authorization_codes (code_sha256, connection_id, client_id, redirect_uri, code_challenge, resource, expires_at)
  VALUES (sha256(p_code_digest), v_conn, v_req.client_id, v_req.redirect_uri, v_req.code_challenge, v_req.resource, now() + interval '60 seconds');

  RETURN jsonb_build_object('ok', true, 'redirect_uri', v_req.redirect_uri, 'state', v_req.state);
END
$fn$;
REVOKE ALL ON FUNCTION public.mcp_authorize_approve(text, bytea, text, bytea) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.mcp_authorize_approve(text, bytea, text, bytea) TO authenticated;

-- Returns {ok, redirect_uri, state}
-- errors: not_signed_in | impersonating | request_invalid
CREATE OR REPLACE FUNCTION public.mcp_authorize_deny(p_request_id text, p_browser_binding_sha256 bytea, p_nonce text)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = '' AS $fn$
DECLARE
  v_uid uuid := auth.uid();
  v_req public.mcp_authorization_requests%ROWTYPE;
BEGIN
  IF v_uid IS NULL THEN
    RETURN public._mcp_refuse('not_signed_in');
  END IF;
  IF public._mcp_impersonating(v_uid) IS NOT FALSE THEN
    RETURN public._mcp_refuse('impersonating');
  END IF;
  UPDATE public.mcp_authorization_requests r
     SET status = 'denied', consent_nonce_sha256 = NULL
   WHERE r.id = p_request_id
     AND r.status = 'pending'
     AND r.expires_at > now()
     AND r.browser_binding_sha256 = p_browser_binding_sha256
     AND r.claimed_by = v_uid
     AND r.consent_nonce_sha256 = sha256(convert_to(p_nonce, 'UTF8'))
  RETURNING r.* INTO v_req;
  IF v_req.id IS NULL THEN
    RETURN public._mcp_refuse('request_invalid');
  END IF;
  RETURN jsonb_build_object('ok', true, 'redirect_uri', v_req.redirect_uri, 'state', v_req.state);
END
$fn$;
REVOKE ALL ON FUNCTION public.mcp_authorize_deny(text, bytea, text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.mcp_authorize_deny(text, bytea, text) TO authenticated;

-- Returns {ok, connections:[{id, client_name, provider, redirect_host, consented_at, last_used_at}]}
-- errors: not_signed_in
CREATE OR REPLACE FUNCTION public.mcp_list_my_connections()
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $fn$
DECLARE
  v_uid uuid := auth.uid();
BEGIN
  IF v_uid IS NULL THEN
    RETURN public._mcp_refuse('not_signed_in');
  END IF;
  RETURN jsonb_build_object('ok', true, 'connections', coalesce((
    SELECT jsonb_agg(jsonb_build_object(
             'id', c.id,
             'client_name', c.client_name,
             'provider', c.provider,
             'redirect_host', substring(c.redirect_uri FROM '^https://([^/]+)'),
             'consented_at', c.consented_at,
             'last_used_at', c.last_used_at) ORDER BY c.consented_at DESC)
      FROM public.mcp_connections c
     WHERE c.user_id = v_uid AND c.status = 'active'), '[]'::jsonb));
END
$fn$;
REVOKE ALL ON FUNCTION public.mcp_list_my_connections() FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.mcp_list_my_connections() TO authenticated;

-- Returns {ok:true} whether or not the connection existed.
-- errors: not_signed_in | impersonating
CREATE OR REPLACE FUNCTION public.mcp_disconnect(p_connection_id uuid)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = '' AS $fn$
DECLARE
  v_uid  uuid := auth.uid();
  v_prov text;
BEGIN
  IF v_uid IS NULL THEN
    RETURN public._mcp_refuse('not_signed_in');
  END IF;
  IF public._mcp_impersonating(v_uid) IS NOT FALSE THEN
    RETURN public._mcp_refuse('impersonating');
  END IF;
  DELETE FROM public.mcp_connections c
   WHERE c.id = p_connection_id AND c.user_id = v_uid
  RETURNING c.provider INTO v_prov;
  IF FOUND THEN
    INSERT INTO public.mcp_call_log (user_id, connection_id, provider, event, outcome, ended_at)
    VALUES (v_uid, p_connection_id, v_prov, 'disconnect', 'ok', now());
  END IF;
  RETURN jsonb_build_object('ok', true);
END
$fn$;
REVOKE ALL ON FUNCTION public.mcp_disconnect(uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.mcp_disconnect(uuid) TO authenticated;

-- Returns {ok:true, disconnected:<n>}
-- errors: not_signed_in | impersonating
CREATE OR REPLACE FUNCTION public.mcp_disconnect_all_mine()
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = '' AS $fn$
DECLARE
  v_uid uuid := auth.uid();
BEGIN
  IF v_uid IS NULL THEN
    RETURN public._mcp_refuse('not_signed_in');
  END IF;
  IF public._mcp_impersonating(v_uid) IS NOT FALSE THEN
    RETURN public._mcp_refuse('impersonating');
  END IF;
  RETURN jsonb_build_object('ok', true, 'disconnected', public._mcp_disconnect_all_for(v_uid, 'disconnect_all'));
END
$fn$;
REVOKE ALL ON FUNCTION public.mcp_disconnect_all_mine() FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.mcp_disconnect_all_mine() TO authenticated;
