-- BACKLOG-4007 PR-4: brokerage people (IT, office, MSP contacts), the one billing-only login,
-- and the check that lets that login open Billing.
--
-- 1. _org_contact_caller          who is calling for this brokerage: 'staff' (billing.view /
--                                  billing.manage), 'broker' (active broker or admin member of
--                                  the brokerage), or NULL. IT admins and agents get NULL.
-- 2. org_contacts_list            the brokerage's live contacts, plus its members for "Select
--                                  existing user" (staff and broker/admin).
-- 3. admin_search_users_for_contact  staff only: Keepr users by name or email, each marked
--                                  in this brokerage / no brokerage / in another brokerage.
-- 4. org_contact_save             add or change a contact. role it (one live) | office (many)
--                                  | msp (many, company required) | billing (the billing contact,
--                                  through _org_billing_contact_set, phone required, only after
--                                  setup). "Select existing user" passes user_id: a member of
--                                  THIS brokerage is linked (member_id); a user in another
--                                  brokerage is refused; staff may pick a user with no brokerage
--                                  (contact only). A matching member row of this brokerage is
--                                  linked by email too, so an MSP person invited first is linked.
-- 5. org_contact_remove           removes an IT / office / MSP contact. The billing contact
--                                  is changed, never removed.
-- 6. _org_billing_login_create    the one billing-only login: an invitation with license
--                                  'unassigned' (holds no seat), role agent, linked from the
--                                  billing contact. Refusals are returned, not raised.
-- 7. org_billing_login_set        turn the billing-only login on (6) or off (an unclaimed or
--                                  still-unassigned row is deleted; a licensed one is only
--                                  unlinked).
-- 8. broker_complete_billing_setup (replaced) honours p_billing_login: after the deal is
--                                  active, creates the login for "Someone else". A refusal (an
--                                  open invitation elsewhere, the person is already a member)
--                                  is reported and setup still completes.
-- 9. org_billing_contact_login    true only when the CALLER is the member linked from the live
--                                  billing contact of p_org and that member is still
--                                  'unassigned'. The portal's Billing gate asks this.
--
-- Every change writes billing_change_log. New functions: REVOKE PUBLIC, anon; the public ones
-- GRANT authenticated (auth.uid() checked inside), the helpers service_role only.
-- Pre-check: broker_complete_billing_setup is the 4007 PR-1 body (or this file's).
-- Rollback: supabase/tests/backlog-4007-pr4/rollback-4007-pr4.sql

DO $pre$
DECLARE
  v_md5 text;
  v_src text;
BEGIN
  SELECT md5(pg_get_functiondef(oid)), prosrc INTO v_md5, v_src FROM pg_proc
   WHERE oid = to_regprocedure('public.broker_complete_billing_setup(uuid,integer,jsonb,jsonb,boolean)');
  IF v_md5 IS NULL OR (v_md5 <> 'aeb580b568e706b950e759b309df784d' AND v_src NOT LIKE '%BACKLOG-4007 PR-4%') THEN
    RAISE EXCEPTION '4007 PR-4 pre-check: broker_complete_billing_setup is not the 4007 PR-1 body (md5 %)', v_md5;
  END IF;
  SELECT md5(pg_get_functiondef(oid)) INTO v_md5 FROM pg_proc
   WHERE oid = to_regprocedure('public._org_billing_contact_set(uuid,text,text,text,uuid)');
  IF v_md5 IS DISTINCT FROM '767b797cbdc3ce12ec5754b771da3ac7' THEN
    RAISE EXCEPTION '4007 PR-4 pre-check: _org_billing_contact_set is not the 4007 PR-1 body (md5 %)', v_md5;
  END IF;
  IF to_regclass('public.org_contacts') IS NULL OR to_regclass('public.billing_change_log') IS NULL THEN
    RAISE EXCEPTION '4007 PR-4 pre-check: org_contacts or billing_change_log is missing';
  END IF;
END $pre$;

-- =====================================================================================
-- 1. Who is calling
-- =====================================================================================

CREATE OR REPLACE FUNCTION public._org_contact_caller(p_org uuid, p_write boolean)
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO ''
AS $function$
  SELECT CASE
    WHEN auth.uid() IS NULL THEN NULL
    WHEN public.has_permission(auth.uid(), CASE WHEN p_write THEN 'billing.manage' ELSE 'billing.view' END) THEN 'staff'
    WHEN EXISTS (SELECT 1 FROM public.organization_members m
                  WHERE m.organization_id = p_org AND m.user_id = auth.uid()
                    AND m.license_status = 'active' AND m.role IN ('broker', 'admin')) THEN 'broker'
    ELSE NULL
  END
$function$;
REVOKE EXECUTE ON FUNCTION public._org_contact_caller(uuid, boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public._org_contact_caller(uuid, boolean) TO service_role;

-- A user's brokerage memberships other than p_org (personal organizations do not count).
CREATE OR REPLACE FUNCTION public._org_user_in_other_brokerage(p_user uuid, p_org uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO ''
AS $function$
  SELECT EXISTS (SELECT 1 FROM public.organization_members m
                   JOIN public.organizations o ON o.id = m.organization_id
                  WHERE m.user_id = p_user AND m.organization_id <> p_org
                    AND o.personal_owner_user_id IS NULL
                    AND m.license_status IN ('active', 'pending', 'unassigned'))
$function$;
REVOKE EXECUTE ON FUNCTION public._org_user_in_other_brokerage(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public._org_user_in_other_brokerage(uuid, uuid) TO service_role;

-- =====================================================================================
-- 2. List
-- =====================================================================================

CREATE OR REPLACE FUNCTION public.org_contacts_list(p_org uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
  v_caller text := public._org_contact_caller(p_org, false);
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '42501';
  END IF;
  IF v_caller IS NULL THEN
    RAISE EXCEPTION 'Not authorized' USING ERRCODE = '42501';
  END IF;
  RETURN jsonb_build_object(
    'success', true,
    'can_edit', public._org_contact_caller(p_org, true) IS NOT NULL,
    'deal_status', (SELECT d.status FROM public.org_deals d WHERE d.organization_id = p_org),
    'contacts', coalesce((
      SELECT jsonb_agg(jsonb_build_object(
               'id', c.id, 'role', c.role, 'name', c.full_name, 'email', c.email, 'phone', c.phone,
               'company_name', c.company_name, 'member_id', c.member_id,
               'login', CASE WHEN m.id IS NULL THEN NULL
                             WHEN c.role = 'billing' AND m.license_status = 'unassigned' THEN 'billing_only'
                             ELSE m.role END,
               'login_claimed', m.user_id IS NOT NULL)
             ORDER BY c.role, lower(coalesce(c.company_name, '')), lower(c.full_name))
        FROM public.org_contacts c
        LEFT JOIN public.organization_members m ON m.id = c.member_id AND m.organization_id = p_org
       WHERE c.organization_id = p_org AND c.removed_at IS NULL), '[]'::jsonb),
    'members', coalesce((
      SELECT jsonb_agg(jsonb_build_object(
               'user_id', m.user_id, 'member_id', m.id, 'role', m.role,
               'name', coalesce(nullif(btrim(u.display_name), ''),
                                nullif(btrim(concat_ws(' ', u.first_name, u.last_name)), ''), u.email),
               'email', u.email)
             ORDER BY lower(coalesce(u.display_name, u.email)))
        FROM public.organization_members m
        JOIN public.users u ON u.id = m.user_id
       WHERE m.organization_id = p_org AND m.license_status IN ('active', 'unassigned')), '[]'::jsonb));
END
$function$;
REVOKE EXECUTE ON FUNCTION public.org_contacts_list(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.org_contacts_list(uuid) TO authenticated, service_role;

-- =====================================================================================
-- 3. Staff user search for "Select existing user"
-- =====================================================================================

CREATE OR REPLACE FUNCTION public.admin_search_users_for_contact(p_org uuid, p_query text)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
  v_q text := lower(btrim(coalesce(p_query, '')));
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '42501';
  END IF;
  IF NOT public.has_permission(auth.uid(), 'billing.manage') THEN
    RAISE EXCEPTION 'Not authorized' USING ERRCODE = '42501';
  END IF;
  IF length(v_q) < 2 THEN
    RETURN jsonb_build_object('success', true, 'users', '[]'::jsonb);
  END IF;
  RETURN jsonb_build_object('success', true, 'users', coalesce((
    SELECT jsonb_agg(x ORDER BY x ->> 'name') FROM (
      SELECT jsonb_build_object(
               'user_id', u.id,
               'name', coalesce(nullif(btrim(u.display_name), ''),
                                nullif(btrim(concat_ws(' ', u.first_name, u.last_name)), ''), u.email),
               'email', u.email,
               'status', CASE
                 WHEN EXISTS (SELECT 1 FROM public.organization_members m
                               WHERE m.organization_id = p_org AND m.user_id = u.id) THEN 'this_brokerage'
                 WHEN public._org_user_in_other_brokerage(u.id, p_org) THEN 'other_brokerage'
                 ELSE 'no_brokerage' END) AS x
        FROM public.users u
       WHERE position(v_q IN lower(coalesce(u.email, ''))) > 0
          OR position(v_q IN lower(coalesce(u.display_name, ''))) > 0
          OR position(v_q IN lower(concat_ws(' ', u.first_name, u.last_name))) > 0
       ORDER BY u.email
       LIMIT 10) s), '[]'::jsonb));
END
$function$;
REVOKE EXECUTE ON FUNCTION public.admin_search_users_for_contact(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_search_users_for_contact(uuid, text) TO authenticated, service_role;

-- =====================================================================================
-- 4. Save a contact
-- =====================================================================================

-- p_contact: {"id"?, "role": "it"|"office"|"msp"|"billing", "name", "email", "phone"?,
--             "company_name"? (msp, required), "user_id"? (Select existing user)}
CREATE OR REPLACE FUNCTION public.org_contact_save(p_org uuid, p_contact jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_caller text := public._org_contact_caller(p_org, true);
  v_id uuid := nullif(p_contact ->> 'id', '')::uuid;
  v_role text := p_contact ->> 'role';
  v_name text := nullif(btrim(coalesce(p_contact ->> 'name', '')), '');
  v_email text := lower(nullif(btrim(coalesce(p_contact ->> 'email', '')), ''));
  v_phone_raw text := nullif(btrim(coalesce(p_contact ->> 'phone', '')), '');
  v_phone text;
  v_company text := nullif(btrim(coalesce(p_contact ->> 'company_name', '')), '');
  v_user uuid := nullif(p_contact ->> 'user_id', '')::uuid;
  v_member uuid;
  v_cur public.org_contacts%ROWTYPE;
  v_deal_status text;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '42501';
  END IF;
  IF v_caller IS NULL THEN
    RAISE EXCEPTION 'Not authorized' USING ERRCODE = '42501';
  END IF;
  IF v_role IS NULL OR v_role NOT IN ('it', 'office', 'msp', 'billing') THEN
    RETURN jsonb_build_object('success', false, 'error', 'invalid_role');
  END IF;

  -- Select existing user: name and email come from the account.
  IF v_user IS NOT NULL THEN
    SELECT m.id INTO v_member FROM public.organization_members m
     WHERE m.organization_id = p_org AND m.user_id = v_user
       AND m.license_status IN ('active', 'unassigned');
    IF v_member IS NULL THEN
      -- A broker only picks from their own brokerage; nothing about other users is revealed.
      IF v_caller <> 'staff' OR NOT EXISTS (SELECT 1 FROM public.users u WHERE u.id = v_user) THEN
        RETURN jsonb_build_object('success', false, 'error', 'user_not_found');
      END IF;
      IF public._org_user_in_other_brokerage(v_user, p_org) THEN
        RETURN jsonb_build_object('success', false, 'error', 'user_in_other_brokerage');
      END IF;
    END IF;
    SELECT coalesce(nullif(btrim(u.display_name), ''), nullif(btrim(concat_ws(' ', u.first_name, u.last_name)), ''), u.email),
           lower(u.email)
      INTO v_name, v_email
      FROM public.users u WHERE u.id = v_user;
  END IF;

  IF v_name IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'contact_name_required');
  END IF;
  IF v_email IS NULL OR v_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' THEN
    RETURN jsonb_build_object('success', false, 'error', 'contact_email_required');
  END IF;
  IF v_phone_raw IS NOT NULL THEN
    v_phone := public._billing_normalize_phone(v_phone_raw);
    IF v_phone IS NULL THEN
      RETURN jsonb_build_object('success', false, 'error', 'invalid_phone');
    END IF;
  END IF;
  IF v_role = 'msp' AND v_company IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'company_name_required');
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('org_contacts:' || p_org::text, 0));

  -- The billing contact: the one writer (contact row + deal columns), phone required.
  IF v_role = 'billing' THEN
    SELECT d.status INTO v_deal_status FROM public.org_deals d WHERE d.organization_id = p_org;
    IF v_deal_status IS NULL THEN
      RETURN jsonb_build_object('success', false, 'error', 'no_deal');
    END IF;
    IF v_deal_status = 'draft' THEN
      RETURN jsonb_build_object('success', false, 'error', 'billing_set_in_setup');
    END IF;
    IF v_phone IS NULL THEN
      RETURN jsonb_build_object('success', false, 'error', 'invalid_phone');
    END IF;
    v_id := public._org_billing_contact_set(p_org, v_name, v_email, v_phone, v_uid);
    INSERT INTO public.billing_change_log (organization_id, actor_id, action, detail)
    VALUES (p_org, v_uid, 'contact_saved', jsonb_build_object('role', 'billing', 'contact_id', v_id, 'by', v_caller));
    RETURN jsonb_build_object('success', true, 'id', v_id);
  END IF;

  IF v_id IS NOT NULL THEN
    SELECT * INTO v_cur FROM public.org_contacts c
     WHERE c.id = v_id AND c.organization_id = p_org AND c.removed_at IS NULL FOR UPDATE;
    IF NOT FOUND OR v_cur.role = 'billing' THEN
      RETURN jsonb_build_object('success', false, 'error', 'contact_not_found');
    END IF;
  END IF;

  -- One live IT contact; one live entry per role and email.
  IF v_role = 'it' AND EXISTS (SELECT 1 FROM public.org_contacts c
                                WHERE c.organization_id = p_org AND c.role = 'it' AND c.removed_at IS NULL
                                  AND c.id IS DISTINCT FROM v_id) THEN
    RETURN jsonb_build_object('success', false, 'error', 'it_contact_exists');
  END IF;
  IF EXISTS (SELECT 1 FROM public.org_contacts c
              WHERE c.organization_id = p_org AND c.role = v_role AND c.removed_at IS NULL
                AND lower(c.email) = v_email AND c.id IS DISTINCT FROM v_id) THEN
    RETURN jsonb_build_object('success', false, 'error', 'contact_exists');
  END IF;

  -- The login, if any: the member of THIS brokerage with this account or invited email.
  IF v_member IS NULL THEN
    SELECT m.id INTO v_member FROM public.organization_members m
      LEFT JOIN public.users u ON u.id = m.user_id
     WHERE m.organization_id = p_org
       AND m.license_status IN ('active', 'pending', 'unassigned')
       AND (lower(u.email) = v_email OR lower(m.invited_email) = v_email)
     ORDER BY m.created_at LIMIT 1;
  END IF;

  IF v_id IS NULL THEN
    INSERT INTO public.org_contacts (organization_id, role, full_name, email, phone, company_name, member_id,
                                     created_by, updated_by)
    VALUES (p_org, v_role, v_name, v_email, v_phone, CASE WHEN v_role = 'msp' THEN v_company END, v_member,
            v_uid, v_uid)
    RETURNING id INTO v_id;
  ELSE
    UPDATE public.org_contacts SET
      role = v_role, full_name = v_name, email = v_email, phone = v_phone,
      company_name = CASE WHEN v_role = 'msp' THEN v_company END,
      member_id = v_member, updated_by = v_uid, updated_at = now()
    WHERE id = v_id;
  END IF;

  INSERT INTO public.billing_change_log (organization_id, actor_id, action, detail)
  VALUES (p_org, v_uid, 'contact_saved',
          jsonb_build_object('role', v_role, 'contact_id', v_id, 'company_name', v_company,
                             'linked', v_member IS NOT NULL, 'by', v_caller));
  RETURN jsonb_build_object('success', true, 'id', v_id, 'member_id', v_member);
END
$function$;
REVOKE EXECUTE ON FUNCTION public.org_contact_save(uuid, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.org_contact_save(uuid, jsonb) TO authenticated, service_role;

-- =====================================================================================
-- 5. Remove a contact
-- =====================================================================================

CREATE OR REPLACE FUNCTION public.org_contact_remove(p_org uuid, p_contact_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_caller text := public._org_contact_caller(p_org, true);
  v_cur public.org_contacts%ROWTYPE;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '42501';
  END IF;
  IF v_caller IS NULL THEN
    RAISE EXCEPTION 'Not authorized' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO v_cur FROM public.org_contacts c
   WHERE c.id = p_contact_id AND c.organization_id = p_org AND c.removed_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'contact_not_found');
  END IF;
  IF v_cur.role = 'billing' THEN
    RETURN jsonb_build_object('success', false, 'error', 'billing_contact_required');
  END IF;
  -- The contact only. A login this person has stays; it is managed on the Users page.
  UPDATE public.org_contacts SET removed_at = now(), updated_by = v_uid, updated_at = now() WHERE id = v_cur.id;
  INSERT INTO public.billing_change_log (organization_id, actor_id, action, detail)
  VALUES (p_org, v_uid, 'contact_removed', jsonb_build_object('role', v_cur.role, 'contact_id', v_cur.id, 'by', v_caller));
  RETURN jsonb_build_object('success', true);
END
$function$;
REVOKE EXECUTE ON FUNCTION public.org_contact_remove(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.org_contact_remove(uuid, uuid) TO authenticated, service_role;

-- =====================================================================================
-- 6. The billing-only login
-- =====================================================================================

-- Returns {success, token, email, org_name} or {success:false, error}. Never raises for a
-- refusal; a trigger refusal (e.g. the brokerage is suspended) still raises and the caller
-- decides.
CREATE OR REPLACE FUNCTION public._org_billing_login_create(p_org uuid, p_actor uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
  v_c public.org_contacts%ROWTYPE;
  v_status text;
  v_email text;
  v_user uuid;
  v_token text;
  v_member uuid;
  v_org_name text;
BEGIN
  SELECT d.status INTO v_status FROM public.org_deals d WHERE d.organization_id = p_org;
  IF v_status IS NULL OR v_status = 'draft' THEN
    RETURN jsonb_build_object('success', false, 'error', 'billing_setup_incomplete');
  END IF;
  IF v_status = 'suspended' THEN
    RETURN jsonb_build_object('success', false, 'error', 'account_suspended');
  END IF;
  SELECT * INTO v_c FROM public.org_contacts c
   WHERE c.organization_id = p_org AND c.role = 'billing' AND c.removed_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'no_billing_contact');
  END IF;
  -- One billing-only login per brokerage (founder e4d40740).
  IF v_c.member_id IS NOT NULL AND EXISTS (SELECT 1 FROM public.organization_members m WHERE m.id = v_c.member_id) THEN
    RETURN jsonb_build_object('success', false, 'error', 'billing_login_exists');
  END IF;
  v_email := lower(btrim(v_c.email));
  SELECT u.id INTO v_user FROM public.users u WHERE lower(u.email) = v_email;
  IF EXISTS (SELECT 1 FROM public.organization_members m
              WHERE m.organization_id = p_org
                AND (lower(m.invited_email) = v_email OR (v_user IS NOT NULL AND m.user_id = v_user))) THEN
    RETURN jsonb_build_object('success', false, 'error', 'already_member');
  END IF;
  -- The admin_invite_user duplicate rule: an open invitation anywhere else.
  IF EXISTS (SELECT 1 FROM public.organization_members m
              WHERE lower(m.invited_email) = v_email
                AND (m.license_status = 'pending' OR (m.license_status = 'unassigned' AND m.user_id IS NULL)))
     OR EXISTS (SELECT 1 FROM public.individual_invitations i
                 WHERE lower(i.invited_email) = v_email AND i.accepted_at IS NULL) THEN
    RETURN jsonb_build_object('success', false, 'error', 'duplicate_invitation');
  END IF;
  IF v_user IS NOT NULL AND public._org_user_in_other_brokerage(v_user, p_org) THEN
    RETURN jsonb_build_object('success', false, 'error', 'user_in_other_brokerage');
  END IF;

  v_token := encode(gen_random_bytes(32), 'hex');
  INSERT INTO public.organization_members (
    organization_id, invited_email, role, license_status,
    invitation_token, invitation_expires_at, invited_by, invited_at,
    provisioned_by, provisioning_metadata)
  VALUES (p_org, v_email, 'agent', 'unassigned',
          v_token, now() + interval '7 days', p_actor, now(),
          'invite', jsonb_build_object('billing_only', true))
  RETURNING id INTO v_member;

  UPDATE public.org_contacts SET member_id = v_member, updated_by = p_actor, updated_at = now() WHERE id = v_c.id;
  INSERT INTO public.billing_change_log (organization_id, actor_id, action, detail)
  VALUES (p_org, p_actor, 'billing_login_added', jsonb_build_object('contact_id', v_c.id, 'member_id', v_member));

  SELECT o.name INTO v_org_name FROM public.organizations o WHERE o.id = p_org;
  RETURN jsonb_build_object('success', true, 'token', v_token, 'email', v_email, 'name', v_c.full_name,
                            'org_name', v_org_name);
END
$function$;
REVOKE EXECUTE ON FUNCTION public._org_billing_login_create(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public._org_billing_login_create(uuid, uuid) TO service_role;

-- =====================================================================================
-- 7. Turn the billing-only login on or off
-- =====================================================================================

CREATE OR REPLACE FUNCTION public.org_billing_login_set(p_org uuid, p_enable boolean)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_caller text := public._org_contact_caller(p_org, true);
  v_c public.org_contacts%ROWTYPE;
  v_m public.organization_members%ROWTYPE;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '42501';
  END IF;
  IF v_caller IS NULL THEN
    RAISE EXCEPTION 'Not authorized' USING ERRCODE = '42501';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('org_contacts:' || p_org::text, 0));
  IF coalesce(p_enable, false) THEN
    RETURN public._org_billing_login_create(p_org, v_uid);
  END IF;

  SELECT * INTO v_c FROM public.org_contacts c
   WHERE c.organization_id = p_org AND c.role = 'billing' AND c.removed_at IS NULL FOR UPDATE;
  IF NOT FOUND OR v_c.member_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'no_billing_login');
  END IF;
  SELECT * INTO v_m FROM public.organization_members m WHERE m.id = v_c.member_id AND m.organization_id = p_org;
  UPDATE public.org_contacts SET member_id = NULL, updated_by = v_uid, updated_at = now() WHERE id = v_c.id;
  -- Still billing-only (no license assigned since): the login goes. A licensed member stays.
  IF FOUND AND v_m.license_status = 'unassigned' THEN
    DELETE FROM public.organization_members WHERE id = v_m.id;
  END IF;
  INSERT INTO public.billing_change_log (organization_id, actor_id, action, detail)
  VALUES (p_org, v_uid, 'billing_login_removed',
          jsonb_build_object('contact_id', v_c.id, 'member_id', v_c.member_id, 'by', v_caller));
  RETURN jsonb_build_object('success', true);
END
$function$;
REVOKE EXECUTE ON FUNCTION public.org_billing_login_set(uuid, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.org_billing_login_set(uuid, boolean) TO authenticated, service_role;

-- =====================================================================================
-- 8. broker_complete_billing_setup (replaced, same signature) — BACKLOG-4007 PR-4
-- =====================================================================================

-- p_contact: {"who": "me" | "other", "name"?, "email"?, "phone"}.
-- p_company: {"legal_name", "address_line1", "address_line2"?, "city", "region" (required for
--             US), "postal_code", "country" (ISO alpha-2), "po_number"?}.
-- p_billing_login: give "Someone else" the billing-only login. Refused for "me" before any
-- write. A login refusal after the deal is active does not undo setup; it is returned as
-- billing_login {success:false, error}.
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
  v_login jsonb;
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
  -- The billing-only login is for "Someone else"; the caller already has a full login.
  IF coalesce(p_billing_login, false) AND v_who IS DISTINCT FROM 'other' THEN
    RETURN jsonb_build_object('success', false, 'error', 'billing_login_needs_someone_else');
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

  -- BACKLOG-4007 PR-4: the billing-only login, after the deal is active. A refusal or a
  -- trigger error is reported; setup stays complete.
  IF coalesce(p_billing_login, false) THEN
    BEGIN
      v_login := public._org_billing_login_create(p_org, v_uid);
    EXCEPTION WHEN OTHERS THEN
      v_login := jsonb_build_object('success', false, 'error', 'billing_login_failed');
    END;
  END IF;

  RETURN jsonb_build_object('success', true, 'version', v_version, 'billing_starts_on', v_starts,
                            'billing_login', v_login);
END
$function$;
REVOKE EXECUTE ON FUNCTION public.broker_complete_billing_setup(uuid, integer, jsonb, jsonb, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.broker_complete_billing_setup(uuid, integer, jsonb, jsonb, boolean) TO authenticated, service_role;

-- =====================================================================================
-- 9. May the caller open Billing as this brokerage's billing-only login?
-- =====================================================================================

CREATE OR REPLACE FUNCTION public.org_billing_contact_login(p_org uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO ''
AS $function$
  SELECT auth.uid() IS NOT NULL AND EXISTS (
    SELECT 1 FROM public.org_contacts c
      JOIN public.organization_members m ON m.id = c.member_id
     WHERE c.organization_id = p_org AND c.role = 'billing' AND c.removed_at IS NULL
       AND m.organization_id = p_org AND m.user_id = auth.uid()
       AND m.license_status = 'unassigned')
$function$;
REVOKE EXECUTE ON FUNCTION public.org_billing_contact_login(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.org_billing_contact_login(uuid) TO authenticated, service_role;
COMMENT ON FUNCTION public.org_billing_contact_login(uuid) IS
  'BACKLOG-4007 PR-4: true only for the caller who is the unlicensed member linked from the live billing contact of p_org (the one billing-only login). The broker portal opens /dashboard/billing for that person and nothing else past the floor.';
