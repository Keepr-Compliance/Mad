-- BACKLOG-4007 PR-4 rollback: restores broker_complete_billing_setup and _org_billing_contact_set
-- to the 4007 PR-1 bodies (verbatim from 20261020100000) and set_member_license to its pre-PR-4 body,
-- checks their md5s, drops the F6 trigger, drops every function this PR added, and
-- removes the ledger row. org_contacts rows written by PR-4 (IT / office / MSP contacts) are
-- kept as data; billing-only login member rows are kept (they are ordinary 'unassigned' members).

BEGIN;

DROP FUNCTION IF EXISTS public.org_billing_contact_login(uuid);
DROP FUNCTION IF EXISTS public.org_billing_login_set(uuid, boolean);
DROP FUNCTION IF EXISTS public._org_billing_login_create(uuid, uuid);
DROP FUNCTION IF EXISTS public.org_contact_remove(uuid, uuid);
DROP FUNCTION IF EXISTS public.org_contact_save(uuid, jsonb);
DROP FUNCTION IF EXISTS public.admin_search_users_for_contact(uuid, text);
DROP FUNCTION IF EXISTS public.org_contacts_list(uuid);
DROP FUNCTION IF EXISTS public._org_user_in_other_brokerage(uuid, uuid);
DROP FUNCTION IF EXISTS public._org_contact_caller(uuid, boolean);
DROP TRIGGER IF EXISTS guard_billing_login_personal_account ON public.organization_members;
DROP FUNCTION IF EXISTS public._guard_billing_login_personal_account();
DROP FUNCTION IF EXISTS public._user_has_personal_account(uuid);

