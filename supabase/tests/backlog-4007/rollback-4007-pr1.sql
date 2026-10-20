-- BACKLOG-4007 PR-1 rollback (keepr-test; production only if the migration was applied there).
-- Restores the three replaced bodies verbatim (3853 PR-1 _billing_save_deal, 3853 PR-2A
-- admin_save_deal 9-arg and admin_get_org_billing), removes the 10-arg admin_save_deal and every
-- object 20261020100000 added, and deletes its ledger row. Grants on the restored functions are
-- kept (CREATE OR REPLACE keeps the ACL).
-- Data note: deals saved after the migration may be 'draft'. Under the restored body the next
-- staff edit turns them 'active' and starts billing; decide each one before rolling back:
--   SELECT organization_id, version FROM public.org_deals WHERE status = 'draft';
-- org_deals.billing_contact_name / _email already hold every contact (the one writer kept them
-- in step), so dropping org_contacts loses only phone numbers, company details and terms
-- acceptances: export them first if they matter.
BEGIN;

DROP TRIGGER IF EXISTS _billing_guard_invite_while_setup_pending ON public.organization_members;
DROP TRIGGER IF EXISTS _billing_enqueue_setup_reminders ON public.organization_members;
DROP FUNCTION IF EXISTS public._billing_guard_invite_while_setup_pending();
DROP FUNCTION IF EXISTS public._billing_enqueue_setup_reminders();
DROP FUNCTION IF EXISTS public._billing_org_setup_pending(uuid);
DROP FUNCTION IF EXISTS public.broker_complete_billing_setup(uuid, integer, jsonb, jsonb, boolean);
DROP FUNCTION IF EXISTS public.broker_accept_terms(uuid, integer, text, text);
DROP FUNCTION IF EXISTS public.broker_get_billing_setup(uuid);

-- <<SAVE_DEAL (3853 PR-1 body, 20261018230000)
CREATE OR REPLACE FUNCTION public._billing_save_deal(
  p_org uuid, p_deal jsonb, p_actor uuid, p_reason text, p_expected_version integer)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
  v_mode text := p_deal ->> 'stripe_mode';
  v_seats integer := nullif(p_deal ->> 'seats', '')::integer;
  v_list integer;
  v_price integer;
  v_plan uuid;
  v_holders integer;
  v_deal public.org_deals%ROWTYPE;
  v_version integer;
