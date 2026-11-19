-- ============================================================================
-- Migration: bounds on AI-app registration and token refresh, and a daily cleanup of unused app registrations
-- (BACKLOG-4263 PR-10.4)
--
-- Replaced (pre-check below), both anon, portal secret still checked first, grants restated:
--   mcp_register_client: the hourly bound per hashed address (reg_ip, 60) is unchanged; a daily bound per hashed
--     address is added (reg_ip_day, 200, checked after reg_ip); the global daily bound (reg_all) is raised from 500 to
--     5,000. Same counter helper, same refusal. The body is otherwise character-identical to 20261112170000.
--   mcp_refresh: at most 60 refreshes per connection per hour (refresh_conn:<connection id>), counted only when the
--     presented refresh token is valid. Over the bound the answer is {"ok":false,"error":"rate_limited"}, no token is
--     issued and the presented refresh token stays unused. Every other answer is unchanged. The body is otherwise
--     character-identical to 20261118130000.
-- New: _mcp_prune_unused_clients(), SECURITY DEFINER, owner postgres, no API role may execute it, run daily by pg_cron
--   (job mcp-unused-client-prune, 03:53 UTC, as postgres). It deletes an mcp_oauth_clients row only when the row was
--   created more than 30 days ago and no mcp_connections row (any status) and no mcp_authorization_requests row (any
--   status) names it; at most 500 per run; each candidate is locked FOR UPDATE SKIP LOCKED and the conditions are
--   checked again in a separate statement before the delete. It deletes nothing when any other table has a foreign key
--   to mcp_oauth_clients. Answers the number deleted.
-- Existing rows: none changed by this file.
-- Requires: the pg_cron extension (created by 20261118110000); otherwise nothing is applied.
-- Locks: lock_timeout 3s before the first replaced function; if a lock is not obtained within 3 seconds the migration
--   fails and nothing is applied.
-- Pre-check: mcp_register_client is at md5 27326378a7ca849f4a116f6b46e1767e (20261112170000) or ac3e98941cd2f5ef50a16d6409438fb4 (this file);
--   mcp_refresh is at md5 a7797a967b1952dec493c48c62328530 (20261118130000) or 912c6e001271b289c7a8c929492b4ac9 (this file); otherwise nothing is applied.
-- Re-runnable: CREATE OR REPLACE; cron.schedule by name replaces the job.
-- Rollback: supabase/tests/backlog-4263-bounds/rollback-20261118190000.sql (run it before any rollback of
--   20261118130000 or 20261112170000).
-- ============================================================================

DO $pre4263bounds$
DECLARE v_r text; v_f text;
BEGIN
  SELECT md5(p.prosrc) INTO v_r FROM pg_catalog.pg_proc p WHERE p.oid = to_regprocedure('public.mcp_register_client(text,text,text,text[],bytea)');
  SELECT md5(p.prosrc) INTO v_f FROM pg_catalog.pg_proc p WHERE p.oid = to_regprocedure('public.mcp_refresh(text,bytea,text,text,bytea,bytea)');
  IF v_r IS NULL OR v_r NOT IN ('27326378a7ca849f4a116f6b46e1767e', 'ac3e98941cd2f5ef50a16d6409438fb4') THEN
    RAISE EXCEPTION 'BACKLOG-4263: public.mcp_register_client is not at the expected body (md5 %)', coalesce(v_r, 'missing');
  END IF;
  IF v_f IS NULL OR v_f NOT IN ('a7797a967b1952dec493c48c62328530', '912c6e001271b289c7a8c929492b4ac9') THEN
    RAISE EXCEPTION 'BACKLOG-4263: public.mcp_refresh is not at the expected body (md5 %)', coalesce(v_f, 'missing');
  END IF;
  IF to_regclass('cron.job') IS NULL THEN
    RAISE EXCEPTION 'BACKLOG-4263: pg_cron is not installed';
  END IF;
END
$pre4263bounds$;

SET LOCAL lock_timeout = '3s';

-- ============================================================================ registration (anon)
-- Order: secret, enabled, arguments, redirect allow-list, then the counters: a refused request
-- adds to no counter. 4263 PR-10.4: reg_ip_day added, reg_all raised to 5,000.
-- Intentionally callable by anon: OAuth dynamic client registration
CREATE OR REPLACE FUNCTION public.mcp_register_client(p_secret text, p_client_id text, p_client_name text, p_redirect_uris text[], p_ip_sha256 bytea)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = '' AS $fn$
DECLARE
  v_b text;
