-- BACKLOG-3853 PR-2A: staff deal setup in the admin portal.
--
-- admin_save_deal     - the admin-portal entry point over _billing_save_deal (PR-1, service role
--                       only). Needs billing.manage. Every save needs a reason. A seat price more
--                       than the Sales cap below list needs billing.approve (Super Admin);
--                       otherwise it is refused. On a deal that already carries such a price
--                       (and is not canceled), Sales may keep that price or raise it toward
--                       list, and change the contact, the account manager or lower the seats;
--                       raising the seats or lowering the price needs billing.approve. No
--                       approval queue: a refusal is the whole flow.
-- admin_get_org_billing - what the Billing card shows. Needs billing.view.
-- billing_limits      - numeric billing settings. sales_discount_cap_pct = 20 (founder B13).
--                       A missing row counts as a cap of 0 (fail closed).
--
-- Darkness is unchanged from PR-1: _billing_save_deal refuses a live-mode deal while
-- billing_settings.brokerage_billing_live is false, and a test-mode deal needs an is_test
-- organization (_guard_stripe_mode_is_test). The caller passes the deployment's Stripe mode.
--
-- CREATE TABLE IF NOT EXISTS and CREATE OR REPLACE only. No PR-1 function body changes.
-- Pre-check: PR-1 (20261018230000) is applied and _billing_save_deal is the PR-1 body.
-- Rollback: supabase/tests/backlog-3853/rollback-3853-pr2a.sql

DO $pre$
DECLARE
  v_md5 text;
BEGIN
  SELECT md5(pg_get_functiondef(oid)) INTO v_md5 FROM pg_proc
   WHERE oid = to_regprocedure('public._billing_save_deal(uuid,jsonb,uuid,text,integer)');
  IF v_md5 IS DISTINCT FROM '4471a965ddbfdde884108a891da73c01' THEN
    RAISE EXCEPTION '3853 PR-2A pre-check: _billing_save_deal is not the PR-1 body (md5(pg_get_functiondef) %)', v_md5;
  END IF;
  IF to_regprocedure('public.has_permission(uuid,text)') IS NULL THEN
    RAISE EXCEPTION '3853 PR-2A pre-check: has_permission(uuid,text) is missing';
  END IF;
END $pre$;

-- =====================================================================================
-- 1. Numeric billing settings
-- =====================================================================================

CREATE TABLE IF NOT EXISTS public.billing_limits (
  key        text PRIMARY KEY CONSTRAINT billing_limits_key_ck CHECK (key IN ('sales_discount_cap_pct')),
  value      numeric NOT NULL CONSTRAINT billing_limits_value_ck CHECK (value >= 0 AND value <= 100),
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid
);
ALTER TABLE public.billing_limits ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.billing_limits FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.billing_limits TO service_role;
INSERT INTO public.billing_limits (key, value) VALUES ('sales_discount_cap_pct', 20)
ON CONFLICT (key) DO NOTHING;
COMMENT ON TABLE public.billing_limits IS
  'BACKLOG-3853: numeric billing settings. sales_discount_cap_pct = how far below list a seat price may go without billing.approve.';

-- =====================================================================================
-- 2. admin_save_deal
-- =====================================================================================

