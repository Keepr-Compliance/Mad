-- rollback-20261118140000.sql: undoes supabase/migrations/20261118140000_backlog_4263_mcp_connection_scope.sql.
-- One transaction; RAISEs (nothing changed) unless the body is the one 20261118140000 wrote (md5 7a415b5e31c52c4636be29c08fb27565).
-- Puts back the 20261112170000 body verbatim (md5 55da44d56f11890f938b4718a47e0475) and its grants, and removes the ledger row.
-- A portal that requires 'scope' does not exist: the PR-6 portal accepts the answer without it, so rolling back
-- needs no portal change (the "Allowed" line is simply not shown).
DO $pre4263p6r$
DECLARE v_md5 text;
BEGIN
  SELECT md5(p.prosrc) INTO v_md5 FROM pg_proc p WHERE p.oid = to_regprocedure('public.mcp_list_my_connections()');
  IF v_md5 IS DISTINCT FROM '7a415b5e31c52c4636be29c08fb27565' THEN
    RAISE EXCEPTION 'ROLLBACK 20261118140000: public.mcp_list_my_connections() is not at the body 20261118140000 wrote (md5 %)', coalesce(v_md5, 'missing');
  END IF;
END
$pre4263p6r$;

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
DELETE FROM supabase_migrations.schema_migrations WHERE version = '20261118140000';

DO $post4263p6r$
BEGIN
  IF (SELECT md5(p.prosrc) FROM pg_proc p WHERE p.oid = to_regprocedure('public.mcp_list_my_connections()')) IS DISTINCT FROM '55da44d56f11890f938b4718a47e0475'
     OR has_function_privilege('anon', 'public.mcp_list_my_connections()'::regprocedure, 'EXECUTE')
     OR has_function_privilege('service_role', 'public.mcp_list_my_connections()'::regprocedure, 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.mcp_list_my_connections()'::regprocedure, 'EXECUTE')
     OR EXISTS (SELECT 1 FROM supabase_migrations.schema_migrations WHERE version = '20261118140000') THEN
    RAISE EXCEPTION 'ROLLBACK POST-CHECK 20261118140000 FAILED, nothing changed';
  END IF;
  RAISE NOTICE 'ROLLBACK POST-CHECK 20261118140000 OK';
END
$post4263p6r$;