BEGIN
  IF v_mode IS NULL OR v_mode NOT IN ('test', 'live') THEN
    RETURN jsonb_build_object('success', false, 'error', 'invalid_stripe_mode');
  END IF;
  IF v_mode = 'live' AND NOT public._billing_brokerage_live() THEN
    RETURN jsonb_build_object('success', false, 'error', 'billing_not_live');
  END IF;
  IF v_seats IS NULL OR v_seats < 1 THEN
    RETURN jsonb_build_object('success', false, 'error', 'invalid_seats');
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('billing_org:' || p_org::text, 0));

  SELECT op.plan_id INTO v_plan FROM public.organization_plans op WHERE op.organization_id = p_org;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'no_plan');
  END IF;

  SELECT count(*) INTO v_holders FROM public.organization_members m
   WHERE m.organization_id = p_org
     AND public.member_row_holds_seat(m.license_status, m.invitation_expires_at, m.user_id);
  IF v_seats < v_holders THEN
    RETURN jsonb_build_object('success', false, 'error', 'seats_below_assigned', 'assigned', v_holders);
  END IF;

  SELECT pp.amount_cents INTO v_list FROM public.price_book_prices pp
   WHERE pp.item_key = 'brokerage_seat' AND pp.billing_interval = 'month'
     AND pp.effective_from <= now() AND (pp.effective_to IS NULL OR pp.effective_to > now())
   ORDER BY pp.effective_from DESC LIMIT 1;
  v_price := coalesce(nullif(p_deal ->> 'unit_price_cents', '')::integer, v_list);
  IF v_price IS NULL OR v_price < 0 THEN
    RETURN jsonb_build_object('success', false, 'error', 'no_price');
  END IF;

  SELECT * INTO v_deal FROM public.org_deals WHERE organization_id = p_org FOR UPDATE;
  IF FOUND THEN
    IF p_expected_version IS DISTINCT FROM v_deal.version THEN
      RETURN jsonb_build_object('success', false, 'error', 'version_conflict', 'version', v_deal.version);
    END IF;
    IF v_deal.stripe_mode <> v_mode THEN
      RETURN jsonb_build_object('success', false, 'error', 'stripe_mode_mismatch');
    END IF;
    UPDATE public.org_deals SET
      seats = v_seats,
      plan_id = v_plan,
      status = CASE WHEN status IN ('draft', 'canceled') THEN 'active' ELSE status END,
      billing_contact_name = coalesce(p_deal ->> 'billing_contact_name', billing_contact_name),
      billing_contact_email = coalesce(p_deal ->> 'billing_contact_email', billing_contact_email),
      account_manager_id = coalesce(nullif(p_deal ->> 'account_manager_id', '')::uuid, account_manager_id),
      designated_broker_member_id = coalesce(nullif(p_deal ->> 'designated_broker_member_id', '')::uuid, designated_broker_member_id),
      version = version + 1,
      updated_at = now(),
      updated_by = p_actor
    WHERE organization_id = p_org
    RETURNING version INTO v_version;
  ELSE
    IF p_expected_version IS NOT NULL THEN
      RETURN jsonb_build_object('success', false, 'error', 'version_conflict', 'version', NULL);
    END IF;
    INSERT INTO public.org_deals (organization_id, stripe_mode, plan_id, seats, start_date, status,
      billing_contact_name, billing_contact_email, account_manager_id, designated_broker_member_id, updated_by)
    VALUES (p_org, v_mode, v_plan, v_seats, current_date, 'active',
      p_deal ->> 'billing_contact_name', p_deal ->> 'billing_contact_email',
      nullif(p_deal ->> 'account_manager_id', '')::uuid, nullif(p_deal ->> 'designated_broker_member_id', '')::uuid, p_actor)
    RETURNING version INTO v_version;
  END IF;

  INSERT INTO public.org_deal_lines (organization_id, item_key, quantity_rule, unit_price_cents, list_price_cents_at_save)
  VALUES (p_org, 'brokerage_seat', 'seats', v_price, v_list)
  ON CONFLICT (organization_id, item_key) DO UPDATE
    SET unit_price_cents = EXCLUDED.unit_price_cents,
        list_price_cents_at_save = EXCLUDED.list_price_cents_at_save,
        updated_at = now();

  UPDATE public.organizations SET max_seats = v_seats WHERE id = p_org AND max_seats IS DISTINCT FROM v_seats;

  PERFORM public._billing_apply_org_entitlement(p_org);

  INSERT INTO public.billing_change_log (organization_id, actor_id, action, detail)
  VALUES (p_org, p_actor, 'deal_saved', jsonb_build_object('version', v_version, 'seats', v_seats,
          'unit_price_cents', v_price, 'stripe_mode', v_mode, 'reason', p_reason));

  RETURN jsonb_build_object('success', true, 'version', v_version);
END
$function$;
-- SAVE_DEAL>>

-- <<ADMIN_SAVE_DEAL_9 (3853 PR-2A body, 20261019030000)
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
-- ADMIN_SAVE_DEAL_9>>

-- <<GET_ORG_BILLING (3853 PR-2A body, 20261019030000)
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
-- GET_ORG_BILLING>>

DROP FUNCTION IF EXISTS public.admin_save_deal(uuid, text, integer, integer, text, text, uuid, text, integer, date);
DROP FUNCTION IF EXISTS public._org_billing_contact_set(uuid, text, text, text, uuid);
DROP FUNCTION IF EXISTS public._billing_normalize_phone(text);
DROP FUNCTION IF EXISTS public._billing_business_date(timestamptz);

ALTER TABLE public.org_deals
  DROP COLUMN IF EXISTS billing_contact_id,
  DROP COLUMN IF EXISTS billing_starts_on,
  DROP COLUMN IF EXISTS setup_completed_at,
  DROP COLUMN IF EXISTS setup_completed_by;
DROP TABLE IF EXISTS public.org_terms_acceptances;
DROP TABLE IF EXISTS public.org_billing_profile;
DROP TABLE IF EXISTS public.org_contacts;

UPDATE public.billing_outbox SET processed_at = now(), last_error = 'rolled_back_4007'
 WHERE kind = 'notify_setup_reminder' AND processed_at IS NULL;

DELETE FROM supabase_migrations.schema_migrations WHERE version = '20261020100000';

DO $post$
BEGIN
  IF md5(pg_get_functiondef('public._billing_save_deal(uuid,jsonb,uuid,text,integer)'::regprocedure)) <> '4471a965ddbfdde884108a891da73c01'
     OR md5(pg_get_functiondef('public.admin_save_deal(uuid,text,integer,integer,text,text,uuid,text,integer)'::regprocedure)) <> 'f3ae35f5e1086f4da45a4394d08c55b1'
     OR md5(pg_get_functiondef('public.admin_get_org_billing(uuid)'::regprocedure)) <> '998884311f45b031f4488fd9e5b25b20' THEN
    RAISE EXCEPTION '4007 rollback: a restored body does not match its prior md5';
  END IF;
END $post$;

COMMIT;
