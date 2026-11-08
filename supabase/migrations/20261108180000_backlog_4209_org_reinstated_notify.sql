-- BACKLOG-4209: email the billing contact when a suspended brokerage is reinstated.
--
-- 1. public._billing_reinstate_org gains p_notify boolean DEFAULT true (4th). The 3-arg version is
--    REPLACED, not overloaded (removed below). _billing_auto_reinstate is unchanged; its 3-arg call
--    resolves through the default, so the automatic reinstate after a payment emails too.
--    p_notify NULL -> invalid_request, nothing written.
-- 2. public.admin_reinstate_org gains p_notify boolean DEFAULT true (the staff dialog's "Email the
--    billing contact"), passed through. The 2-arg version is REPLACED (removed below).
-- 3. One billing_outbox row per lifted suspension when p_notify AND the deal has a billing contact
--    email AND suspended_at is set: kind notify_org_reinstated, dedupe key
--    'notify_org_reinstated:<mode>:<org>:<epoch of suspended_at>', payload
--    {organization_id, suspended_at_epoch, via}. via = 'staff' (actor set) or 'auto' (actor NULL).
-- 4. Every 'reinstated' change-log row records detail.suspended_at_epoch, via and notified.
--
-- Guard: each function must be at its known body (md5 of prosrc) before the change, or already at
-- this migration's body (second run). _billing_auto_reinstate and admin_get_org_activity are
-- asserted, not replaced (prod: 20261107160000 first, for the 'notified' reader whitelist).
-- Rollback: supabase/tests/backlog-4200-4209/rollback-4209.sql.

DO $guard$
DECLARE
  v_ri3 text; v_ri4 text; v_ad2 text; v_ad3 text; v_auto text; v_rd text;
BEGIN
  SELECT md5(prosrc) INTO v_ri3 FROM pg_proc WHERE oid = to_regprocedure('public._billing_reinstate_org(uuid,text,uuid)');
  SELECT md5(prosrc) INTO v_ri4 FROM pg_proc WHERE oid = to_regprocedure('public._billing_reinstate_org(uuid,text,uuid,boolean)');
  SELECT md5(prosrc) INTO v_ad2 FROM pg_proc WHERE oid = to_regprocedure('public.admin_reinstate_org(uuid,text)');
  SELECT md5(prosrc) INTO v_ad3 FROM pg_proc WHERE oid = to_regprocedure('public.admin_reinstate_org(uuid,text,boolean)');
  SELECT md5(prosrc) INTO v_auto FROM pg_proc WHERE oid = to_regprocedure('public._billing_auto_reinstate(uuid,text)');
  SELECT md5(prosrc) INTO v_rd FROM pg_proc WHERE oid = to_regprocedure('public.admin_get_org_activity(uuid,integer)');
  IF NOT ((v_ri3 = '9aeb774ad532a183c64df4b70e4820b6' AND v_ri4 IS NULL) OR (v_ri3 IS NULL AND v_ri4 = '7ab5b46d84e7b3994eaf12f2becaee23')) THEN
    RAISE EXCEPTION 'BACKLOG-4209: _billing_reinstate_org changed (3-arg md5 %, 4-arg md5 %)', v_ri3, v_ri4;
  END IF;
  IF NOT ((v_ad2 = '3a92c28461f73f4e6ee7aa0102559126' AND v_ad3 IS NULL) OR (v_ad2 IS NULL AND v_ad3 = 'b9b3d2704de93c62599da0d84bd45921')) THEN
    RAISE EXCEPTION 'BACKLOG-4209: admin_reinstate_org changed (2-arg md5 %, 3-arg md5 %)', v_ad2, v_ad3;
  END IF;
  IF v_auto IS DISTINCT FROM '4bcc2398653dd3d027443e529be70e17' THEN
    RAISE EXCEPTION 'BACKLOG-4209: _billing_auto_reinstate changed (md5 %)', v_auto;
  END IF;
  IF v_rd IS DISTINCT FROM '93ee729f73f23ecd90ffe49ca6d60704' THEN
    RAISE EXCEPTION 'BACKLOG-4209: admin_get_org_activity is not at the 20261107160000 body (md5 %); apply 20261107160000 first', v_rd;
  END IF;
END
$guard$;

CREATE OR REPLACE FUNCTION public._billing_reinstate_org(p_org uuid, p_note text, p_actor uuid, p_notify boolean DEFAULT true)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
  v_deal public.org_deals%ROWTYPE;
  v_notify boolean;
  v_via text := CASE WHEN p_actor IS NULL THEN 'auto' ELSE 'staff' END;
  v_epoch bigint;
BEGIN
  IF p_notify IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'invalid_request');
  END IF;
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

  -- BACKLOG-4209: the billing contact is told the account is usable again. Staff reinstates pass
  -- the "Email the billing contact" choice; the automatic reinstate after a payment
  -- (_billing_auto_reinstate, actor NULL) takes the default. One row per lifted suspension: the
  -- key is the epoch of suspended_at, read before the UPDATE clears it.
  v_notify := p_notify AND nullif(btrim(coalesce(v_deal.billing_contact_email, '')), '') IS NOT NULL AND v_deal.suspended_at IS NOT NULL;
  v_epoch := floor(extract(epoch FROM v_deal.suspended_at))::bigint;

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
  VALUES (p_org, p_actor, 'reinstated', jsonb_build_object('note', p_note, 'was_reason', v_deal.suspended_reason,
                                                            'suspended_at_epoch', v_epoch, 'via', v_via, 'notified', v_notify));

  IF v_notify THEN
    INSERT INTO public.billing_outbox (stripe_mode, kind, organization_id, dedupe_key, payload)
    VALUES (v_deal.stripe_mode, 'notify_org_reinstated', p_org,
            'notify_org_reinstated:' || v_deal.stripe_mode || ':' || p_org::text || ':' || v_epoch::text,
            jsonb_build_object('organization_id', p_org, 'suspended_at_epoch', v_epoch, 'via', v_via))
    ON CONFLICT (dedupe_key) DO NOTHING;
  END IF;

  RETURN jsonb_build_object('success', true);
END
$function$;

REVOKE ALL ON FUNCTION public._billing_reinstate_org(uuid, text, uuid, boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public._billing_reinstate_org(uuid, text, uuid, boolean) TO service_role;

CREATE OR REPLACE FUNCTION public.admin_reinstate_org(p_org uuid, p_note text, p_notify boolean DEFAULT true)
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
  RETURN public._billing_reinstate_org(p_org, p_note, v_uid, p_notify);
END
$function$;

REVOKE ALL ON FUNCTION public.admin_reinstate_org(uuid, text, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_reinstate_org(uuid, text, boolean) TO authenticated, service_role;

-- The replaced versions (replace, not overload): _billing_auto_reinstate's 3-arg call and the
-- admin portal's 2-arg named call now resolve to the new functions through the defaults.
DROP FUNCTION IF EXISTS public.admin_reinstate_org(uuid, text);
DROP FUNCTION IF EXISTS public._billing_reinstate_org(uuid, text, uuid);
