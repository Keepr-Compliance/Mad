-- Rollback for BACKLOG-4209 (20261108180000). Restores _billing_reinstate_org(uuid,text,uuid)
-- (md5 9aeb774ad532a183c64df4b70e4820b6) and admin_reinstate_org(uuid,text)
-- (md5 3a92c28461f73f4e6ee7aa0102559126) with their grants, removes the new signatures and the
-- ledger row, then re-reads md5 AND proacl and raises on any mismatch. Run on its own; no
-- transaction control statements in this file. Revert the admin portal first: an admin build that
-- sends p_notify cannot reinstate against the old 2-arg function (PostgREST finds no match).

DO $guard$
DECLARE v_ri text; v_ad text;
BEGIN
  SELECT md5(prosrc) INTO v_ri FROM pg_proc WHERE oid = to_regprocedure('public._billing_reinstate_org(uuid,text,uuid,boolean)');
  SELECT md5(prosrc) INTO v_ad FROM pg_proc WHERE oid = to_regprocedure('public.admin_reinstate_org(uuid,text,boolean)');
  IF v_ri IS DISTINCT FROM '7ab5b46d84e7b3994eaf12f2becaee23' OR v_ad IS DISTINCT FROM 'b9b3d2704de93c62599da0d84bd45921' THEN
    RAISE EXCEPTION 'rollback-4209: new functions are at unknown bodies (% / %)', v_ri, v_ad;
  END IF;
END
$guard$;

CREATE OR REPLACE FUNCTION public._billing_reinstate_org(p_org uuid, p_note text, p_actor uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
  v_deal public.org_deals%ROWTYPE;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('billing_org:' || p_org::text, 0));
  SELECT * INTO v_deal FROM public.org_deals WHERE organization_id = p_org FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'no_deal');
  END IF;
  IF v_deal.stripe_mode = 'live' AND NOT public._billing_brokerage_live() THEN
    RETURN jsonb_build_object('success', false, 'error', 'billing_not_live');
  END IF;
  IF v_deal.status <> 'suspended' THEN
    RETURN jsonb_build_object('success', false, 'error', 'not_suspended', 'status', v_deal.status);
  END IF;

  UPDATE public.org_deals SET
    status = coalesce(status_before_suspension, 'active'),
    status_before_suspension = NULL,
    suspended_reason = NULL,
    suspended_note = NULL,
    suspended_at = NULL,
    suspended_by = NULL,
    updated_at = now(),
    updated_by = p_actor
  WHERE organization_id = p_org;

  PERFORM public._billing_apply_org_entitlement(p_org);

  INSERT INTO public.billing_change_log (organization_id, actor_id, action, detail)
  VALUES (p_org, p_actor, 'reinstated', jsonb_build_object('note', p_note, 'was_reason', v_deal.suspended_reason));
  RETURN jsonb_build_object('success', true);
END
$function$;
REVOKE ALL ON FUNCTION public._billing_reinstate_org(uuid, text, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public._billing_reinstate_org(uuid, text, uuid) TO service_role;

CREATE OR REPLACE FUNCTION public.admin_reinstate_org(p_org uuid, p_note text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
  v_uid uuid := auth.uid();
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '42501';
  END IF;
  IF NOT public.has_permission(v_uid, 'billing.suspend') THEN
    RAISE EXCEPTION 'Not authorized' USING ERRCODE = '42501';
  END IF;
  RETURN public._billing_reinstate_org(p_org, p_note, v_uid);
END
$function$;
REVOKE ALL ON FUNCTION public.admin_reinstate_org(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_reinstate_org(uuid, text) TO authenticated, service_role;

DROP FUNCTION IF EXISTS public.admin_reinstate_org(uuid, text, boolean);
DROP FUNCTION IF EXISTS public._billing_reinstate_org(uuid, text, uuid, boolean);

DELETE FROM supabase_migrations.schema_migrations WHERE version = '20261108180000';

DO $check$
DECLARE v_ri text; a_ri text; v_ad text; a_ad text;
BEGIN
  SELECT md5(prosrc), proacl::text INTO v_ri, a_ri FROM pg_proc WHERE oid = to_regprocedure('public._billing_reinstate_org(uuid,text,uuid)');
  SELECT md5(prosrc), proacl::text INTO v_ad, a_ad FROM pg_proc WHERE oid = to_regprocedure('public.admin_reinstate_org(uuid,text)');
  IF v_ri IS DISTINCT FROM '9aeb774ad532a183c64df4b70e4820b6' OR a_ri IS DISTINCT FROM '{postgres=X/postgres,service_role=X/postgres}' THEN
    RAISE EXCEPTION 'rollback-4209: _billing_reinstate_org md5 % acl %', v_ri, a_ri;
  END IF;
  IF v_ad IS DISTINCT FROM '3a92c28461f73f4e6ee7aa0102559126' OR a_ad IS DISTINCT FROM '{postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}' THEN
    RAISE EXCEPTION 'rollback-4209: admin_reinstate_org md5 % acl %', v_ad, a_ad;
  END IF;
  IF to_regprocedure('public._billing_reinstate_org(uuid,text,uuid,boolean)') IS NOT NULL
     OR to_regprocedure('public.admin_reinstate_org(uuid,text,boolean)') IS NOT NULL THEN
    RAISE EXCEPTION 'rollback-4209: new signatures still present';
  END IF;
  IF EXISTS (SELECT 1 FROM supabase_migrations.schema_migrations WHERE version = '20261108180000') THEN
    RAISE EXCEPTION 'rollback-4209: ledger row still present';
  END IF;
END
$check$;
