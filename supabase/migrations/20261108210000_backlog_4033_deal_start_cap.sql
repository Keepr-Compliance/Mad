-- BACKLOG-4033: the 365-day start-date cap, enforced in the database save path.
--
-- _billing_save_deal (replaced, same signature) refuses a start date more than 365 days after
-- the business date with 'start_date_too_far' (plus 'latest'), on a new deal and on a changed
-- date of an existing deal. An unchanged existing date is not re-checked, the same as the past
-- check. The order on an existing deal stays: version, mode, then (only when the date changes)
-- locked, past, too far. date + integer, never interval '1 year' (the client is +365 days).
-- Same rule as admin-portal/lib/billing/dealRules.ts checkStartDate. admin_save_deal is not
-- replaced.
-- Pre-check: the body being replaced is the 20261020100000 one (md5 pinned), or this one.
-- Rollback: supabase/tests/backlog-4033/rollback-4033.sql.

DO $pin$
DECLARE v_src text;
BEGIN
  SELECT p.prosrc INTO v_src FROM pg_proc p
   WHERE p.oid = to_regprocedure('public._billing_save_deal(uuid,jsonb,uuid,text,integer)');
  IF v_src IS NULL THEN
    RAISE EXCEPTION 'BACKLOG-4033: _billing_save_deal(uuid,jsonb,uuid,text,integer) not found';
  END IF;
  IF md5(v_src) <> '2cfdf5c0b2795ad2175b166891b14152' AND position('start_date_too_far' IN v_src) = 0 THEN
    RAISE EXCEPTION 'BACKLOG-4033: unexpected _billing_save_deal body (md5 %)', md5(v_src);
  END IF;
END
$pin$;

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
  v_today date := public._billing_business_date();
  v_start date;
  v_contact_email text := nullif(btrim(coalesce(p_deal ->> 'billing_contact_email', '')), '');
  v_contact_name text := nullif(btrim(coalesce(p_deal ->> 'billing_contact_name', '')), '');
  v_status text;
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
  BEGIN
    v_start := nullif(p_deal ->> 'start_date', '')::date;
  EXCEPTION WHEN OTHERS THEN
    RETURN jsonb_build_object('success', false, 'error', 'invalid_start_date');
  END;

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
    IF v_start IS NOT NULL AND v_start IS DISTINCT FROM v_deal.start_date THEN
      -- After setup the start date is the contract record (founder 2026-10-19).
      IF v_deal.status <> 'draft' THEN
        RETURN jsonb_build_object('success', false, 'error', 'start_date_locked');
      END IF;
      IF v_start < v_today THEN
        RETURN jsonb_build_object('success', false, 'error', 'start_date_past', 'today', v_today);
      END IF;
      -- BACKLOG-4033: at most 365 days after the business date (dealRules.ts MAX_START_DAYS_AHEAD).
      IF v_start > v_today + 365 THEN
        RETURN jsonb_build_object('success', false, 'error', 'start_date_too_far', 'latest', v_today + 365);
      END IF;
    END IF;
    UPDATE public.org_deals SET
      seats = v_seats,
      plan_id = v_plan,
      -- A waiting deal stays waiting: only the broker's setup completion activates it.
      status = CASE WHEN status = 'canceled' THEN 'active' ELSE status END,
      start_date = coalesce(v_start, start_date),
      account_manager_id = coalesce(nullif(p_deal ->> 'account_manager_id', '')::uuid, account_manager_id),
      designated_broker_member_id = coalesce(nullif(p_deal ->> 'designated_broker_member_id', '')::uuid, designated_broker_member_id),
      version = version + 1,
      updated_at = now(),
      updated_by = p_actor
    WHERE organization_id = p_org
    RETURNING version, status, start_date INTO v_version, v_status, v_start;
  ELSE
    IF p_expected_version IS NOT NULL THEN
      RETURN jsonb_build_object('success', false, 'error', 'version_conflict', 'version', NULL);
    END IF;
    IF v_start IS NOT NULL AND v_start < v_today THEN
      RETURN jsonb_build_object('success', false, 'error', 'start_date_past', 'today', v_today);
    END IF;
    IF v_start IS NOT NULL AND v_start > v_today + 365 THEN
      RETURN jsonb_build_object('success', false, 'error', 'start_date_too_far', 'latest', v_today + 365);
    END IF;
    INSERT INTO public.org_deals (organization_id, stripe_mode, plan_id, seats, start_date, status,
      account_manager_id, designated_broker_member_id, updated_by)
    VALUES (p_org, v_mode, v_plan, v_seats, coalesce(v_start, v_today), 'draft',
      nullif(p_deal ->> 'account_manager_id', '')::uuid, nullif(p_deal ->> 'designated_broker_member_id', '')::uuid, p_actor)
    RETURNING version, status, start_date INTO v_version, v_status, v_start;
  END IF;

  -- Billing contact: one writer for the contact row and the deal columns.
  IF v_contact_email IS NOT NULL THEN
    PERFORM public._org_billing_contact_set(p_org, v_contact_name, v_contact_email, NULL, p_actor);
  ELSIF v_contact_name IS NOT NULL AND v_deal.billing_contact_email IS NOT NULL THEN
    PERFORM public._org_billing_contact_set(p_org, v_contact_name, v_deal.billing_contact_email, NULL, p_actor);
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
          'unit_price_cents', v_price, 'stripe_mode', v_mode, 'reason', p_reason,
          'status', v_status, 'start_date', v_start));

  RETURN jsonb_build_object('success', true, 'version', v_version, 'status', v_status, 'start_date', v_start);
END
$function$;
REVOKE EXECUTE ON FUNCTION public._billing_save_deal(uuid, jsonb, uuid, text, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public._billing_save_deal(uuid, jsonb, uuid, text, integer) TO service_role;
