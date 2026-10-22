-- BACKLOG-4012 rollback (keepr-test; production only if the migration was applied there).
-- Run it BEFORE any BACKLOG-4007 rollback: rollback-4007-pr1.sql drops _billing_org_setup_pending,
-- the function this file restores.
-- Restores the 4007 PR-1 body of _billing_org_setup_pending verbatim (grants are kept by
-- CREATE OR REPLACE), drops only the objects 20261020160000 added, and deletes its ledger row.
-- Effect: JIT is unavailable again (no 2-arg function), and IdP joins into a waiting brokerage are
-- no longer refused.
BEGIN;

CREATE OR REPLACE FUNCTION public._billing_org_setup_pending(p_org uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO ''
AS $function$
  SELECT EXISTS (SELECT 1 FROM public.org_deals d
                  WHERE d.organization_id = p_org AND d.status = 'draft')
     AND EXISTS (SELECT 1 FROM public.organization_members m
                  WHERE m.organization_id = p_org AND m.user_id = auth.uid())
$function$;

DROP TRIGGER IF EXISTS _billing_guard_idp_join_while_setup_pending ON public.organization_members;
DROP FUNCTION IF EXISTS public._billing_guard_idp_join_while_setup_pending();
DROP FUNCTION IF EXISTS public.jit_join_organization(text, text);
DROP FUNCTION IF EXISTS public._org_feature_allowed(uuid, text);
DROP FUNCTION IF EXISTS public._billing_org_join_blocked(uuid);

DELETE FROM supabase_migrations.schema_migrations WHERE version = '20261020160000';

DO $chk$
BEGIN
  IF (SELECT md5(prosrc) FROM pg_proc WHERE oid = to_regprocedure('public._billing_org_setup_pending(uuid)'))
     IS DISTINCT FROM '5dd851c60b811825d10ab0f120a75228' THEN
    RAISE EXCEPTION '4012 rollback: _billing_org_setup_pending is not the 4007 PR-1 body';
  END IF;
END $chk$;

COMMIT;
