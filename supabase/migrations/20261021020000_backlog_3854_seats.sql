-- BACKLOG-3854: brokerage seats on the broker portal Billing page.
--
-- Two new public functions, both called with the signed-in user's session:
--   broker_get_seats(org)                      seats bought / in use / free, and whether this
--                                              person may add seats now (can_add + reason).
--   broker_add_seats(org, add, expected_ver)   increase only. The new total is computed HERE,
--                                              under the brokerage's billing lock, from the
--                                              stored seats; the client sends only how many to
--                                              add. Delegates to _billing_change_seats (audit
--                                              row, version bump -> the org_deals trigger queues
--                                              one sync_org_subscription row -> Stripe quantity,
--                                              prorated by brokerageSync.ts).
--
-- Who may add: an active Broker or Admin of the brokerage (_org_contact_caller(p_org, true) =
-- 'broker', the same rule as org contacts). Never IT admin, the billing contact, an agent, staff
-- (staff keep Edit deal in the admin portal) or anyone outside the brokerage.
-- Who may read: Broker, Admin, IT admin, staff with billing.view, and the billing contact
-- (licensed or the billing-only login; the same predicate as _org_auto_renew_caller).
--
-- Refused (in this order): no_deal, version_conflict, deal_not_started (draft), deal_suspended,
-- deal_canceling (auto-renew off), deal_canceled, billing_not_live, invoice_overdue (the
-- webhook mirror org_billing_stripe.status is past_due or unpaid, for the deal's own mode).
-- The broker portal action also checks Stripe live for an overdue invoice before calling; this
-- mirror check is the backstop for a direct call.
--
-- A successful add queues two outbox rows: notify_account_manager (reason seats_added) and
-- notify_seats_added (a short email to the deal's billing contact). Both keys carry the new deal
-- version, ON CONFLICT DO NOTHING.
--
-- Functions only: no table, column, constraint or policy change. Nothing existing is replaced.
-- Rollback (keepr-test): supabase/tests/backlog-3854/rollback.sql.

DO $pre$
DECLARE
  v_md5 text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM supabase_migrations.schema_migrations WHERE version = '20261020220000') THEN
    RAISE EXCEPTION 'BACKLOG-3854: migration 20261020220000 (BACKLOG-4019 auto-renew) must be applied first';
  END IF;
  -- The functions this file builds on, as read on keepr-test 2026-10-21.
  SELECT md5(pg_get_functiondef('public._billing_change_seats(uuid,integer,uuid)'::regprocedure)) INTO v_md5;
  IF v_md5 <> 'aa54324c44cbe508a4ab85463e573beb' THEN
    RAISE EXCEPTION 'BACKLOG-3854: _billing_change_seats changed (md5 %)', v_md5;
  END IF;
  SELECT md5(pg_get_functiondef('public._org_contact_caller(uuid,boolean)'::regprocedure)) INTO v_md5;
  IF v_md5 <> '45e954ab4a56a34d27bd0938a7fc4469' THEN
    RAISE EXCEPTION 'BACKLOG-3854: _org_contact_caller changed (md5 %)', v_md5;
  END IF;
  SELECT md5(pg_get_functiondef('public.member_row_holds_seat(text,timestamptz,uuid)'::regprocedure)) INTO v_md5;
  IF v_md5 <> 'a112ad1eacedf2acc6e365c811906fec' THEN
    RAISE EXCEPTION 'BACKLOG-3854: member_row_holds_seat changed (md5 %)', v_md5;
  END IF;
END $pre$;

-- =====================================================================================
-- 1. The refusal both functions share (so the page never offers a button the write refuses).
--    NULL = seats may be added now. Reads the deal row passed in; no lock of its own.
-- =====================================================================================
CREATE OR REPLACE FUNCTION public._org_seat_add_refusal(p_deal public.org_deals)
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO ''
AS $function$
  SELECT CASE
    WHEN p_deal.organization_id IS NULL THEN 'no_deal'
    WHEN p_deal.status = 'draft' THEN 'deal_not_started'
    WHEN p_deal.status = 'suspended' THEN 'deal_suspended'
    WHEN p_deal.status = 'canceling' THEN 'deal_canceling'
    WHEN p_deal.status = 'canceled' THEN 'deal_canceled'
    WHEN p_deal.status <> 'active' THEN 'deal_not_active'
    WHEN p_deal.stripe_mode = 'live' AND NOT public._billing_brokerage_live() THEN 'billing_not_live'
    WHEN EXISTS (SELECT 1 FROM public.org_billing_stripe s
                  WHERE s.organization_id = p_deal.organization_id
                    AND s.stripe_mode = p_deal.stripe_mode
                    AND s.status IN ('past_due', 'unpaid')) THEN 'invoice_overdue'
    ELSE NULL
  END
$function$;
REVOKE ALL ON FUNCTION public._org_seat_add_refusal(public.org_deals) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public._org_seat_add_refusal(public.org_deals) TO service_role;

-- =====================================================================================
-- 2. Read: seat counts for the Billing page.
--    bought = organizations.max_seats (what the seat trigger enforces); in_use = members for whom
--    member_row_holds_seat is true (the trigger's own rule); free = bought - in_use, floored at 0.
--    max_seats NULL or <= 0 -> unlimited. A personal organization -> not_allowed, no counts.
-- =====================================================================================
CREATE OR REPLACE FUNCTION public.broker_get_seats(p_org uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_caller text;
  v_bc boolean;
  v_personal boolean;
  v_max integer;
  v_used integer;
  v_deal public.org_deals%ROWTYPE;
  v_reason text;
  v_can boolean;
  v_price integer;
  v_trialing boolean;
  v_am_email text;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '42501';
  END IF;
  v_caller := public._org_contact_caller(p_org, false);
  v_bc := EXISTS (SELECT 1 FROM public.org_contacts c
                    JOIN public.organization_members m ON m.id = c.member_id
                   WHERE c.organization_id = p_org AND c.role = 'billing' AND c.removed_at IS NULL
                     AND m.organization_id = p_org AND m.user_id = v_uid
                     AND m.license_status IN ('active', 'unassigned'));
  IF v_caller IS NULL AND NOT v_bc THEN
    RAISE EXCEPTION 'Not authorized' USING ERRCODE = '42501';
  END IF;

  SELECT o.personal_owner_user_id IS NOT NULL, o.max_seats INTO v_personal, v_max
    FROM public.organizations o WHERE o.id = p_org;
  IF v_personal IS DISTINCT FROM false THEN
    RETURN jsonb_build_object('can_add', false, 'cannot_add_reason', 'not_allowed');
  END IF;

  SELECT count(*)::integer INTO v_used FROM public.organization_members m
   WHERE m.organization_id = p_org
     AND public.member_row_holds_seat(m.license_status, m.invitation_expires_at, m.user_id);

  SELECT * INTO v_deal FROM public.org_deals WHERE organization_id = p_org;
  v_reason := CASE WHEN coalesce(v_caller, '') <> 'broker' THEN 'not_allowed'
                   ELSE public._org_seat_add_refusal(v_deal) END;
  v_can := v_reason IS NULL;

  IF v_caller = 'broker' AND v_deal.organization_id IS NOT NULL THEN
    SELECT l.unit_price_cents INTO v_price FROM public.org_deal_lines l
     WHERE l.organization_id = p_org AND l.item_key = 'brokerage_seat';
  END IF;
  IF (v_caller = 'broker' OR v_bc) AND v_deal.account_manager_id IS NOT NULL THEN
    SELECT nullif(btrim(u.email), '') INTO v_am_email FROM public.users u WHERE u.id = v_deal.account_manager_id;
  END IF;
  SELECT s.status = 'trialing' INTO v_trialing FROM public.org_billing_stripe s
   WHERE s.organization_id = p_org AND s.stripe_mode = v_deal.stripe_mode;

  RETURN jsonb_build_object(
    'bought', CASE WHEN v_max IS NULL OR v_max <= 0 THEN NULL ELSE v_max END,
    'in_use', v_used,
    'free', CASE WHEN v_max IS NULL OR v_max <= 0 THEN NULL ELSE greatest(v_max - v_used, 0) END,
    'unlimited', v_max IS NULL OR v_max <= 0,
    'can_add', v_can,
    'cannot_add_reason', v_reason,
    'version', CASE WHEN v_can THEN v_deal.version ELSE NULL END,
    -- Broker/Admin only (the confirm line); IT admin and the billing contact never get a price.
    'unit_price_cents', v_price,
    'trialing', coalesce(v_trialing, false),
    'account_manager_email', v_am_email);
END
$function$;
REVOKE ALL ON FUNCTION public.broker_get_seats(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.broker_get_seats(uuid) TO authenticated, service_role;

-- =====================================================================================
-- 3. Write: add seats (increase only).
-- =====================================================================================
CREATE OR REPLACE FUNCTION public.broker_add_seats(p_org uuid, p_add integer, p_expected_version integer)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_deal public.org_deals%ROWTYPE;
  v_reason text;
  v_res jsonb;
  v_version integer;
  v_to integer;
  v_who text;
  v_role text;
  v_trialing boolean;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '42501';
  END IF;
  IF public._org_contact_caller(p_org, true) IS DISTINCT FROM 'broker' THEN
    RAISE EXCEPTION 'Not authorized' USING ERRCODE = '42501';
  END IF;
  -- Type sanity only (founder: no seat cap).
  IF p_add IS NULL OR p_add < 1 OR p_add > 10000 THEN
    RETURN jsonb_build_object('success', false, 'error', 'invalid_seats');
  END IF;

  -- The same lock _billing_change_seats, _billing_set_auto_renew and Edit deal take.
  -- Transaction advisory locks stack, so the delegate taking it again is fine.
  PERFORM pg_advisory_xact_lock(hashtextextended('billing_org:' || p_org::text, 0));
  SELECT * INTO v_deal FROM public.org_deals WHERE organization_id = p_org FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'no_deal');
  END IF;
  IF p_expected_version IS DISTINCT FROM v_deal.version THEN
    RETURN jsonb_build_object('success', false, 'error', 'version_conflict', 'version', v_deal.version);
  END IF;
  v_reason := public._org_seat_add_refusal(v_deal);
  IF v_reason IS NOT NULL THEN
    RETURN jsonb_build_object('success', false, 'error', v_reason);
  END IF;

  -- The new total, from the stored seats, under the lock. Never from the client.
  v_to := v_deal.seats + p_add;
  v_res := public._billing_change_seats(p_org, v_to, v_uid);
  IF coalesce((v_res ->> 'success')::boolean, false) IS NOT TRUE THEN
    RETURN v_res;
  END IF;
  v_version := (v_res ->> 'version')::integer;

  SELECT coalesce(nullif(btrim(u.display_name), ''),
                  nullif(btrim(concat_ws(' ', u.first_name, u.last_name)), ''), u.email, 'A brokerage user')
    INTO v_who FROM public.users u WHERE u.id = v_uid;
  SELECT CASE WHEN bool_or(m.role = 'broker') THEN 'Broker' ELSE 'Admin' END INTO v_role
    FROM public.organization_members m
   WHERE m.organization_id = p_org AND m.user_id = v_uid AND m.license_status = 'active' AND m.role IN ('broker', 'admin');
  SELECT s.status = 'trialing' INTO v_trialing FROM public.org_billing_stripe s
   WHERE s.organization_id = p_org AND s.stripe_mode = v_deal.stripe_mode;

  INSERT INTO public.billing_outbox (stripe_mode, kind, organization_id, dedupe_key, payload)
  VALUES (v_deal.stripe_mode, 'notify_account_manager', p_org,
          'notify_account_manager:' || v_deal.stripe_mode || ':' || p_org::text || ':seats_added:v' || v_version::text,
          jsonb_build_object('reason', 'seats_added', 'organization_id', p_org,
            'detail', 'Added by ' || coalesce(v_who, 'a brokerage user') || ' (' || coalesce(v_role, 'Admin') || '): '
                      || v_deal.seats::text || ' to ' || v_to::text || ' seats. '
                      || CASE WHEN coalesce(v_trialing, false)
                              THEN 'The brokerage is in its trial; the new seats are billed from the end of the trial.'
                              ELSE 'A prorated charge for the rest of this period appears on the next invoice.' END))
  ON CONFLICT (dedupe_key) DO NOTHING;

  INSERT INTO public.billing_outbox (stripe_mode, kind, organization_id, dedupe_key, payload)
  VALUES (v_deal.stripe_mode, 'notify_seats_added', p_org,
          'notify_seats_added:' || v_deal.stripe_mode || ':' || p_org::text || ':v' || v_version::text,
          jsonb_build_object('organization_id', p_org, 'seats_from', v_deal.seats, 'seats_to', v_to,
                             'version', v_version, 'trialing', coalesce(v_trialing, false),
                             'added_by', coalesce(v_who, 'a brokerage user')))
  ON CONFLICT (dedupe_key) DO NOTHING;

  RETURN jsonb_build_object('success', true, 'version', v_version, 'seats_from', v_deal.seats, 'seats_to', v_to);
END
$function$;
REVOKE ALL ON FUNCTION public.broker_add_seats(uuid, integer, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.broker_add_seats(uuid, integer, integer) TO authenticated, service_role;
