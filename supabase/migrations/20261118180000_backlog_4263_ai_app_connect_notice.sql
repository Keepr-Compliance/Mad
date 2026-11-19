-- ============================================================================
-- Migration: a notice when an AI app connects (BACKLOG-4263 PR-10.7)
--
-- New table public.ai_app_connect_notices: one row per AI-app connection that turned active, read later by the
--   portal's email job (a later PR). It holds whose account, which provider, whether the connection replaced an
--   earlier one, and the sending state. No token, no connection id, no text supplied by the app. RLS on, no policy,
--   no privilege for any API role; reached only through the two functions below.
-- Replaced (pre-check below): mcp_exchange_code (anon, portal secret checked first, as before). The one change: after
--   the tokens are stored, one INSERT into the new table, in its own BEGIN ... EXCEPTION WHEN OTHERS block (one
--   subtransaction per exchange), so an error there never fails the exchange. The answer is unchanged. 'replaced'
--   is v_n > 0, the row count of the DELETE of the user's earlier active connection to the same redirect address.
--   The body is otherwise character-identical to the body of 20261118130000 (the marker comment aside).
-- New: ai_app_notice_claim(p_limit) and ai_app_notice_done(p_id, p_attempts, p_status, p_error), SECURITY DEFINER,
--   EXECUTE service_role only, each refusing inside unless the request's role is service_role.
--   claim: housekeeping first (a due notice older than 2 days -> skipped 'stale'; a due notice tried 5 times with its
--   lease ended -> failed; finished notices older than 30 days deleted), then up to min(p_limit, 50) due notices with
--   no live lease, FOR UPDATE SKIP LOCKED, each leased for 5 minutes and its attempts incremented. Answers a JSON
--   array of {id, user_id, provider, replaced, connected_at, attempts}.
--   done: sets the status ('due' releases the lease for a retry) only while the row is due and its attempts equal
--   p_attempts; the error code is cut to 40 characters. Answers true when a row changed.
-- Existing rows: none changed. Connections made before this file get no notice.
-- Pre-check: mcp_exchange_code is at the body of 20261118130000 (md5 ab6a9345c55ab69c77347d9b37e92e9d) or already at this
--   file's body (md5 9a33bff2db31288bd77a57489558a65b); otherwise nothing is applied.
-- Re-runnable: CREATE TABLE / INDEX IF NOT EXISTS, CREATE OR REPLACE.
-- Rollback: supabase/tests/backlog-4263-notice/rollback-20261118180000.sql (run it before any rollback of
--   20261118130000).
-- ============================================================================

DO $pre4263notice$
DECLARE v_md5 text;
BEGIN
  SELECT md5(p.prosrc) INTO v_md5 FROM pg_catalog.pg_proc p
   WHERE p.oid = to_regprocedure('public.mcp_exchange_code(text,bytea,text,text,text,text,bytea,bytea)');
  IF v_md5 IS NULL OR v_md5 NOT IN ('ab6a9345c55ab69c77347d9b37e92e9d', '9a33bff2db31288bd77a57489558a65b') THEN
    RAISE EXCEPTION 'BACKLOG-4263: public.mcp_exchange_code is not at the expected body (md5 %)', coalesce(v_md5, 'missing');
  END IF;
END
$pre4263notice$;

-- ============================================================================ table
CREATE TABLE IF NOT EXISTS public.ai_app_connect_notices (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
  provider     text NOT NULL CHECK (provider IN ('anthropic', 'openai')),
  replaced     boolean NOT NULL,
  connected_at timestamptz NOT NULL DEFAULT now(),
  status       text NOT NULL DEFAULT 'due' CHECK (status IN ('due', 'sent', 'queued', 'failed', 'skipped')),
  attempts     smallint NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  lease_until  timestamptz NULL,
  sent_at      timestamptz NULL,
  last_error   text NULL CHECK (last_error IS NULL OR char_length(last_error) <= 40)
);
CREATE INDEX IF NOT EXISTS ai_app_connect_notices_due_idx ON public.ai_app_connect_notices (connected_at) WHERE status = 'due';
CREATE INDEX IF NOT EXISTS ai_app_connect_notices_user_idx ON public.ai_app_connect_notices (user_id);
ALTER TABLE public.ai_app_connect_notices ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.ai_app_connect_notices FROM PUBLIC, anon, authenticated, service_role;
REVOKE TRUNCATE ON TABLE public.ai_app_connect_notices FROM anon, authenticated;