BEGIN
  /*BODY:4263-10.4-register*/
  IF public._mcp_secret_ok(p_secret) IS NOT TRUE THEN
    RETURN public._mcp_refuse('invalid_client_metadata');
  END IF;
  IF (SELECT s.enabled FROM public.mcp_settings s WHERE s.id) IS NOT TRUE THEN
    RETURN public._mcp_refuse('busy');
  END IF;
  IF (octet_length(p_ip_sha256) = 32) IS NOT TRUE THEN
    RETURN public._mcp_refuse('invalid_client_metadata');
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
  v_b := public._mcp_bump('reg_ip:' || encode(p_ip_sha256, 'hex'), interval '1 hour', 60);
  IF v_b IS NOT DISTINCT FROM 'ok' THEN
    v_b := public._mcp_bump('reg_ip_day:' || encode(p_ip_sha256, 'hex'), interval '1 day', 200);   /*BOUND:reg_ip_day*/
  END IF;
  IF v_b IS NOT DISTINCT FROM 'ok' THEN
    v_b := public._mcp_bump('reg_all', interval '1 day', 5000);   /*BOUND:reg_all*/
  END IF;
  IF v_b IS DISTINCT FROM 'ok' THEN
    RETURN public._mcp_refuse(coalesce(v_b, 'busy'));
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

-- ============================================================================ refresh (anon)
-- 4263 PR-5: answers the connection's scope; a refresh never changes it. 4263 PR-10.4: refresh_conn bound.
-- Intentionally callable by anon: OAuth refresh token grant for a registered client (portal secret checked inside)
CREATE OR REPLACE FUNCTION public.mcp_refresh(p_secret text, p_rt_digest bytea, p_client_id text, p_resource text, p_new_at_digest bytea, p_new_rt_digest bytea)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = '' AS $fn$
DECLARE
  v_conn   uuid;
  v_user   uuid;
  v_pepper smallint;
  v_scope  text;
BEGIN
  /*BODY:4263-10.4-refresh*/
  IF public._mcp_secret_ok(p_secret) IS NOT TRUE THEN
    RETURN public._mcp_refuse('invalid_grant');
  END IF;
  IF (octet_length(p_rt_digest) = 32 AND octet_length(p_new_at_digest) = 32 AND octet_length(p_new_rt_digest) = 32
      AND p_new_at_digest IS DISTINCT FROM p_new_rt_digest) IS NOT TRUE THEN
    RETURN public._mcp_token_fail(p_client_id, 'invalid_request');
  END IF;

  -- token insert failure: everything in this block is rolled back (the presented token stays unused)
  BEGIN
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
  RETURNING t.connection_id, c.user_id, s.pepper_version, c.scope INTO v_conn, v_user, v_pepper, v_scope;

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

  -- 4263 PR-10.4: at most 60 refreshes per connection per hour. Over the bound this block is rolled back: no token
  -- is issued and the presented refresh token stays unused.
  IF public._mcp_bump('refresh_conn:' || v_conn::text, interval '1 hour', 60) IS DISTINCT FROM 'ok' THEN   /*BOUND:refresh_conn*/
    RAISE EXCEPTION USING ERRCODE = 'MC003', MESSAGE = 'mcp refresh bound reached';
  END IF;

  BEGIN
    INSERT INTO public.mcp_tokens (token_sha256, connection_id, kind, pepper_version, expires_at) VALUES
      (sha256(p_new_at_digest), v_conn, 'access', v_pepper, now() + interval '1 hour'),
      (sha256(p_new_rt_digest), v_conn, 'refresh', v_pepper, now() + interval '30 days');
  EXCEPTION WHEN unique_violation OR not_null_violation THEN
    RAISE EXCEPTION USING ERRCODE = 'MC001', MESSAGE = 'mcp token insert failed';
  END;
  DELETE FROM public.mcp_tokens o
   WHERE o.connection_id = v_conn AND o.expires_at < now() - interval '1 day';
  RETURN jsonb_build_object('ok', true, 'token_type', 'Bearer', 'expires_in', 3600, 'scope', v_scope);   /*SCOPE:refresh*/
  EXCEPTION WHEN SQLSTATE 'MC001' THEN
    RETURN public._mcp_token_fail(p_client_id, 'invalid_request');
  WHEN SQLSTATE 'MC003' THEN
    RETURN public._mcp_refuse('rate_limited');   /*REFUSE:refresh_conn*/
  END;