CREATE OR REPLACE FUNCTION public.broker_complete_billing_setup(
  p_org uuid, p_expected_version integer, p_contact jsonb, p_company jsonb, p_billing_login boolean)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_deal public.org_deals%ROWTYPE;
  v_who text := p_contact ->> 'who';
  v_name text;
  v_email text;
  v_phone text;
  v_contact uuid;
  v_starts date;
  v_version integer;
  v_legal text := nullif(btrim(coalesce(p_company ->> 'legal_name', '')), '');
  v_line1 text := nullif(btrim(coalesce(p_company ->> 'address_line1', '')), '');
  v_line2 text := nullif(btrim(coalesce(p_company ->> 'address_line2', '')), '');
  v_city text := nullif(btrim(coalesce(p_company ->> 'city', '')), '');
  v_region text := nullif(btrim(coalesce(p_company ->> 'region', '')), '');
  v_postal text := nullif(btrim(coalesce(p_company ->> 'postal_code', '')), '');
  v_country text := upper(nullif(btrim(coalesce(p_company ->> 'country', '')), ''));
  v_po text := nullif(btrim(coalesce(p_company ->> 'po_number', '')), '');
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.organization_members m
                  WHERE m.organization_id = p_org AND m.user_id = v_uid
                    AND m.license_status = 'active' AND m.role IN ('broker', 'admin')) THEN
    RAISE EXCEPTION 'Not authorized' USING ERRCODE = '42501';
  END IF;
  -- The billing-only login (invite + email) ships in PR-4.
  IF coalesce(p_billing_login, false) THEN
    RETURN jsonb_build_object('success', false, 'error', 'billing_login_not_available');
  END IF;

  IF v_who = 'me' THEN
    SELECT coalesce(nullif(btrim(u.display_name), ''), nullif(btrim(concat_ws(' ', u.first_name, u.last_name)), ''), u.email),
           u.email
      INTO v_name, v_email
      FROM public.users u WHERE u.id = v_uid;
  ELSIF v_who = 'other' THEN
    v_name := nullif(btrim(coalesce(p_contact ->> 'name', '')), '');
    v_email := nullif(btrim(coalesce(p_contact ->> 'email', '')), '');
  ELSE
    RETURN jsonb_build_object('success', false, 'error', 'invalid_contact');
  END IF;
  IF v_name IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'contact_name_required');
  END IF;
  IF v_email IS NULL OR position('@' in v_email) < 2 THEN
    RETURN jsonb_build_object('success', false, 'error', 'contact_email_required');
  END IF;
  v_phone := public._billing_normalize_phone(p_contact ->> 'phone');
  IF v_phone IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'invalid_phone');
  END IF;
  IF v_legal IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'company_name_required');
  END IF;
  IF v_line1 IS NULL OR v_city IS NULL OR v_postal IS NULL OR v_country IS NULL OR v_country !~ '^[A-Z]{2}$'
     OR (v_country = 'US' AND v_region IS NULL) THEN
    RETURN jsonb_build_object('success', false, 'error', 'billing_address_required');
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('billing_org:' || p_org::text, 0));
  SELECT * INTO v_deal FROM public.org_deals WHERE organization_id = p_org FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'no_deal');
  END IF;
  IF v_deal.status = 'suspended' THEN
    RETURN jsonb_build_object('success', false, 'error', 'account_suspended');
  END IF;
  IF v_deal.status <> 'draft' THEN
    RETURN jsonb_build_object('success', false, 'error', 'not_waiting', 'status', v_deal.status);
  END IF;
  -- The broker confirms the price they saw: refuse if staff changed the deal since.
  IF p_expected_version IS DISTINCT FROM v_deal.version THEN
    RETURN jsonb_build_object('success', false, 'error', 'version_conflict', 'version', v_deal.version);
  END IF;
  -- Terms of Service and this order accepted by the caller for THIS deal version.
  IF NOT EXISTS (SELECT 1 FROM public.org_terms_acceptances a
                  WHERE a.organization_id = p_org AND a.user_id = v_uid
                    AND a.deal_version = v_deal.version) THEN
    RETURN jsonb_build_object('success', false, 'error', 'terms_not_accepted');
  END IF;
  IF v_deal.stripe_mode = 'live' AND NOT public._billing_brokerage_live() THEN
    RETURN jsonb_build_object('success', false, 'error', 'billing_not_live');
  END IF;

  v_contact := public._org_billing_contact_set(p_org, v_name, v_email, v_phone, v_uid);

  INSERT INTO public.org_billing_profile (organization_id, legal_name, address_line1, address_line2, city,
    region, postal_code, country, po_number, updated_by, updated_at)
  VALUES (p_org, v_legal, v_line1, v_line2, v_city, v_region, v_postal, v_country, v_po, v_uid, now())
  ON CONFLICT (organization_id) DO UPDATE SET
    legal_name = EXCLUDED.legal_name, address_line1 = EXCLUDED.address_line1,
    address_line2 = EXCLUDED.address_line2, city = EXCLUDED.city, region = EXCLUDED.region,
    postal_code = EXCLUDED.postal_code, country = EXCLUDED.country, po_number = EXCLUDED.po_number,
    updated_by = EXCLUDED.updated_by, updated_at = EXCLUDED.updated_at;

  -- status AND version in one UPDATE: the 3853 trigger enqueues exactly one sync row.
  v_starts := greatest(public._billing_business_date(), v_deal.start_date);
  UPDATE public.org_deals SET
    status = 'active',
    version = version + 1,
    billing_starts_on = v_starts,
    setup_completed_at = now(),
    setup_completed_by = v_uid,
    updated_at = now(),
    updated_by = v_uid
  WHERE organization_id = p_org
  RETURNING version INTO v_version;

  PERFORM public._billing_apply_org_entitlement(p_org);

  INSERT INTO public.billing_change_log (organization_id, actor_id, action, detail)
  VALUES (p_org, v_uid, 'setup_completed', jsonb_build_object('version', v_version,
          'billing_starts_on', v_starts, 'start_date', v_deal.start_date, 'contact_id', v_contact));

  RETURN jsonb_build_object('success', true, 'version', v_version, 'billing_starts_on', v_starts);
