-- ============================================================================
-- Migration: mcp_authorize_view returns the request's age (BACKLOG-4263)
--
-- Replaces one function: public.mcp_authorize_view(text, bytea) (owner postgres, VOLATILE, SECURITY DEFINER, empty
-- search_path, EXECUTE authenticated only; all unchanged). No other object is created, changed or dropped.
--
-- The one change: the success answer has one more key, 'age_seconds', the whole seconds since the request was
-- created, measured on now() (the transaction time the expiry check uses) and never below 0. The body is otherwise
-- character-identical to the body of 20261118130000: the same nine keys with the same values, every refusal
-- unchanged (a refusal has no 'age_seconds'), the same signature and attributes. Grants restated as 20261118130000
-- states them.
--
-- Pre-check: the function is at the body of 20261118130000 (md5 a9b5a3de003671600e0033d7d952d804) or already at this
-- file's body (md5 18bd5cc8788ff45288733b57ce9d4d65); otherwise nothing is applied.
-- Post-check: body md5, owner, attributes and grants.
-- Re-runnable: CREATE OR REPLACE.
-- Rollback: supabase/tests/backlog-4263-age/rollback-20261118170000.sql
-- ============================================================================

DO $pre4263age$
DECLARE v_md5 text;
BEGIN
  SELECT md5(p.prosrc) INTO v_md5 FROM pg_catalog.pg_proc p
   WHERE p.oid = to_regprocedure('public.mcp_authorize_view(text,bytea)');
  IF v_md5 IS NULL OR v_md5 NOT IN ('a9b5a3de003671600e0033d7d952d804', '18bd5cc8788ff45288733b57ce9d4d65') THEN
    RAISE EXCEPTION 'BACKLOG-4263: public.mcp_authorize_view is not at the expected body (md5 %)', coalesce(v_md5, 'missing');
  END IF;
END
$pre4263age$;

CREATE OR REPLACE FUNCTION public.mcp_authorize_view(p_request_id text, p_browser_binding_sha256 bytea)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = '' AS $fn$
DECLARE
  v_uid   uuid := auth.uid();
  v_nonce text;
  v_req   public.mcp_authorization_requests%ROWTYPE;
  v_r     jsonb;
BEGIN
  /*BODY:4263-5*/
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
         consent_nonce_sha256 = sha256(convert_to(v_nonce, 'UTF8')),
         scope = public._mcp_granted_scope(r.scope)                                              /*SCOPE:view_store*/
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
           'scope', v_req.scope,                                                                  /*SCOPE:view*/
           'notice_version', s.notice_version,
           'nonce', v_nonce,
           'age_seconds', greatest(0, floor(extract(epoch FROM now() - v_req.created_at)))::int,
           'replaces_existing', EXISTS (SELECT 1 FROM public.mcp_connections x
                                         WHERE x.user_id = v_uid
                                           AND x.redirect_uri = v_req.redirect_uri
                                           AND x.status = 'active'))
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

-- Post-check: body, owner, attributes and grants of mcp_authorize_view.
DO $post4263age$
DECLARE r record;
BEGIN
  SELECT p.proowner = 'postgres'::regrole::oid AS is_owner, p.provolatile = 'v' AS is_volatile, p.prosecdef AS is_definer,
         array_to_string(p.proconfig, ',') = 'search_path=""' AS is_path,
         md5(p.prosrc) = '18bd5cc8788ff45288733b57ce9d4d65' AS is_body,
         p.proacl::text = '{postgres=X/postgres,authenticated=X/postgres}' AS is_acl,
         has_function_privilege('authenticated', p.oid, 'EXECUTE') AND NOT has_function_privilege('anon', p.oid, 'EXECUTE')
           AND NOT has_function_privilege('service_role', p.oid, 'EXECUTE') AS is_grants
    INTO r FROM pg_catalog.pg_proc p WHERE p.oid = 'public.mcp_authorize_view(text,bytea)'::regprocedure;
  IF NOT (r.is_owner AND r.is_volatile AND r.is_definer AND r.is_path AND r.is_body AND r.is_acl AND r.is_grants) THEN
    RAISE EXCEPTION 'BACKLOG-4263: mcp_authorize_view post-check failed: %', to_jsonb(r);
  END IF;
END
$post4263age$;