END
$fn$;
REVOKE ALL ON FUNCTION public.mcp_refresh(text, bytea, text, text, bytea, bytea) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.mcp_refresh(text, bytea, text, text, bytea, bytea) TO anon;

-- ============================================================================ cleanup (pg_cron only)
CREATE OR REPLACE FUNCTION public._mcp_prune_unused_clients()
RETURNS integer LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = '' AS $fn$
DECLARE
  v_id   text;
  v_lock text;
  v_d    integer;
  v_n    integer := 0;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_constraint k
              WHERE k.contype = 'f' AND k.confrelid = 'public.mcp_oauth_clients'::regclass
                AND k.conrelid NOT IN ('public.mcp_connections'::regclass, 'public.mcp_authorization_requests'::regclass)) THEN   /*GUARD:children*/
    RETURN 0;
  END IF;
  FOR v_id IN
    SELECT k.client_id FROM public.mcp_oauth_clients k
     WHERE k.created_at < now() - interval '30 days'   /*AGE:select*/
       AND NOT EXISTS (SELECT 1 FROM public.mcp_connections c WHERE c.client_id = k.client_id)   /*SELECT:connections*/
       AND NOT EXISTS (SELECT 1 FROM public.mcp_authorization_requests r WHERE r.client_id = k.client_id)   /*SELECT:requests*/
     ORDER BY k.created_at, k.client_id
     LIMIT 500   /*CAP:run*/
  LOOP
    v_lock := NULL;
    SELECT k.client_id INTO v_lock FROM public.mcp_oauth_clients k
     WHERE k.client_id = v_id
       FOR UPDATE SKIP LOCKED;   /*LOCK:client*/
    CONTINUE WHEN v_lock IS NULL;
    DELETE FROM public.mcp_oauth_clients k
     WHERE k.client_id = v_lock
       AND k.created_at < now() - interval '30 days'   /*AGE:recheck*/
       AND NOT EXISTS (SELECT 1 FROM public.mcp_connections c WHERE c.client_id = k.client_id)   /*RECHECK:connections*/
       AND NOT EXISTS (SELECT 1 FROM public.mcp_authorization_requests r WHERE r.client_id = k.client_id);   /*RECHECK:requests*/
    GET DIAGNOSTICS v_d = ROW_COUNT;
    v_n := v_n + v_d;
  END LOOP;
  RETURN v_n;
END
$fn$;
REVOKE ALL ON FUNCTION public._mcp_prune_unused_clients() FROM PUBLIC, anon, authenticated, service_role;

-- Daily at 03:53 UTC, as the database owner. Stop: SELECT cron.unschedule('mcp-unused-client-prune');
DO $cron4263bounds$
BEGIN
  PERFORM cron.schedule('mcp-unused-client-prune', '53 3 * * *', 'SELECT public._mcp_prune_unused_clients()');
END
$cron4263bounds$;