END
$function$;
REVOKE EXECUTE ON FUNCTION public.broker_complete_billing_setup(uuid, integer, jsonb, jsonb, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.broker_complete_billing_setup(uuid, integer, jsonb, jsonb, boolean) TO authenticated, service_role;

DO $chk$
BEGIN
  IF md5(pg_get_functiondef('public.broker_complete_billing_setup(uuid,integer,jsonb,jsonb,boolean)'::regprocedure))
     <> 'aeb580b568e706b950e759b309df784d' THEN
    RAISE EXCEPTION 'rollback-4007-pr4: broker_complete_billing_setup md5 is not the PR-1 body';
  END IF;
END $chk$;

-- _org_billing_contact_set back to the 4007 PR-1 body (verbatim from 20261020100000).
CREATE OR REPLACE FUNCTION public._org_billing_contact_set(
  p_org uuid, p_name text, p_email text, p_phone text, p_actor uuid)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
  v_email text := nullif(btrim(coalesce(p_email, '')), '');
  v_name text := nullif(btrim(coalesce(p_name, '')), '');
  v_cur public.org_contacts%ROWTYPE;
  v_id uuid;
BEGIN
  IF v_email IS NULL THEN
    RAISE EXCEPTION '_org_billing_contact_set: email required';
  END IF;
  SELECT * INTO v_cur FROM public.org_contacts c
   WHERE c.organization_id = p_org AND c.role = 'billing' AND c.removed_at IS NULL FOR UPDATE;
  IF FOUND AND lower(v_cur.email) = lower(v_email) THEN
    UPDATE public.org_contacts SET
      full_name = coalesce(v_name, full_name),
      email = v_email,
      phone = coalesce(p_phone, phone),
      updated_by = p_actor,
      updated_at = now()
    WHERE id = v_cur.id
    RETURNING id INTO v_id;
  ELSE
    IF FOUND THEN
      UPDATE public.org_contacts SET removed_at = now(), updated_by = p_actor, updated_at = now()
       WHERE id = v_cur.id;
    END IF;
    INSERT INTO public.org_contacts (organization_id, role, full_name, email, phone, created_by, updated_by)
    VALUES (p_org, 'billing', coalesce(v_name, v_email), v_email, p_phone, p_actor, p_actor)
    RETURNING id INTO v_id;
  END IF;
  -- Not version or status: the 3853 enqueue trigger (UPDATE OF version, status) does not fire.
  UPDATE public.org_deals d SET
    billing_contact_id = v_id,
    billing_contact_name = c.full_name,
    billing_contact_email = c.email
  FROM public.org_contacts c
  WHERE d.organization_id = p_org AND c.id = v_id;
  RETURN v_id;
END
$function$;
REVOKE EXECUTE ON FUNCTION public._org_billing_contact_set(uuid, text, text, text, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public._org_billing_contact_set(uuid, text, text, text, uuid) TO service_role;
DO $chk$
BEGIN
  IF md5(pg_get_functiondef('public._org_billing_contact_set(uuid,text,text,text,uuid)'::regprocedure))
     <> '767b797cbdc3ce12ec5754b771da3ac7' THEN
    RAISE EXCEPTION 'rollback-4007-pr4: _org_billing_contact_set md5 is not the PR-1 body';
  END IF;
END $chk$;

-- set_member_license: the body before this PR (md5 39e4d29c).
CREATE OR REPLACE FUNCTION public.set_member_license(p_member_id uuid, p_action text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_uid          uuid := auth.uid();
  v_org_id       uuid;
  v_personal     boolean;
  v_target       record;
  v_caller_role  text;
  v_new_status   text;
  v_managers     integer;
BEGIN
  IF v_uid IS NULL OR p_member_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'not_authorized');
  END IF;
  IF p_action IS NULL OR p_action NOT IN ('assign', 'unassign', 'reactivate') THEN
    RETURN jsonb_build_object('success', false, 'error', 'invalid_transition');
  END IF;

  SELECT m.organization_id INTO v_org_id
    FROM public.organization_members m WHERE m.id = p_member_id;
  IF v_org_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'not_authorized');
  END IF;

  -- Lock first: every count and status read below is taken under it.
  SELECT o.personal_owner_user_id IS NOT NULL INTO v_personal
    FROM public.organizations o WHERE o.id = v_org_id
    FOR NO KEY UPDATE;

  SELECT m.role INTO v_caller_role
    FROM public.organization_members m
   WHERE m.organization_id = v_org_id
     AND m.user_id = v_uid
     AND public.member_status_grants_access(m.license_status);
  IF v_caller_role IS NULL
     OR v_caller_role NOT IN ('broker', 'admin', 'it_admin')
     OR (p_action = 'reactivate' AND v_caller_role NOT IN ('admin', 'it_admin')) THEN
    RETURN jsonb_build_object('success', false, 'error', 'not_authorized');
  END IF;

  SELECT m.id, m.user_id, m.role, m.license_status INTO v_target
    FROM public.organization_members m
   WHERE m.id = p_member_id AND m.organization_id = v_org_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'not_authorized');
  END IF;
  IF v_target.user_id = v_uid THEN
    RETURN jsonb_build_object('success', false, 'error', 'not_authorized', 'reason', 'own_membership');
  END IF;
  IF v_target.role = 'it_admin' AND v_caller_role <> 'it_admin' THEN
    RETURN jsonb_build_object('success', false, 'error', 'not_authorized');
  END IF;
  IF v_personal IS DISTINCT FROM false OR v_target.user_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'invalid_transition');
  END IF;

  IF p_action = 'assign' AND v_target.license_status = 'unassigned' THEN
    v_new_status := 'active';
  ELSIF p_action = 'unassign' AND v_target.license_status = 'active' THEN
    v_new_status := 'unassigned';
  ELSIF p_action = 'reactivate' AND public.member_status_is_deactivated(v_target.license_status) THEN
    v_new_status := 'active';
  ELSE
    RETURN jsonb_build_object('success', false, 'error', 'invalid_transition');
  END IF;

  IF v_new_status = 'unassigned' AND v_target.role IN ('broker', 'admin', 'it_admin') THEN
    SELECT count(*) INTO v_managers
      FROM public.organization_members m
     WHERE m.organization_id = v_org_id
       AND m.id <> v_target.id
       AND m.user_id IS NOT NULL
       AND m.role IN ('broker', 'admin', 'it_admin')
       AND public.member_status_grants_access(m.license_status);
    IF v_managers = 0 THEN
      RETURN jsonb_build_object('success', false, 'error', 'last_manager');
    END IF;
  END IF;

  BEGIN
    UPDATE public.organization_members
       SET license_status = v_new_status
     WHERE id = v_target.id;
  EXCEPTION WHEN SQLSTATE 'P0001' THEN
    IF SQLERRM = 'seat_limit_reached' THEN
      RETURN jsonb_build_object('success', false, 'error', 'seat_limit_reached', 'action', p_action);
    END IF;
    RAISE;
  END;

  RETURN jsonb_build_object('success', true, 'member_id', v_target.id, 'license_status', v_new_status);
END;
$function$;
REVOKE EXECUTE ON FUNCTION public.set_member_license(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_member_license(uuid, text) TO authenticated, service_role;
DO $chk_sml$
BEGIN
  IF md5(pg_get_functiondef('public.set_member_license(uuid,text)'::regprocedure))
     <> '39e4d29c33710ff4adaa169caeac77ba' THEN
    RAISE EXCEPTION 'rollback-4007-pr4: set_member_license md5 is not the pre-PR-4 body';
  END IF;
END $chk_sml$;

DELETE FROM supabase_migrations.schema_migrations WHERE version = '20261020180000';

COMMIT;
