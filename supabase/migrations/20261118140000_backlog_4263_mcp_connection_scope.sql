-- ============================================================================
-- Migration: AI-app connections list the scope each one was granted (BACKLOG-4263 PR-6)
--
-- Replaced: mcp_list_my_connections() (20261112170000 :943-962). The ONLY change: each connection also carries
--   'scope', the stored mcp_connections.scope ('mcp:read' or 'mcp:todos', set once at consent; 20261118130000).
--   It is not recomputed: whether a connection can change todos right now ALSO needs the write switch, which the
--   portal page does not show ("Allowed" is the grant).
-- Caller check unchanged: auth.uid() IS NULL -> not_signed_in; rows WHERE user_id = auth.uid() AND status = 'active'.
-- Grants restated on the full signature: EXECUTE for authenticated only (PUBLIC, anon, service_role revoked).
-- Order: the portal that accepts the answer with or without 'scope' (BACKLOG-4263 PR-6) is deployed FIRST. A portal
--   built before it checks the exact key set and reads the new answer as a failure ("could not load"): never apply
--   this file ahead of that deploy.
-- Pre-check: the body this replaces is the traced one (md5 55da44d56f11890f938b4718a47e0475); otherwise nothing changes.
-- Rollback: supabase/tests/backlog-4263-pr6/rollback-20261118140000.sql.
-- ============================================================================
DO $pre4263p6$
DECLARE v_md5 text;
BEGIN
  SELECT md5(p.prosrc) INTO v_md5 FROM pg_proc p WHERE p.oid = to_regprocedure('public.mcp_list_my_connections()');
  IF v_md5 IS DISTINCT FROM '55da44d56f11890f938b4718a47e0475' THEN
    RAISE EXCEPTION '20261118140000: public.mcp_list_my_connections() is not the traced body (md5 %)', coalesce(v_md5, 'missing');
  END IF;
END
$pre4263p6$;

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
             'last_used_at', c.last_used_at,
             'scope', c.scope) ORDER BY c.consented_at DESC)
      FROM public.mcp_connections c
     WHERE c.user_id = v_uid AND c.status = 'active'), '[]'::jsonb));
END
$fn$;
REVOKE ALL ON FUNCTION public.mcp_list_my_connections() FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.mcp_list_my_connections() TO authenticated;
