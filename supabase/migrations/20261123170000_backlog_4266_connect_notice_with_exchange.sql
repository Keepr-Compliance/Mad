-- ============================================================================
-- Migration: the AI-app connect notice is written with the exchange or the exchange fails (BACKLOG-4266)
--
-- Replaced: mcp_exchange_code (anon, portal secret checked first, as before). The one change: the INSERT into
--   public.ai_app_connect_notices is no longer in its own BEGIN ... EXCEPTION block. It runs in the exchange's
--   transaction, and the exchange then checks that it wrote exactly one row; otherwise it raises MC004. An error in the
--   INSERT, or no row, therefore ends the call with an error: the code stays unused, the connection stays pending, the
--   earlier connection is kept, and no token and no notice are stored. The portal answers that call with 503
--   temporarily_unavailable. Every other line of the body is character-identical to the body of 20261118180000 (the
--   marker comment and one declared variable, v_k, aside). Signature, owner, SECURITY DEFINER, search_path and grants
--   are unchanged.
-- Existing rows: none changed.
-- Locks: CREATE OR REPLACE FUNCTION locks the function's pg_proc row until commit; lock_timeout 3s, so if a lock is not
--   obtained within 3 seconds the migration fails and nothing is applied.
-- Pre-check: mcp_exchange_code is at the body of 20261118180000 (md5 9a33bff2db31288bd77a57489558a65b) or already at this file's body
--   (md5 cc2810ee59467829f60d2a9e61455b6c); otherwise nothing is applied.
-- Re-runnable: CREATE OR REPLACE.
-- Rollback: supabase/tests/backlog-4266/rollback-20261123170000.sql (puts back the 20261118180000 body).
-- ============================================================================

SET LOCAL lock_timeout = '3s';

DO $pre4266$
DECLARE v_md5 text;
BEGIN
  SELECT md5(p.prosrc) INTO v_md5 FROM pg_catalog.pg_proc p
   WHERE p.oid = to_regprocedure('public.mcp_exchange_code(text,bytea,text,text,text,text,bytea,bytea)');
  IF v_md5 IS NULL OR v_md5 NOT IN ('9a33bff2db31288bd77a57489558a65b', 'cc2810ee59467829f60d2a9e61455b6c') THEN
    RAISE EXCEPTION 'BACKLOG-4266: public.mcp_exchange_code is not at the expected body (md5 %)', coalesce(v_md5, 'missing');
  END IF;
END
$pre4266$;

-- ============================================================================ exchange (anon)
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
  v_k      integer;
BEGIN
  /*BODY:4266*/
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
  -- 4266: one notice for the connection that just turned active, read later by the email job. Written in the same
  -- transaction as the tokens; exactly one row or the exchange raises MC004 and nothing of it is kept.
  INSERT INTO public.ai_app_connect_notices (user_id, provider, replaced)
  SELECT c.user_id, c.provider, v_n > 0 FROM public.mcp_connections c WHERE c.id = v_code.connection_id;   /*NOTICE:exchange*/
  GET DIAGNOSTICS v_k = ROW_COUNT;
  IF v_k IS DISTINCT FROM 1 THEN   /*NOTICE:count*/
    RAISE EXCEPTION USING ERRCODE = 'MC004', MESSAGE = 'mcp connect notice not written';
  END IF;
  RETURN jsonb_build_object('ok', true, 'token_type', 'Bearer', 'expires_in', 3600, 'scope', v_scope);   /*SCOPE:exchange*/
  EXCEPTION WHEN SQLSTATE 'MC001' THEN
    RETURN public._mcp_token_fail(p_client_id, 'invalid_request');
  END;
END
$fn$;
REVOKE ALL ON FUNCTION public.mcp_exchange_code(text, bytea, text, text, text, text, bytea, bytea) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.mcp_exchange_code(text, bytea, text, text, text, text, bytea, bytea) TO anon;


-- Post-check: the body, attributes, owner and grants of the exchange; the notice table's owner and RLS; the provider CHECK
-- of ai_app_connect_notices equal to that of mcp_connections.
DO $post4266$
DECLARE v jsonb;
BEGIN
  SELECT jsonb_build_object(
    'exchange', (SELECT md5(p.prosrc) = 'cc2810ee59467829f60d2a9e61455b6c' AND p.prosecdef AND p.provolatile = 'v'
                        AND array_to_string(p.proconfig, ',') = 'search_path=""' AND p.proowner = 'postgres'::regrole::oid
                        AND (SELECT array_agg(DISTINCT a.grantee::regrole::text ORDER BY a.grantee::regrole::text) FROM aclexplode(p.proacl) a
                              WHERE a.privilege_type = 'EXECUTE') = ARRAY['anon', 'postgres']
                        AND NOT EXISTS (SELECT 1 FROM aclexplode(p.proacl) a WHERE a.grantee = 0)
                   FROM pg_catalog.pg_proc p WHERE p.oid = 'public.mcp_exchange_code(text,bytea,text,text,text,text,bytea,bytea)'::regprocedure),
    'table', (SELECT c.relowner = 'postgres'::regrole::oid AND c.relrowsecurity AND NOT c.relforcerowsecurity
                     AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_trigger t WHERE t.tgrelid = c.oid AND NOT t.tgisinternal)
                FROM pg_catalog.pg_class c WHERE c.oid = 'public.ai_app_connect_notices'::regclass),
    -- every provider a connection can have passes the notice table's provider CHECK: the two definitions are equal
    'provider_check_notices', (SELECT string_agg(pg_catalog.pg_get_constraintdef(k.oid)::text, ' & ' ORDER BY pg_catalog.pg_get_constraintdef(k.oid)::text)
                     FROM pg_catalog.pg_constraint k WHERE k.conrelid = 'public.ai_app_connect_notices'::regclass AND k.contype = 'c'
                      AND k.conkey = ARRAY[(SELECT a.attnum FROM pg_catalog.pg_attribute a WHERE a.attrelid = k.conrelid AND a.attname = 'provider')]::smallint[]),
    'provider_check_connections', (SELECT string_agg(pg_catalog.pg_get_constraintdef(k.oid)::text, ' & ' ORDER BY pg_catalog.pg_get_constraintdef(k.oid)::text)
                     FROM pg_catalog.pg_constraint k WHERE k.conrelid = 'public.mcp_connections'::regclass AND k.contype = 'c'
                      AND k.conkey = ARRAY[(SELECT a.attnum FROM pg_catalog.pg_attribute a WHERE a.attrelid = k.conrelid AND a.attname = 'provider')]::smallint[])) INTO v;
  IF (v ->> 'exchange')::boolean IS NOT TRUE OR (v ->> 'table')::boolean IS NOT TRUE
     OR v ->> 'provider_check_notices' IS NULL OR v ->> 'provider_check_notices' IS DISTINCT FROM v ->> 'provider_check_connections' THEN
    RAISE EXCEPTION 'BACKLOG-4266: post-check failed: %', v;
  END IF;
END
$post4266$;