-- ============================================================================ exchange (anon)
-- 4263 PR-5: answers the connection's scope. 4263 PR-10.7: records one notice when the connection turns active.
-- Intentionally callable by anon: OAuth token exchange for a registered client (portal secret checked inside)
CREATE OR REPLACE FUNCTION public.mcp_exchange_code(p_secret text, p_code_digest bytea, p_code_verifier text, p_client_id text, p_redirect_uri text,
                                                    p_resource text, p_at_digest bytea, p_rt_digest bytea)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = '' AS $fn$
DECLARE
  v_code   public.mcp_authorization_codes%ROWTYPE;
  v_used   public.mcp_authorization_codes%ROWTYPE;
  v_user   uuid;
  v_redir  text;
  v_pepper smallint;
  v_n      integer;
  v_scope  text;
BEGIN
  /*BODY:4263-10.7*/
  IF public._mcp_secret_ok(p_secret) IS NOT TRUE THEN
    RETURN public._mcp_refuse('invalid_grant');
  END IF;
  IF (octet_length(p_code_digest) = 32 AND octet_length(p_at_digest) = 32 AND octet_length(p_rt_digest) = 32
      AND p_at_digest IS DISTINCT FROM p_rt_digest) IS NOT TRUE THEN
    RETURN public._mcp_token_fail(p_client_id, 'invalid_request');
  END IF;

  -- token insert failure: everything in this block is rolled back (code not used up)
  BEGIN
  UPDATE public.mcp_authorization_codes k
     SET used_at = now()
   WHERE k.code_sha256 = sha256(p_code_digest)
     AND k.used_at IS NULL
     AND k.expires_at > now()
  RETURNING k.* INTO v_code;

  IF v_code.code_sha256 IS NULL THEN
    -- a used code presented again: the connection is removed only when the request is otherwise
    -- valid for that code (client, verifier, and redirect address when sent)
    SELECT k.* INTO v_used
      FROM public.mcp_authorization_codes k
     WHERE k.code_sha256 = sha256(p_code_digest)
       AND k.used_at IS NOT NULL;
    IF v_used.code_sha256 IS NOT NULL THEN
      SELECT c.user_id INTO v_user FROM public.mcp_connections c WHERE c.id = v_used.connection_id;
      IF (v_used.client_id = p_client_id
          AND (p_redirect_uri IS NULL OR v_used.redirect_uri = p_redirect_uri)
          AND p_code_verifier ~ '^[A-Za-z0-9._~-]{43,128}$'
          AND public._mcp_b64url(sha256(convert_to(p_code_verifier, 'UTF8'))) = v_used.code_challenge) IS TRUE THEN
        DELETE FROM public.mcp_connections c WHERE c.id = v_used.connection_id;
        INSERT INTO public.mcp_call_log (user_id, connection_id, event, outcome, ended_at)
        VALUES (v_user, v_used.connection_id, 'code_replay', 'ok', now());
      ELSIF public._mcp_bump('replay_refused:' || v_used.connection_id::text, interval '1 hour', 5) IS NOT DISTINCT FROM 'ok' THEN
        -- at most 5 refused-replay events per connection per hour; the response is the same either way
        INSERT INTO public.mcp_call_log (user_id, connection_id, event, outcome, ended_at)
        VALUES (v_user, v_used.connection_id, 'code_replay_refused', 'ok', now());
      END IF;
    END IF;
    RETURN public._mcp_token_fail(p_client_id, 'invalid_grant');
  END IF;

  -- a rejected redemption uses up the code and removes its pending connection
  IF (v_code.client_id = p_client_id
      AND (p_redirect_uri IS NULL OR v_code.redirect_uri = p_redirect_uri)
      AND v_code.resource = p_resource
      AND EXISTS (SELECT 1 FROM public.mcp_redirect_allowlist a WHERE a.redirect_uri = v_code.redirect_uri)
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
  RETURNING c.user_id, c.redirect_uri, c.scope INTO v_user, v_redir, v_scope;
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
    RAISE EXCEPTION USING ERRCODE = 'MC001', MESSAGE = 'mcp token insert failed';
  END;
  -- 4263 PR-10.7: one notice for the connection that just turned active, read later by the email job. In its own
  -- block: any error here discards the notice only; the exchange and its answer are unchanged.
  BEGIN
    INSERT INTO public.ai_app_connect_notices (user_id, provider, replaced)
    SELECT c.user_id, c.provider, v_n > 0 FROM public.mcp_connections c WHERE c.id = v_code.connection_id;   /*NOTICE:exchange*/
  EXCEPTION WHEN OTHERS THEN
    NULL;
  END;
  RETURN jsonb_build_object('ok', true, 'token_type', 'Bearer', 'expires_in', 3600, 'scope', v_scope);   /*SCOPE:exchange*/
  EXCEPTION WHEN SQLSTATE 'MC001' THEN
    RETURN public._mcp_token_fail(p_client_id, 'invalid_request');
  END;
END
$fn$;
REVOKE ALL ON FUNCTION public.mcp_exchange_code(text, bytea, text, text, text, text, bytea, bytea) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.mcp_exchange_code(text, bytea, text, text, text, text, bytea, bytea) TO anon;

-- ============================================================================ email job (service_role)
CREATE OR REPLACE FUNCTION public.ai_app_notice_claim(p_limit integer)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = '' AS $fn$
DECLARE
  v_rows jsonb;
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN   /*CALLER:claim*/
    RAISE EXCEPTION 'Unauthorized';
  END IF;
  UPDATE public.ai_app_connect_notices n
     SET status = 'skipped', last_error = 'stale', lease_until = NULL
   WHERE n.id IN (SELECT x.id FROM public.ai_app_connect_notices x
                   WHERE x.status = 'due' AND x.connected_at < now() - interval '2 days'   /*STALE:skip*/
                   LIMIT 500 FOR UPDATE SKIP LOCKED);
  UPDATE public.ai_app_connect_notices n
     SET status = 'failed', last_error = coalesce(n.last_error, 'attempts'), lease_until = NULL
   WHERE n.id IN (SELECT x.id FROM public.ai_app_connect_notices x
                   WHERE x.status = 'due' AND x.attempts >= 5 AND (x.lease_until IS NULL OR x.lease_until <= now())
                   LIMIT 500 FOR UPDATE SKIP LOCKED);
  DELETE FROM public.ai_app_connect_notices n
   WHERE n.id IN (SELECT x.id FROM public.ai_app_connect_notices x
                   WHERE x.status IN ('sent', 'queued', 'failed', 'skipped') AND x.connected_at < now() - interval '30 days'   /*KEEP:30d*/
                   LIMIT 500 FOR UPDATE SKIP LOCKED);
  WITH c AS (
    SELECT x.id FROM public.ai_app_connect_notices x
     WHERE x.status = 'due'
       AND x.attempts < 5   /*CAP:attempts*/
       AND (x.lease_until IS NULL OR x.lease_until <= now())   /*LEASE:free*/
       AND x.connected_at >= now() - interval '2 days'   /*STALE:claim*/
     ORDER BY x.connected_at, x.id
     LIMIT least(greatest(coalesce(p_limit, 0), 0), 50)   /*CAP:limit*/
     FOR UPDATE SKIP LOCKED),
  u AS (
    UPDATE public.ai_app_connect_notices n
       SET attempts = n.attempts + 1, lease_until = now() + interval '5 minutes'
      FROM c
     WHERE n.id = c.id
    RETURNING n.id, n.user_id, n.provider, n.replaced, n.connected_at, n.attempts)
  SELECT coalesce(jsonb_agg(jsonb_build_object('id', u.id, 'user_id', u.user_id, 'provider', u.provider, 'replaced', u.replaced,
                                               'connected_at', u.connected_at, 'attempts', u.attempts) ORDER BY u.connected_at, u.id), '[]'::jsonb)   /*KEYS:claim*/
    INTO v_rows
    FROM u;
  RETURN v_rows;
END
$fn$;
REVOKE ALL ON FUNCTION public.ai_app_notice_claim(integer) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.ai_app_notice_claim(integer) TO service_role;

CREATE OR REPLACE FUNCTION public.ai_app_notice_done(p_id uuid, p_attempts integer, p_status text, p_error text)
RETURNS boolean LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = '' AS $fn$
DECLARE
  v_n integer;
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN   /*CALLER:done*/
    RAISE EXCEPTION 'Unauthorized';
  END IF;
  IF (p_status IN ('due', 'sent', 'queued', 'failed', 'skipped')) IS NOT TRUE THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'ai_app_notice_done: unknown status';
  END IF;
  UPDATE public.ai_app_connect_notices n
     SET status = p_status,
         last_error = left(p_error, 40),   /*CUT:error*/
         lease_until = NULL,
         sent_at = CASE WHEN p_status IN ('sent', 'queued') THEN now() ELSE n.sent_at END
   WHERE n.id = p_id
     AND n.attempts = p_attempts   /*GUARD:attempts*/
     AND n.status = 'due';
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n = 1;
END
$fn$;
REVOKE ALL ON FUNCTION public.ai_app_notice_done(uuid, integer, text, text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.ai_app_notice_done(uuid, integer, text, text) TO service_role;

-- Post-check: bodies, attributes and grants of the three functions; the table closed; the anon-callable mcp count.
DO $post4263notice$
DECLARE v jsonb;
BEGIN
  SELECT jsonb_build_object(
    'exchange', (SELECT md5(p.prosrc) = '9a33bff2db31288bd77a57489558a65b' AND p.prosecdef AND array_to_string(p.proconfig, ',') = 'search_path=""'
                        AND has_function_privilege('anon', p.oid, 'EXECUTE') AND NOT has_function_privilege('authenticated', p.oid, 'EXECUTE')
                        AND NOT has_function_privilege('service_role', p.oid, 'EXECUTE')
                   FROM pg_catalog.pg_proc p WHERE p.oid = 'public.mcp_exchange_code(text,bytea,text,text,text,text,bytea,bytea)'::regprocedure),
    'jobs', (SELECT bool_and(p.prosecdef AND array_to_string(p.proconfig, ',') = 'search_path=""' AND p.proowner = 'postgres'::regrole::oid
                             AND has_function_privilege('service_role', p.oid, 'EXECUTE') AND NOT has_function_privilege('anon', p.oid, 'EXECUTE')
                             AND NOT has_function_privilege('authenticated', p.oid, 'EXECUTE')) AND count(*) = 2
               FROM pg_catalog.pg_proc p WHERE p.oid IN ('public.ai_app_notice_claim(integer)'::regprocedure,
                                                         'public.ai_app_notice_done(uuid,integer,text,text)'::regprocedure)),
    'table', (SELECT c.relrowsecurity AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_policy y WHERE y.polrelid = c.oid)
                     AND NOT has_table_privilege('anon', c.oid, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
                     AND NOT has_table_privilege('authenticated', c.oid, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
                     AND NOT has_table_privilege('service_role', c.oid, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
                FROM pg_catalog.pg_class c WHERE c.oid = 'public.ai_app_connect_notices'::regclass),
    'anon_mcp', (SELECT count(*) FROM pg_catalog.pg_proc p
                  WHERE p.pronamespace = 'public'::regnamespace AND p.proname ~ '^_?mcp_' AND has_function_privilege('anon', p.oid, 'EXECUTE')),
    'anon_jobs', (SELECT count(*) FROM pg_catalog.pg_proc p
                   WHERE p.pronamespace = 'public'::regnamespace AND p.proname ~ '^ai_app_' AND has_function_privilege('anon', p.oid, 'EXECUTE'))) INTO v;
  IF (v ->> 'exchange')::boolean IS NOT TRUE OR (v ->> 'jobs')::boolean IS NOT TRUE OR (v ->> 'table')::boolean IS NOT TRUE
     OR (v ->> 'anon_mcp')::int IS DISTINCT FROM 17 OR (v ->> 'anon_jobs')::int IS DISTINCT FROM 0 THEN
    RAISE EXCEPTION 'BACKLOG-4263: notice post-check failed: %', v;
  END IF;
END
$post4263notice$;