-- Post-check: bodies, attributes and grants of the three functions; the tables with a foreign key to
-- mcp_oauth_clients are exactly the two the cleanup checks; the anon-callable mcp functions are exactly the 17 named;
-- the cron job exists once with this schedule and command, active, as postgres.
DO $post4263bounds$
DECLARE v jsonb;
BEGIN
  SELECT jsonb_build_object(
    'register', (SELECT md5(p.prosrc) = 'ac3e98941cd2f5ef50a16d6409438fb4' AND p.prosecdef AND array_to_string(p.proconfig, ',') = 'search_path=""'
                        AND has_function_privilege('anon', p.oid, 'EXECUTE') AND NOT has_function_privilege('authenticated', p.oid, 'EXECUTE')
                        AND NOT has_function_privilege('service_role', p.oid, 'EXECUTE')
                   FROM pg_catalog.pg_proc p WHERE p.oid = 'public.mcp_register_client(text,text,text,text[],bytea)'::regprocedure),
    'refresh', (SELECT md5(p.prosrc) = '912c6e001271b289c7a8c929492b4ac9' AND p.prosecdef AND array_to_string(p.proconfig, ',') = 'search_path=""'
                       AND has_function_privilege('anon', p.oid, 'EXECUTE') AND NOT has_function_privilege('authenticated', p.oid, 'EXECUTE')
                       AND NOT has_function_privilege('service_role', p.oid, 'EXECUTE')
                  FROM pg_catalog.pg_proc p WHERE p.oid = 'public.mcp_refresh(text,bytea,text,text,bytea,bytea)'::regprocedure),
    'prune', (SELECT md5(p.prosrc) = '62843f08da0c36a7214698a9c0476c69' AND p.prosecdef AND p.provolatile = 'v' AND p.proowner = 'postgres'::regrole::oid
                     AND array_to_string(p.proconfig, ',') = 'search_path=""'
                     AND (SELECT array_agg(DISTINCT a.grantee::regrole::text) FROM aclexplode(p.proacl) a) = ARRAY['postgres']
                FROM pg_catalog.pg_proc p WHERE p.oid = 'public._mcp_prune_unused_clients()'::regprocedure),
    'children', (SELECT array_agg(c.relnamespace::regnamespace::text || '.' || c.relname::text ORDER BY c.relname::text COLLATE "C")
                   FROM pg_catalog.pg_constraint k JOIN pg_catalog.pg_class c ON c.oid = k.conrelid
                  WHERE k.contype = 'f' AND k.confrelid = 'public.mcp_oauth_clients'::regclass)
                = ARRAY['public.mcp_authorization_requests', 'public.mcp_connections'],
    'cron', (SELECT count(*) FROM cron.job j WHERE j.jobname = 'mcp-unused-client-prune') = 1
            AND EXISTS (SELECT 1 FROM cron.job j WHERE j.jobname = 'mcp-unused-client-prune' AND j.schedule = '53 3 * * *'
                           AND j.command = 'SELECT public._mcp_prune_unused_clients()' AND j.username = 'postgres' AND j.active
                           AND j.database = current_database()),
    'anon_mcp', (SELECT coalesce(array_agg(x.sig ORDER BY x.sig COLLATE "C"), '{}')
                   FROM (SELECT p.proname::text || '(' || replace(pg_catalog.oidvectortypes(p.proargtypes), ', ', ',') || ')' AS sig
                           FROM pg_catalog.pg_proc p
                          WHERE p.pronamespace = 'public'::regnamespace AND p.proname ~ '^_?mcp_' AND has_function_privilege('anon', p.oid, 'EXECUTE')) x)
                = ARRAY['mcp_add_todo(text,bytea,text,text,text,text,text,text)',
                 'mcp_authorize_begin(text,text,text,text,text,text,text,text,bytea,bytea)',
                 'mcp_check_access(text,bytea,text)',
                 'mcp_exchange_code(text,bytea,text,text,text,text,bytea,bytea)',
                 'mcp_find_people(text,bytea,text,text,text,text,text,text,text)',
                 'mcp_get_deal(text,bytea,text,text)',
                 'mcp_get_deal_checklists(text,bytea,text,text,boolean,text)',
                 'mcp_get_status(text,bytea,text)',
                 'mcp_list_all_deals(text,bytea,text,text,text,text,text)',
                 'mcp_list_deals(text,bytea,text,text,text,integer,text)',
                 'mcp_list_todos(text,bytea,text,text,text,text,text,boolean,boolean,text)',
                 'mcp_refresh(text,bytea,text,text,bytea,bytea)',
                 'mcp_register_client(text,text,text,text[],bytea)',
                 'mcp_remove_todo(text,bytea,text,text,text)',
                 'mcp_restore_todo(text,bytea,text,text,text)',
                 'mcp_update_todo(text,bytea,text,text,jsonb,text)',
                 'mcp_write_access(text,bytea,text)']::text[]) INTO v;
  IF (v ->> 'register')::boolean IS NOT TRUE OR (v ->> 'refresh')::boolean IS NOT TRUE OR (v ->> 'prune')::boolean IS NOT TRUE
     OR (v ->> 'children')::boolean IS NOT TRUE OR (v ->> 'cron')::boolean IS NOT TRUE OR (v ->> 'anon_mcp')::boolean IS NOT TRUE THEN
    RAISE EXCEPTION 'BACKLOG-4263: bounds post-check failed: %', v;
  END IF;
END
$post4263bounds$;