CREATE OR REPLACE FUNCTION public.admin_save_deal(
  p_org uuid,
  p_stripe_mode text,
  p_seats integer,
  p_unit_price_cents integer,
  p_billing_contact_name text,
  p_billing_contact_email text,
  p_account_manager_id uuid,
  p_reason text,
  p_expected_version integer)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
  v_email text := nullif(btrim(coalesce(p_billing_contact_email, '')), '');
  v_list integer;
  v_cap numeric;
  v_pct numeric;
  v_over boolean := false;
  v_current integer;
  v_current_seats integer;
  v_res jsonb;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '42501';
  END IF;
  IF NOT public.has_permission(v_uid, 'billing.manage') THEN
    RAISE EXCEPTION 'Not authorized' USING ERRCODE = '42501';
  END IF;
  IF v_reason IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'reason_required');
  END IF;
  IF v_email IS NULL OR position('@' in v_email) < 2 THEN
    RETURN jsonb_build_object('success', false, 'error', 'billing_contact_required');
  END IF;
  IF p_unit_price_cents IS NULL OR p_unit_price_cents < 0 THEN
    RETURN jsonb_build_object('success', false, 'error', 'invalid_price');
  END IF;
  -- has_permission() answers for the caller only (BACKLOG-3946), so the account manager is
  -- checked against the role grants directly.
  IF p_account_manager_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.internal_roles ir2
                   JOIN public.admin_role_permissions arp ON arp.role_id = ir2.role_id
                   JOIN public.admin_permissions ap ON ap.id = arp.permission_id
                  WHERE ir2.user_id = p_account_manager_id AND ap.key = 'billing.manage') THEN
    RETURN jsonb_build_object('success', false, 'error', 'invalid_account_manager');
  END IF;

  SELECT pp.amount_cents INTO v_list FROM public.price_book_prices pp
   WHERE pp.item_key = 'brokerage_seat' AND pp.billing_interval = 'month'
     AND pp.effective_from <= now() AND (pp.effective_to IS NULL OR pp.effective_to > now())
   ORDER BY pp.effective_from DESC LIMIT 1;
  IF v_list IS NULL OR v_list <= 0 THEN
    RETURN jsonb_build_object('success', false, 'error', 'no_price');
  END IF;

  -- Sales cap (B13). Same formula as org_deal_lines.pct_off. Above list needs nothing.
  SELECT bl.value INTO v_cap FROM public.billing_limits bl WHERE bl.key = 'sales_discount_cap_pct';
  v_cap := coalesce(v_cap, 0);
  v_pct := round(100.0 * (v_list - p_unit_price_cents) / v_list, 2);
  -- A deep price already on a deal that is not canceled (saved by someone allowed to) may be
  -- kept or raised toward list: Sales can change the contact or the manager, raise the price and
  -- lower the seats on it, but raising the seats or lowering the price needs billing.approve
  -- (founder ruling).
  SELECT l.unit_price_cents, d.seats INTO v_current, v_current_seats
    FROM public.org_deal_lines l
    JOIN public.org_deals d ON d.organization_id = l.organization_id
   WHERE l.organization_id = p_org AND l.item_key = 'brokerage_seat'
     AND d.status <> 'canceled';
  IF v_pct > v_cap THEN
    v_over := true;
    IF NOT public.has_permission(v_uid, 'billing.approve')
       AND NOT (v_current IS NOT NULL AND p_unit_price_cents >= v_current AND p_seats <= v_current_seats) THEN
      RETURN jsonb_build_object('success', false, 'error', 'discount_needs_approval',
                                'pct_off', v_pct, 'cap_pct', v_cap, 'list_price_cents', v_list);
    END IF;
  END IF;

  v_res := public._billing_save_deal(
    p_org,
    jsonb_strip_nulls(jsonb_build_object(
      'stripe_mode', p_stripe_mode,
      'seats', p_seats,
      'unit_price_cents', p_unit_price_cents,
      'billing_contact_name', nullif(btrim(coalesce(p_billing_contact_name, '')), ''),
      'billing_contact_email', v_email,
      'account_manager_id', p_account_manager_id)),
    v_uid, v_reason, p_expected_version);

  IF coalesce((v_res ->> 'success')::boolean, false) THEN
    INSERT INTO public.admin_audit_logs (actor_id, action, target_type, target_id, metadata)
    VALUES (v_uid, 'billing.deal_saved', 'organization', p_org::text, jsonb_build_object(
      'version', v_res -> 'version', 'seats', p_seats, 'unit_price_cents', p_unit_price_cents,
      'list_price_cents', v_list, 'pct_off', v_pct, 'cap_pct', v_cap, 'over_cap', v_over,
      'stripe_mode', p_stripe_mode, 'reason', v_reason));
  END IF;
  RETURN v_res;
