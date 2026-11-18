-- apply-20261118140000.sql: the migration verbatim, its ledger row, and a post-check. One transaction.
-- Migration: supabase/migrations/20261118140000_backlog_4263_mcp_connection_scope.sql  file md5 b1753cc8062a6899b9dba24f21441cc7
-- If the apply tool writes the ledger row itself, remove the INSERT below.
-- The post-check RAISEs (rolling everything back) unless: the body is at md5 7a415b5e31c52c4636be29c08fb27565; it is SECURITY DEFINER;
-- EXECUTE is held by authenticated and NOT by anon, service_role or PUBLIC; the anon-callable mcp functions are
-- still exactly 15; the ledger row exists.

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

INSERT INTO supabase_migrations.schema_migrations (version, name, statements)
VALUES ('20261118140000', 'backlog_4263_mcp_connection_scope', ARRAY[]::text[]);

DO $post4263p6$
DECLARE v jsonb;
BEGIN
  SELECT jsonb_build_object(
    'body_md5', (SELECT md5(p.prosrc) FROM pg_proc p WHERE p.oid = to_regprocedure('public.mcp_list_my_connections()')),
    'security_definer', (SELECT p.prosecdef FROM pg_proc p WHERE p.oid = to_regprocedure('public.mcp_list_my_connections()')),
    'anon', has_function_privilege('anon', 'public.mcp_list_my_connections()'::regprocedure, 'EXECUTE'),
    'service_role', has_function_privilege('service_role', 'public.mcp_list_my_connections()'::regprocedure, 'EXECUTE'),
    'authenticated', has_function_privilege('authenticated', 'public.mcp_list_my_connections()'::regprocedure, 'EXECUTE'),
    'public_acl', (SELECT coalesce(bool_or(a.grantee = 0), false) FROM pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
                    WHERE p.oid = to_regprocedure('public.mcp_list_my_connections()') AND a.privilege_type = 'EXECUTE'),
    'anon_mcp', (SELECT count(*) FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname ~ '^_?mcp_'
                   AND has_function_privilege('anon', p.oid, 'EXECUTE')),
    'ledger', (SELECT count(*) FROM supabase_migrations.schema_migrations WHERE version = '20261118140000')) INTO v;
  IF v ->> 'body_md5' IS DISTINCT FROM '7a415b5e31c52c4636be29c08fb27565' OR (v ->> 'security_definer')::boolean IS NOT TRUE
     OR (v ->> 'anon')::boolean OR (v ->> 'service_role')::boolean OR (v ->> 'authenticated')::boolean IS NOT TRUE
     OR (v ->> 'public_acl')::boolean OR (v ->> 'anon_mcp')::int <> 15 OR (v ->> 'ledger')::int <> 1 THEN
    RAISE EXCEPTION 'APPLY POST-CHECK 20261118140000 FAILED, nothing applied: %', v;
  END IF;
  RAISE NOTICE 'APPLY POST-CHECK 20261118140000 OK: %', v;
END
$post4263p6$;