END
$function$;
REVOKE EXECUTE ON FUNCTION public.admin_save_deal(uuid, text, integer, integer, text, text, uuid, text, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_save_deal(uuid, text, integer, integer, text, text, uuid, text, integer) TO authenticated, service_role;

-- =====================================================================================
-- 3. admin_get_org_billing
-- =====================================================================================

CREATE OR REPLACE FUNCTION public.admin_get_org_billing(p_org uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_list integer;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '42501';
  END IF;
  IF NOT public.has_permission(v_uid, 'billing.view') THEN
    RAISE EXCEPTION 'Not authorized' USING ERRCODE = '42501';
  END IF;

  SELECT pp.amount_cents INTO v_list FROM public.price_book_prices pp
   WHERE pp.item_key = 'brokerage_seat' AND pp.billing_interval = 'month'
     AND pp.effective_from <= now() AND (pp.effective_to IS NULL OR pp.effective_to > now())
   ORDER BY pp.effective_from DESC LIMIT 1;

  RETURN jsonb_build_object(
    'billing_live', public._billing_brokerage_live(),
    'is_test', coalesce((SELECT o.is_test FROM public.organizations o WHERE o.id = p_org), false),
    'list_price_cents', v_list,
    'cap_pct', coalesce((SELECT bl.value FROM public.billing_limits bl WHERE bl.key = 'sales_discount_cap_pct'), 0),
    'can_manage', public.has_permission(v_uid, 'billing.manage'),
    'can_approve', public.has_permission(v_uid, 'billing.approve'),
    'can_suspend', public.has_permission(v_uid, 'billing.suspend'),
    'assigned_seats', (SELECT count(*) FROM public.organization_members m
                        WHERE m.organization_id = p_org
                          AND public.member_row_holds_seat(m.license_status, m.invitation_expires_at, m.user_id)),
    'deal', (SELECT to_jsonb(d) - 'entitlement_prior' FROM public.org_deals d WHERE d.organization_id = p_org),
    'seat_line', (SELECT jsonb_build_object('unit_price_cents', l.unit_price_cents,
                                            'list_price_cents_at_save', l.list_price_cents_at_save, 'pct_off', l.pct_off)
                    FROM public.org_deal_lines l WHERE l.organization_id = p_org AND l.item_key = 'brokerage_seat'),
    'stripe', (SELECT jsonb_build_object('stripe_mode', s.stripe_mode, 'status', s.status,
                                         'current_period_end', s.current_period_end,
                                         'cancel_at_period_end', s.cancel_at_period_end)
                 FROM public.org_billing_stripe s
                 JOIN public.org_deals d ON d.organization_id = s.organization_id AND d.stripe_mode = s.stripe_mode
                WHERE s.organization_id = p_org),
    'account_managers', coalesce((
      SELECT jsonb_agg(jsonb_build_object('id', u.id, 'name', coalesce(u.display_name, u.email), 'email', u.email)
                       ORDER BY coalesce(u.display_name, u.email))
        FROM public.internal_roles ir
        JOIN public.users u ON u.id = ir.user_id
       WHERE EXISTS (SELECT 1 FROM public.internal_roles ir2
                   JOIN public.admin_role_permissions arp ON arp.role_id = ir2.role_id
                   JOIN public.admin_permissions ap ON ap.id = arp.permission_id
                  WHERE ir2.user_id = ir.user_id AND ap.key = 'billing.manage')), '[]'::jsonb),
    'log', coalesce((
      SELECT jsonb_agg(jsonb_build_object('created_at', x.created_at, 'action', x.action, 'detail', x.detail,
                                          'actor', coalesce(u.display_name, u.email))
                       ORDER BY x.created_at DESC)
        FROM (SELECT * FROM public.billing_change_log c WHERE c.organization_id = p_org
               ORDER BY c.created_at DESC LIMIT 20) x
        LEFT JOIN public.users u ON u.id = x.actor_id), '[]'::jsonb));
END
$function$;
REVOKE EXECUTE ON FUNCTION public.admin_get_org_billing(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_get_org_billing(uuid) TO authenticated, service_role;
