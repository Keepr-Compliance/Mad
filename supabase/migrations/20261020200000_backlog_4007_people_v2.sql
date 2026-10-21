-- BACKLOG-4007 People v2: one phone per person (public.user_phones), org_contacts becomes a pure
-- link to a brokerage member, and "Invite new person" from People goes through one RPC.
--
-- Founder 34ff8b68 / 723b63de / 4aa21ea7 and the R7 / R9 decisions on BACKLOG-4007; PM c7c276be;
-- SR plan review R1-R10 (sr-plan-4007-people-v2).
--
--  1. user_phones                   one phone per person (user_id) or per invitation
--                                   (pending_member_id). No client grant at all: every read and
--                                   write goes through a function below.
--  2. Who is calling                _org_people_caller: 'staff' | 'admin' | 'broker' | 'it_admin'
--                                   | NULL. Unlike _org_contact_caller (kept), admin and broker are
--                                   told apart: IT contact / MSP = staff, admin, IT admin (founder
--                                   R7); billing and office = staff, admin, broker (+ office for IT
--                                   admin). Phone writers = staff (billing.manage), admin, broker,
--                                   the person themself (R3: an IT admin writes no phone).
--  3. Phone readers                 _can_read_person_phone: the person, Keepr staff, or an ACTIVE
--                                   admin / broker / IT admin of a brokerage the person belongs to.
--  4. org_contacts reshaped         data step (link by email; RAISE on an unlinkable live billing
--                                   contact of a non-test brokerage, R10a), DROP full_name / email /
--                                   phone, member_id NOT NULL + ON DELETE CASCADE, unique indexes.
--  5. Writers                       _org_billing_contact_link (the billing writer, member-keyed),
--                                   org_contact_remove (R7 for IT / MSP rows),
--                                   _org_billing_contact_set (same signature, resolves an email to a
--                                   member), org_contact_save, org_member_phone_set, my_phone_get /
--                                   my_phone_set, org_people_invite (new person: billing-only login
--                                   or it_admin invitation).
--  6. Readers                       org_contacts_list, broker_get_billing_setup, admin_get_org_billing
--                                   (R1), _org_billing_contact_phone (Stripe sync).
--  7. Setup                         broker_complete_billing_setup (same signature): "Someone else"
--                                   is an existing member or a new billing-only login, always; a
--                                   refusal stops setup before any write. p_billing_login ignored.
--  8. Triggers on organization_members
--                                   - pending phone follows acceptance (R5, C7)
--                                   - SCIM orphan: a member row created for the email of the
--                                     billing-only invitation takes over the contact and phone (R10b)
--                                   - the live billing contact's member row: a client delete is
--                                     refused ("Pick another billing contact first"); an IdP
--                                     deprovision (service-role suspend) or a non-client delete
--                                     moves the contact to the account admin and queues an email;
--                                     no active admin -> the account manager is alerted (R9).
--                                   - it_admin is set by a client only for an active admin / IT
--                                     admin of that brokerage or Keepr staff (R7 DB guard)
--                                   - _guard_billing_login_personal_account reads OLD too (a493cf6f)
--  9. Removed for good              org_billing_login_set(uuid,boolean),
--                                   admin_search_users_for_contact(uuid,text),
--                                   _org_billing_login_create(uuid,uuid) (replaced by
--                                   _org_billing_login_invite).
--
-- Grants (R2): every helper REVOKE ALL FROM PUBLIC, anon, authenticated; GRANT service_role. Every
-- public RPC REVOKE FROM PUBLIC, anon; GRANT authenticated, service_role. search_path '' on every
-- function. No public.users column, grant or trigger changes (3998 guards untouched).
-- Pre-check: each replaced function is the PR-1 / PR-4 body (md5 as applied on keepr-test
-- 2026-10-20) or already this file's.
-- Rollback (keepr-test only): supabase/tests/backlog-4007-people-v2/rollback.sql

DO $pre$
DECLARE
  r record;
  v_md5 text;
  v_src text;
BEGIN
  FOR r IN SELECT * FROM (VALUES
    ('public._org_billing_contact_set(uuid,text,text,text,uuid)', '3002254b50198157b69cfd0f5ac3a469'),
    ('public.org_contacts_list(uuid)', '7886071e1411cea000f6c71c55aa7e6f'),
    ('public.org_contact_save(uuid,jsonb)', 'c41e604d46c7377a2f88faa91132e1aa'),
    ('public.broker_complete_billing_setup(uuid,integer,jsonb,jsonb,boolean)', '7e7e1c7e391dd4ea15d402f22081f336'),
    ('public.broker_get_billing_setup(uuid)', '8ed5395308055e25dd93f9437f8d7a9d'),
    ('public.admin_get_org_billing(uuid)', 'cd6aa411a0765c301102324f1f7c3616'),
    ('public._guard_billing_login_personal_account()', 'a04d1860cd627ccc3e14388cf912bd44'),
    ('public.org_contact_remove(uuid,uuid)', 'dd40abd7082660a9ef984f01a0ad4581')
  ) t(sig, md5) LOOP
    v_md5 := NULL; v_src := NULL;
    SELECT md5(pg_get_functiondef(oid)), prosrc INTO v_md5, v_src FROM pg_proc WHERE oid = to_regprocedure(r.sig);
    IF v_md5 IS NULL OR (v_md5 <> r.md5 AND v_src NOT LIKE '%BACKLOG-4007 People v2%') THEN
      RAISE EXCEPTION '4007 People v2 pre-check: % is not the expected body (md5 %)', r.sig, v_md5;
    END IF;
  END LOOP;
  IF to_regclass('public.org_contacts') IS NULL OR to_regclass('public.billing_outbox') IS NULL THEN
    RAISE EXCEPTION '4007 People v2 pre-check: org_contacts or billing_outbox is missing';
  END IF;
END $pre$;

-- =====================================================================================
-- 1. user_phones
-- =====================================================================================

CREATE TABLE IF NOT EXISTS public.user_phones (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           uuid UNIQUE REFERENCES public.users(id) ON DELETE CASCADE,
  pending_member_id uuid UNIQUE REFERENCES public.organization_members(id) ON DELETE CASCADE,
  phone             text NOT NULL CONSTRAINT user_phones_phone_ck CHECK (phone ~ '^\+[1-9][0-9]{7,14}$'),
  updated_by        uuid,
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT user_phones_one_owner_ck CHECK (num_nonnulls(user_id, pending_member_id) = 1)
);
ALTER TABLE public.user_phones ENABLE ROW LEVEL SECURITY;
-- R2: default privileges give anon and authenticated every right on a new table.
REVOKE ALL ON public.user_phones FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.user_phones TO service_role;
COMMENT ON TABLE public.user_phones IS
  'BACKLOG-4007 People v2: one phone per person (user_id), or per invitation until it is accepted (pending_member_id). No client grant: read through _can_read_person_phone (the person, their brokerage''s active admin/broker/IT admin, Keepr staff), written by my_phone_set / org_member_phone_set / the People RPCs.';

-- =====================================================================================
-- 2. Who is calling
-- =====================================================================================

CREATE OR REPLACE FUNCTION public._org_people_caller(p_org uuid, p_write boolean)
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO ''
AS $function$
  SELECT CASE
    WHEN auth.uid() IS NULL THEN NULL
    WHEN public.has_permission(auth.uid(), CASE WHEN p_write THEN 'billing.manage' ELSE 'billing.view' END) THEN 'staff'
    ELSE (SELECT m.role::text FROM public.organization_members m
           WHERE m.organization_id = p_org AND m.user_id = auth.uid()
             AND m.license_status = 'active' AND m.role IN ('admin', 'broker', 'it_admin')
           ORDER BY CASE m.role WHEN 'admin' THEN 1 WHEN 'it_admin' THEN 2 ELSE 3 END
           LIMIT 1)
  END
$function$;
REVOKE ALL ON FUNCTION public._org_people_caller(uuid, boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public._org_people_caller(uuid, boolean) TO service_role;

-- =====================================================================================
-- 3. Phone readers
-- =====================================================================================

CREATE OR REPLACE FUNCTION public._can_read_person_phone(p_target_user uuid, p_target_member uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO ''
AS $function$
  SELECT auth.uid() IS NOT NULL AND (
       (p_target_user IS NOT NULL AND p_target_user = auth.uid())
    OR public.has_internal_role(auth.uid())
    OR EXISTS (
         SELECT 1 FROM public.organization_members t
           JOIN public.organization_members c ON c.organization_id = t.organization_id
          WHERE ((p_target_user IS NOT NULL AND t.user_id = p_target_user)
                 OR (p_target_member IS NOT NULL AND t.id = p_target_member))
            AND c.user_id = auth.uid()
            AND c.license_status = 'active'
            AND c.role IN ('admin', 'broker', 'it_admin')))
$function$;
REVOKE ALL ON FUNCTION public._can_read_person_phone(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public._can_read_person_phone(uuid, uuid) TO service_role;

-- The phone of a member row (their account's phone, or the invitation's pending phone), only
-- when the caller may read it.
CREATE OR REPLACE FUNCTION public._member_phone(p_member uuid)
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO ''
AS $function$
  SELECT p.phone
    FROM public.organization_members m
    JOIN public.user_phones p ON (m.user_id IS NOT NULL AND p.user_id = m.user_id)
                              OR (m.user_id IS NULL AND p.pending_member_id = m.id)
   WHERE m.id = p_member
     AND public._can_read_person_phone(m.user_id, m.id)
   LIMIT 1
$function$;
REVOKE ALL ON FUNCTION public._member_phone(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public._member_phone(uuid) TO service_role;

-- Name and email of a member row: the account if claimed, else the invitation.
CREATE OR REPLACE FUNCTION public._member_person(p_member uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO ''
AS $function$
  SELECT jsonb_build_object(
           'name', coalesce(nullif(btrim(u.display_name), ''),
                            nullif(btrim(concat_ws(' ', u.first_name, u.last_name)), ''),
                            nullif(btrim(concat_ws(' ', m.invited_first_name, m.invited_last_name)), ''),
                            u.email, m.invited_email),
           'email', lower(coalesce(u.email, m.invited_email)))
    FROM public.organization_members m
    LEFT JOIN public.users u ON u.id = m.user_id
   WHERE m.id = p_member
$function$;
REVOKE ALL ON FUNCTION public._member_person(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public._member_person(uuid) TO service_role;

-- Write (or with NULL, clear) the phone of a member row: on the account if claimed, else pending.
CREATE OR REPLACE FUNCTION public._member_phone_put(p_member uuid, p_phone text, p_actor uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
  v_user uuid;
BEGIN
  SELECT m.user_id INTO v_user FROM public.organization_members m WHERE m.id = p_member;
  IF NOT FOUND THEN
    RAISE EXCEPTION '_member_phone_put: member not found';
  END IF;
  IF v_user IS NOT NULL THEN
    IF p_phone IS NULL THEN
      DELETE FROM public.user_phones WHERE user_id = v_user;
    ELSE
      INSERT INTO public.user_phones (user_id, phone, updated_by) VALUES (v_user, p_phone, p_actor)
      ON CONFLICT (user_id) DO UPDATE SET phone = EXCLUDED.phone, updated_by = EXCLUDED.updated_by, updated_at = now();
    END IF;
  ELSE
    IF p_phone IS NULL THEN
      DELETE FROM public.user_phones WHERE pending_member_id = p_member;
    ELSE
      INSERT INTO public.user_phones (pending_member_id, phone, updated_by) VALUES (p_member, p_phone, p_actor)
      ON CONFLICT (pending_member_id) DO UPDATE SET phone = EXCLUDED.phone, updated_by = EXCLUDED.updated_by, updated_at = now();
    END IF;
  END IF;
END
$function$;
REVOKE ALL ON FUNCTION public._member_phone_put(uuid, text, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public._member_phone_put(uuid, text, uuid) TO service_role;

-- R6: the member's role is owned by the identity provider (group mapping on for the brokerage,
-- and the member not opted out). One helper; BACKLOG-4027 reuses it.
CREATE OR REPLACE FUNCTION public._member_role_idp_managed(p_member uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO ''
AS $function$
  SELECT EXISTS (
    SELECT 1 FROM public.organization_members m
      JOIN public.organization_identity_providers idp ON idp.organization_id = m.organization_id
     WHERE m.id = p_member
       AND coalesce(idp.attribute_mapping ->> 'group_sync_enabled', '') = 'true'
       AND coalesce(m.group_sync_enabled, true))
$function$;
REVOKE ALL ON FUNCTION public._member_role_idp_managed(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public._member_role_idp_managed(uuid) TO service_role;

-- The brokerage's account admin (founder R9 refinement): the admin who completed billing setup
-- if still an active admin with an account, else the oldest active admin. Never p_exclude.
-- Role 'admin' only (a broker who completed setup does not count).
CREATE OR REPLACE FUNCTION public._org_account_admin_member(p_org uuid, p_exclude uuid)
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO ''
AS $function$
  SELECT m.id
    FROM public.organization_members m
    LEFT JOIN public.org_deals d ON d.organization_id = m.organization_id
   WHERE m.organization_id = p_org
     AND m.role = 'admin' AND m.license_status = 'active' AND m.user_id IS NOT NULL
     AND m.id IS DISTINCT FROM p_exclude
   ORDER BY (m.user_id = d.setup_completed_by) DESC NULLS LAST, m.created_at, m.id
   LIMIT 1
$function$;
REVOKE ALL ON FUNCTION public._org_account_admin_member(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public._org_account_admin_member(uuid, uuid) TO service_role;

-- =====================================================================================
-- 4. org_contacts: data step, then the new shape
-- =====================================================================================

-- Link each contact without a member to a member of the same brokerage with that email (an
-- account or an invitation). Its phone moves to user_phones when the person has none.
DO $data$
DECLARE
  c record;
  v_member uuid;
  v_user uuid;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema = 'public' AND table_name = 'org_contacts' AND column_name = 'email') THEN
    RETURN;  -- already reshaped
  END IF;
  FOR c IN EXECUTE 'SELECT c.id, c.organization_id, c.role, c.email, c.phone, c.member_id, c.removed_at, o.is_test
                      FROM public.org_contacts c JOIN public.organizations o ON o.id = c.organization_id' LOOP
    v_member := c.member_id;
    IF v_member IS NULL THEN
      SELECT m.id INTO v_member FROM public.organization_members m
        LEFT JOIN public.users u ON u.id = m.user_id
       WHERE m.organization_id = c.organization_id
         AND m.license_status IN ('active', 'pending', 'unassigned')
         AND (lower(u.email) = lower(c.email) OR lower(m.invited_email) = lower(c.email))
       ORDER BY (m.license_status = 'active') DESC, m.created_at LIMIT 1;
      IF v_member IS NOT NULL THEN
        UPDATE public.org_contacts SET member_id = v_member WHERE id = c.id;
      END IF;
    END IF;
    IF v_member IS NULL THEN
      -- R10a: never silently lose the live billing contact of a real brokerage.
      IF c.role = 'billing' AND c.removed_at IS NULL AND NOT coalesce(c.is_test, false) THEN
        RAISE EXCEPTION '4007 People v2: live billing contact % of organization % is not a member; link it before applying', c.id, c.organization_id;
      END IF;
      DELETE FROM public.org_contacts WHERE id = c.id;
      CONTINUE;
    END IF;
    IF c.phone IS NOT NULL AND c.removed_at IS NULL THEN
      SELECT m.user_id INTO v_user FROM public.organization_members m WHERE m.id = v_member;
      IF v_user IS NOT NULL THEN
        INSERT INTO public.user_phones (user_id, phone) VALUES (v_user, c.phone) ON CONFLICT (user_id) DO NOTHING;
      ELSE
        INSERT INTO public.user_phones (pending_member_id, phone) VALUES (v_member, c.phone) ON CONFLICT (pending_member_id) DO NOTHING;
      END IF;
    END IF;
  END LOOP;
  -- One person once per live slot: keep the oldest.
  UPDATE public.org_contacts x SET removed_at = now()
   WHERE x.removed_at IS NULL AND EXISTS (
     SELECT 1 FROM public.org_contacts y
      WHERE y.organization_id = x.organization_id AND y.role = x.role AND y.member_id = x.member_id
        AND y.removed_at IS NULL AND (y.created_at, y.id) < (x.created_at, x.id));
  -- The deal cache of a deal whose contact went.
  UPDATE public.org_deals d SET billing_contact_name = NULL, billing_contact_email = NULL
   WHERE d.billing_contact_id IS NULL AND d.billing_contact_email IS NOT NULL
     AND EXISTS (SELECT 1 FROM public.organizations o WHERE o.id = d.organization_id AND o.is_test);
END $data$;

ALTER TABLE public.org_contacts
  DROP COLUMN IF EXISTS full_name,
  DROP COLUMN IF EXISTS email,
  DROP COLUMN IF EXISTS phone;
ALTER TABLE public.org_contacts ALTER COLUMN member_id SET NOT NULL;
ALTER TABLE public.org_contacts DROP CONSTRAINT IF EXISTS org_contacts_member_id_fkey;
ALTER TABLE public.org_contacts
  ADD CONSTRAINT org_contacts_member_id_fkey FOREIGN KEY (member_id)
  REFERENCES public.organization_members(id) ON DELETE CASCADE;
CREATE UNIQUE INDEX IF NOT EXISTS org_contacts_one_person_per_slot_idx
  ON public.org_contacts (organization_id, role, member_id) WHERE removed_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS org_contacts_one_it_idx
  ON public.org_contacts (organization_id) WHERE role = 'it' AND removed_at IS NULL;
CREATE INDEX IF NOT EXISTS org_contacts_member_idx ON public.org_contacts (member_id);
COMMENT ON TABLE public.org_contacts IS
  'BACKLOG-4007 People v2: a brokerage contact is a link to one of its members (member_id, required; the person''s name, email and phone come from the member and user_phones). One live billing contact and one live IT contact per organization; one person once per slot. company_name for MSP rows.';

-- =====================================================================================
-- 5. Writers
-- =====================================================================================

-- The billing writer: the contact row and the deal cache (billing_contact_id / _name / _email).
-- p_member must be a member of p_org (R4). p_phone NULL = keep the person's phone.
-- A change of person: the old row is marked removed FIRST, then the old billing-only login
-- (still 'unassigned' + billing_only) is deleted unless p_keep_old_login (used while that
-- member row is itself being changed by a trigger).
CREATE OR REPLACE FUNCTION public._org_billing_contact_link(
  p_org uuid, p_member uuid, p_phone text, p_actor uuid, p_keep_old_login boolean DEFAULT false)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
  v_cur public.org_contacts%ROWTYPE;
  v_id uuid;
  v_gone uuid;
  v_person jsonb;
BEGIN
  -- BACKLOG-4007 People v2
  IF NOT EXISTS (SELECT 1 FROM public.organization_members m
                  WHERE m.id = p_member AND m.organization_id = p_org) THEN
    RAISE EXCEPTION 'billing_contact_not_member' USING ERRCODE = 'P0001';
  END IF;
  SELECT * INTO v_cur FROM public.org_contacts c
   WHERE c.organization_id = p_org AND c.role = 'billing' AND c.removed_at IS NULL FOR UPDATE;
  IF FOUND AND v_cur.member_id = p_member THEN
    UPDATE public.org_contacts SET updated_by = p_actor, updated_at = now() WHERE id = v_cur.id;
    v_id := v_cur.id;
  ELSE
    IF FOUND THEN
      UPDATE public.org_contacts SET removed_at = now(), updated_by = p_actor, updated_at = now()
       WHERE id = v_cur.id;
      IF NOT p_keep_old_login THEN
        DELETE FROM public.organization_members m
         WHERE m.id = v_cur.member_id AND m.organization_id = p_org
           AND m.license_status = 'unassigned'
           AND coalesce(m.provisioning_metadata ->> 'billing_only', '') = 'true'
        RETURNING m.id INTO v_gone;
        IF v_gone IS NOT NULL THEN
          INSERT INTO public.billing_change_log (organization_id, actor_id, action, detail)
          VALUES (p_org, p_actor, 'billing_login_removed',
                  jsonb_build_object('contact_id', v_cur.id, 'member_id', v_gone, 'reason', 'contact_changed'));
        END IF;
      END IF;
    END IF;
    INSERT INTO public.org_contacts (organization_id, role, member_id, created_by, updated_by)
    VALUES (p_org, 'billing', p_member, p_actor, p_actor)
    RETURNING id INTO v_id;
  END IF;
  IF p_phone IS NOT NULL THEN
    PERFORM public._member_phone_put(p_member, p_phone, p_actor);
  END IF;
  v_person := public._member_person(p_member);
  -- Not version or status: the 3853 enqueue trigger (UPDATE OF version, status) does not fire.
  UPDATE public.org_deals SET
    billing_contact_id = v_id,
    billing_contact_name = v_person ->> 'name',
    billing_contact_email = v_person ->> 'email'
  WHERE organization_id = p_org;
  RETURN v_id;
END
$function$;
REVOKE ALL ON FUNCTION public._org_billing_contact_link(uuid, uuid, text, uuid, boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public._org_billing_contact_link(uuid, uuid, text, uuid, boolean) TO service_role;

-- Same signature as PR-1 (the deal save calls it): the email must be a member of p_org.
CREATE OR REPLACE FUNCTION public._org_billing_contact_set(
  p_org uuid, p_name text, p_email text, p_phone text, p_actor uuid)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
  v_email text := lower(nullif(btrim(coalesce(p_email, '')), ''));
  v_member uuid;
BEGIN
  -- BACKLOG-4007 People v2: a billing contact is a member; p_name is ignored (the member's).
  IF v_email IS NULL THEN
    RAISE EXCEPTION '_org_billing_contact_set: email required';
  END IF;
  SELECT m.id INTO v_member FROM public.organization_members m
    LEFT JOIN public.users u ON u.id = m.user_id
   WHERE m.organization_id = p_org
     AND m.license_status IN ('active', 'pending', 'unassigned')
     AND (lower(u.email) = v_email OR lower(m.invited_email) = v_email)
   ORDER BY (m.user_id IS NOT NULL) DESC, m.created_at LIMIT 1;
  IF v_member IS NULL THEN
    RAISE EXCEPTION 'billing_contact_not_member' USING ERRCODE = 'P0001';
  END IF;
  RETURN public._org_billing_contact_link(p_org, v_member, p_phone, p_actor);
END
$function$;
REVOKE ALL ON FUNCTION public._org_billing_contact_set(uuid, text, text, text, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public._org_billing_contact_set(uuid, text, text, text, uuid) TO service_role;

-- Why a new person cannot be given the billing-only login, or NULL. The admin_invite_user
-- duplicate rules plus founder F6 (has_personal_account).
CREATE OR REPLACE FUNCTION public._org_billing_login_refusal(p_org uuid, p_email text)
RETURNS text
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
  v_email text := lower(btrim(coalesce(p_email, '')));
  v_user uuid;
BEGIN
  SELECT u.id INTO v_user FROM public.users u WHERE lower(u.email) = v_email;
  IF EXISTS (SELECT 1 FROM public.organization_members m
              WHERE m.organization_id = p_org
                AND (lower(m.invited_email) = v_email OR (v_user IS NOT NULL AND m.user_id = v_user))) THEN
    RETURN 'already_member';
  END IF;
  IF EXISTS (SELECT 1 FROM public.organization_members m
              WHERE lower(m.invited_email) = v_email
                AND (m.license_status = 'pending' OR (m.license_status = 'unassigned' AND m.user_id IS NULL)))
     OR EXISTS (SELECT 1 FROM public.individual_invitations i
                 WHERE lower(i.invited_email) = v_email AND i.accepted_at IS NULL) THEN
    RETURN 'duplicate_invitation';
  END IF;
  IF v_user IS NOT NULL AND public._org_user_in_other_brokerage(v_user, p_org) THEN
    RETURN 'user_in_other_brokerage';
  END IF;
  IF v_user IS NOT NULL AND public._user_has_personal_account(v_user) THEN
    RETURN 'has_personal_account';
  END IF;
  RETURN NULL;
END
$function$;
REVOKE ALL ON FUNCTION public._org_billing_login_refusal(uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public._org_billing_login_refusal(uuid, text) TO service_role;

-- A new member row (invitation). p_kind 'billing' = the billing-only login ('unassigned',
-- provisioning_metadata.billing_only, holds no seat); 'it_admin' = an IT admin invitation
-- ('pending', holds a seat: the seat trigger refuses a full brokerage). Nothing from the client
-- decides role, license, provisioned_by or metadata (R8b). Returns the member id.
CREATE OR REPLACE FUNCTION public._org_people_invite_row(
  p_org uuid, p_kind text, p_email text, p_first text, p_last text, p_actor uuid, OUT member_id uuid, OUT token text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
BEGIN
  IF p_kind NOT IN ('billing', 'it_admin') THEN
    RAISE EXCEPTION '_org_people_invite_row: bad kind';
  END IF;
  token := encode(extensions.gen_random_bytes(32), 'hex');
  INSERT INTO public.organization_members (
    organization_id, invited_email, role, license_status,
    invitation_token, invitation_expires_at, invited_by, invited_at,
    provisioned_by, provisioning_metadata, invited_first_name, invited_last_name)
  VALUES (p_org, lower(btrim(p_email)),
          CASE p_kind WHEN 'billing' THEN 'agent' ELSE 'it_admin' END,
          CASE p_kind WHEN 'billing' THEN 'unassigned' ELSE 'pending' END,
          token, now() + interval '7 days', p_actor, now(),
          'invite',
          CASE p_kind WHEN 'billing' THEN jsonb_build_object('billing_only', true) ELSE NULL END,
          nullif(btrim(coalesce(p_first, '')), ''), nullif(btrim(coalesce(p_last, '')), ''))
  RETURNING id INTO member_id;
END
$function$;
REVOKE ALL ON FUNCTION public._org_people_invite_row(uuid, text, text, text, text, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public._org_people_invite_row(uuid, text, text, text, text, uuid) TO service_role;

-- p_contact: {"id"?, "role": "it"|"office"|"msp"|"billing", "member_id" | "user_id",
--             "phone"?, "company_name"? (msp), "confirm_role_change"? (it/msp)}
CREATE OR REPLACE FUNCTION public.org_contact_save(p_org uuid, p_contact jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_caller text := public._org_people_caller(p_org, true);
  v_id uuid := nullif(p_contact ->> 'id', '')::uuid;
  v_role text := p_contact ->> 'role';
  v_member_in uuid := nullif(p_contact ->> 'member_id', '')::uuid;
  v_user_in uuid := nullif(p_contact ->> 'user_id', '')::uuid;
  v_phone_raw text := nullif(btrim(coalesce(p_contact ->> 'phone', '')), '');
  v_phone text;
  v_company text := nullif(btrim(coalesce(p_contact ->> 'company_name', '')), '');
  v_confirm boolean := coalesce((p_contact ->> 'confirm_role_change')::boolean, false);
  v_m public.organization_members%ROWTYPE;
  v_cur public.org_contacts%ROWTYPE;
  v_deal_status text;
  v_role_changed boolean := false;
BEGIN
  -- BACKLOG-4007 People v2
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '42501';
  END IF;
  IF v_caller IS NULL THEN
    RAISE EXCEPTION 'Not authorized' USING ERRCODE = '42501';
  END IF;
  IF v_role IS NULL OR v_role NOT IN ('it', 'office', 'msp', 'billing') THEN
    RETURN jsonb_build_object('success', false, 'error', 'invalid_role');
  END IF;
  -- Billing: staff, admin, broker. IT contact / MSP: staff, admin, IT admin (founder R7).
  IF (v_role = 'billing' AND v_caller NOT IN ('staff', 'admin', 'broker'))
     OR (v_role IN ('it', 'msp') AND v_caller NOT IN ('staff', 'admin', 'it_admin')) THEN
    RAISE EXCEPTION 'Not authorized' USING ERRCODE = '42501';
  END IF;
  -- R3: an IT admin writes no phone.
  IF v_phone_raw IS NOT NULL AND v_caller NOT IN ('staff', 'admin', 'broker') THEN
    RAISE EXCEPTION 'Not authorized' USING ERRCODE = '42501';
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

  -- The person: a member of THIS brokerage (R4).
  SELECT * INTO v_m FROM public.organization_members m
   WHERE m.organization_id = p_org
     AND ((v_member_in IS NOT NULL AND m.id = v_member_in)
          OR (v_member_in IS NULL AND v_user_in IS NOT NULL AND m.user_id = v_user_in))
     AND m.license_status IN ('active', 'pending', 'unassigned')
   FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'user_not_found');
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('org_contacts:' || p_org::text, 0));

  IF v_role = 'billing' THEN
    SELECT d.status INTO v_deal_status FROM public.org_deals d WHERE d.organization_id = p_org;
    IF v_deal_status IS NULL THEN
      RETURN jsonb_build_object('success', false, 'error', 'no_deal');
    END IF;
    IF v_deal_status = 'draft' THEN
      RETURN jsonb_build_object('success', false, 'error', 'billing_set_in_setup');
    END IF;
    -- A phone is required: supplied now, or the person already has one.
    IF v_phone IS NULL AND NOT EXISTS (
         SELECT 1 FROM public.user_phones p
          WHERE (v_m.user_id IS NOT NULL AND p.user_id = v_m.user_id)
             OR (v_m.user_id IS NULL AND p.pending_member_id = v_m.id)) THEN
      RETURN jsonb_build_object('success', false, 'error', 'invalid_phone');
    END IF;
    v_id := public._org_billing_contact_link(p_org, v_m.id, v_phone, v_uid);
    INSERT INTO public.billing_change_log (organization_id, actor_id, action, detail)
    VALUES (p_org, v_uid, 'contact_saved', jsonb_build_object('role', 'billing', 'contact_id', v_id,
            'member_id', v_m.id, 'phone_set', v_phone IS NOT NULL, 'by', v_caller));
    RETURN jsonb_build_object('success', true, 'id', v_id, 'member_id', v_m.id);
  END IF;

  IF v_id IS NOT NULL THEN
    SELECT * INTO v_cur FROM public.org_contacts c
     WHERE c.id = v_id AND c.organization_id = p_org AND c.removed_at IS NULL FOR UPDATE;
    IF NOT FOUND OR v_cur.role = 'billing' THEN
      RETURN jsonb_build_object('success', false, 'error', 'contact_not_found');
    END IF;
    -- An IT admin edits IT / office / MSP rows only; a broker never edits an IT or MSP row.
    IF (v_cur.role IN ('it', 'msp') AND v_caller NOT IN ('staff', 'admin', 'it_admin')) THEN
      RAISE EXCEPTION 'Not authorized' USING ERRCODE = '42501';
    END IF;
  END IF;

  IF v_role = 'it' AND EXISTS (SELECT 1 FROM public.org_contacts c
                                WHERE c.organization_id = p_org AND c.role = 'it' AND c.removed_at IS NULL
                                  AND c.id IS DISTINCT FROM v_id) THEN
    RETURN jsonb_build_object('success', false, 'error', 'it_contact_exists');
  END IF;
  IF EXISTS (SELECT 1 FROM public.org_contacts c
              WHERE c.organization_id = p_org AND c.role = v_role AND c.removed_at IS NULL
                AND c.member_id = v_m.id AND c.id IS DISTINCT FROM v_id) THEN
    RETURN jsonb_build_object('success', false, 'error', 'contact_exists');
  END IF;

  -- IT contact / MSP person: an it_admin (founder 34ff8b68). Admin and IT admin unchanged.
  IF v_role IN ('it', 'msp') AND v_m.role NOT IN ('admin', 'it_admin') THEN
    -- R8a: the IT contact takes a seat; never an unlicensed or billing-only row.
    IF v_m.license_status <> 'active' OR v_m.user_id IS NULL
       OR coalesce(v_m.provisioning_metadata ->> 'billing_only', '') = 'true' THEN
      RETURN jsonb_build_object('success', false, 'error', 'needs_license');
    END IF;
    IF v_m.user_id = v_uid THEN
      RETURN jsonb_build_object('success', false, 'error', 'cannot_change_own_role');
    END IF;
    IF public._member_role_idp_managed(v_m.id) THEN
      RETURN jsonb_build_object('success', false, 'error', 'managed_by_idp');
    END IF;
    IF NOT v_confirm THEN
      RETURN jsonb_build_object('success', false, 'error', 'role_change_needs_confirm', 'role', v_m.role);
    END IF;
    UPDATE public.organization_members SET role = 'it_admin' WHERE id = v_m.id;
    v_role_changed := true;
    INSERT INTO public.billing_change_log (organization_id, actor_id, action, detail)
    VALUES (p_org, v_uid, 'role_changed', jsonb_build_object('member_id', v_m.id, 'from', v_m.role,
            'to', 'it_admin', 'via', 'people', 'by', v_caller));
  END IF;

  IF v_id IS NULL THEN
    INSERT INTO public.org_contacts (organization_id, role, company_name, member_id, created_by, updated_by)
    VALUES (p_org, v_role, CASE WHEN v_role = 'msp' THEN v_company END, v_m.id, v_uid, v_uid)
    RETURNING id INTO v_id;
  ELSE
    UPDATE public.org_contacts SET
      role = v_role, company_name = CASE WHEN v_role = 'msp' THEN v_company END,
      member_id = v_m.id, updated_by = v_uid, updated_at = now()
    WHERE id = v_id;
  END IF;
  IF v_phone IS NOT NULL THEN
    PERFORM public._member_phone_put(v_m.id, v_phone, v_uid);
  END IF;

  INSERT INTO public.billing_change_log (organization_id, actor_id, action, detail)
  VALUES (p_org, v_uid, 'contact_saved',
          jsonb_build_object('role', v_role, 'contact_id', v_id, 'company_name', v_company,
                             'member_id', v_m.id, 'role_changed', v_role_changed,
                             'phone_set', v_phone IS NOT NULL, 'by', v_caller));
  RETURN jsonb_build_object('success', true, 'id', v_id, 'member_id', v_m.id, 'role_changed', v_role_changed);
END
$function$;
REVOKE EXECUTE ON FUNCTION public.org_contact_save(uuid, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.org_contact_save(uuid, jsonb) TO authenticated, service_role;

-- Remove an IT / office / MSP contact. IT contact and MSP rows: staff, admin, IT admin (R7);
-- office rows: any People writer. The billing contact is changed, never removed. The person's
-- login and role stay (managed on the Users page).
CREATE OR REPLACE FUNCTION public.org_contact_remove(p_org uuid, p_contact_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_caller text := public._org_people_caller(p_org, true);
  v_cur public.org_contacts%ROWTYPE;
BEGIN
  -- BACKLOG-4007 People v2
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
  IF v_cur.role IN ('it', 'msp') AND v_caller NOT IN ('staff', 'admin', 'it_admin') THEN
    RAISE EXCEPTION 'Not authorized' USING ERRCODE = '42501';
  END IF;
  UPDATE public.org_contacts SET removed_at = now(), updated_by = v_uid, updated_at = now() WHERE id = v_cur.id;
  INSERT INTO public.billing_change_log (organization_id, actor_id, action, detail)
  VALUES (p_org, v_uid, 'contact_removed', jsonb_build_object('role', v_cur.role, 'contact_id', v_cur.id, 'by', v_caller));
  RETURN jsonb_build_object('success', true);
END
$function$;
REVOKE EXECUTE ON FUNCTION public.org_contact_remove(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.org_contact_remove(uuid, uuid) TO authenticated, service_role;

-- A brokerage member's phone, from People. Staff (billing.manage), admin, broker (R3).
CREATE OR REPLACE FUNCTION public.org_member_phone_set(p_org uuid, p_member_id uuid, p_phone text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_caller text := public._org_people_caller(p_org, true);
  v_raw text := nullif(btrim(coalesce(p_phone, '')), '');
  v_phone text;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '42501';
  END IF;
  IF v_caller IS NULL OR v_caller NOT IN ('staff', 'admin', 'broker') THEN
    RAISE EXCEPTION 'Not authorized' USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.organization_members m WHERE m.id = p_member_id AND m.organization_id = p_org) THEN
    RETURN jsonb_build_object('success', false, 'error', 'user_not_found');
  END IF;
  IF v_raw IS NOT NULL THEN
    v_phone := public._billing_normalize_phone(v_raw);
    IF v_phone IS NULL THEN
      RETURN jsonb_build_object('success', false, 'error', 'invalid_phone');
    END IF;
  END IF;
  -- The billing contact keeps a phone.
  IF v_phone IS NULL AND EXISTS (SELECT 1 FROM public.org_contacts c
                                  WHERE c.organization_id = p_org AND c.role = 'billing'
                                    AND c.removed_at IS NULL AND c.member_id = p_member_id) THEN
    RETURN jsonb_build_object('success', false, 'error', 'invalid_phone');
  END IF;
  PERFORM public._member_phone_put(p_member_id, v_phone, v_uid);
  INSERT INTO public.billing_change_log (organization_id, actor_id, action, detail)
  VALUES (p_org, v_uid, 'phone_set', jsonb_build_object('member_id', p_member_id, 'cleared', v_phone IS NULL, 'by', v_caller));
  RETURN jsonb_build_object('success', true);
END
$function$;
REVOKE EXECUTE ON FUNCTION public.org_member_phone_set(uuid, uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.org_member_phone_set(uuid, uuid, text) TO authenticated, service_role;

-- My Account: the caller's own phone.
CREATE OR REPLACE FUNCTION public.my_phone_get()
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO ''
AS $function$
  SELECT CASE WHEN auth.uid() IS NULL THEN NULL
    ELSE jsonb_build_object('phone', (SELECT p.phone FROM public.user_phones p WHERE p.user_id = auth.uid())) END
$function$;
REVOKE EXECUTE ON FUNCTION public.my_phone_get() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.my_phone_get() TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.my_phone_set(p_phone text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_raw text := nullif(btrim(coalesce(p_phone, '')), '');
  v_phone text;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.users u WHERE u.id = v_uid) THEN
    RETURN jsonb_build_object('success', false, 'error', 'user_not_found');
  END IF;
  IF v_raw IS NOT NULL THEN
    v_phone := public._billing_normalize_phone(v_raw);
    IF v_phone IS NULL THEN
      RETURN jsonb_build_object('success', false, 'error', 'invalid_phone');
    END IF;
  END IF;
  -- The live billing contact of a brokerage keeps a phone.
  IF v_phone IS NULL AND EXISTS (SELECT 1 FROM public.org_contacts c
                                   JOIN public.organization_members m ON m.id = c.member_id
                                  WHERE c.role = 'billing' AND c.removed_at IS NULL AND m.user_id = v_uid) THEN
    RETURN jsonb_build_object('success', false, 'error', 'billing_contact_phone_required');
  END IF;
  IF v_phone IS NULL THEN
    DELETE FROM public.user_phones WHERE user_id = v_uid;
  ELSE
    INSERT INTO public.user_phones (user_id, phone, updated_by) VALUES (v_uid, v_phone, v_uid)
    ON CONFLICT (user_id) DO UPDATE SET phone = EXCLUDED.phone, updated_by = EXCLUDED.updated_by, updated_at = now();
  END IF;
  RETURN jsonb_build_object('success', true, 'phone', v_phone);
END
$function$;
REVOKE EXECUTE ON FUNCTION public.my_phone_set(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.my_phone_set(text) TO authenticated, service_role;

-- "Invite new person" from People. p_person: {"slot": "billing"|"it"|"msp", "email",
-- "first_name"?, "last_name"?, "phone"?, "company_name"? (msp)}. No other key is read (R8b).
-- billing: staff / admin / broker, after setup; a billing-only login; phone required.
-- it / msp: staff / admin / IT admin (founder R7); an it_admin invitation that holds a seat.
-- Returns {success, token, email, org_name, member_id, slot} so the portal sends the email.
CREATE OR REPLACE FUNCTION public.org_people_invite(p_org uuid, p_person jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_caller text := public._org_people_caller(p_org, true);
  v_slot text := p_person ->> 'slot';
  v_email text := lower(nullif(btrim(coalesce(p_person ->> 'email', '')), ''));
  v_first text := nullif(btrim(coalesce(p_person ->> 'first_name', '')), '');
  v_last text := nullif(btrim(coalesce(p_person ->> 'last_name', '')), '');
  v_phone_raw text := nullif(btrim(coalesce(p_person ->> 'phone', '')), '');
  v_company text := nullif(btrim(coalesce(p_person ->> 'company_name', '')), '');
  v_phone text;
  v_status text;
  v_refusal text;
  v_row record;
  v_cid uuid;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '42501';
  END IF;
  IF v_caller IS NULL OR v_slot IS NULL OR v_slot NOT IN ('billing', 'it', 'msp') THEN
    RAISE EXCEPTION 'Not authorized' USING ERRCODE = '42501';
  END IF;
  IF (v_slot = 'billing' AND v_caller NOT IN ('staff', 'admin', 'broker'))
     OR (v_slot IN ('it', 'msp') AND v_caller NOT IN ('staff', 'admin', 'it_admin')) THEN
    RAISE EXCEPTION 'Not authorized' USING ERRCODE = '42501';
  END IF;
  IF v_phone_raw IS NOT NULL AND v_caller NOT IN ('staff', 'admin', 'broker') THEN
    RAISE EXCEPTION 'Not authorized' USING ERRCODE = '42501';
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
  IF v_slot = 'billing' AND v_phone IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'invalid_phone');
  END IF;
  IF v_slot = 'msp' AND v_company IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'company_name_required');
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('org_contacts:' || p_org::text, 0));
  SELECT d.status INTO v_status FROM public.org_deals d WHERE d.organization_id = p_org;
  IF v_status = 'suspended' THEN
    RETURN jsonb_build_object('success', false, 'error', 'account_suspended');
  END IF;
  IF v_slot = 'billing' THEN
    IF v_status IS NULL THEN
      RETURN jsonb_build_object('success', false, 'error', 'no_deal');
    END IF;
    IF v_status = 'draft' THEN
      RETURN jsonb_build_object('success', false, 'error', 'billing_set_in_setup');
    END IF;
    v_refusal := public._org_billing_login_refusal(p_org, v_email);
  ELSE
    -- The same rule as _billing_guard_invite_while_setup_pending, which a definer insert passes.
    IF v_status = 'draft' AND v_caller <> 'staff' THEN
      RETURN jsonb_build_object('success', false, 'error', 'billing_setup_incomplete');
    END IF;
    IF v_slot = 'it' AND EXISTS (SELECT 1 FROM public.org_contacts c
                                  WHERE c.organization_id = p_org AND c.role = 'it' AND c.removed_at IS NULL) THEN
      RETURN jsonb_build_object('success', false, 'error', 'it_contact_exists');
    END IF;
    v_refusal := public._org_billing_login_refusal(p_org, v_email);
    IF v_refusal = 'has_personal_account' THEN
      v_refusal := NULL;  -- F6 is about the billing-only login only; an IT admin takes a seat.
    END IF;
  END IF;
  IF v_refusal IS NOT NULL THEN
    RETURN jsonb_build_object('success', false, 'error', v_refusal);
  END IF;

  BEGIN
    SELECT * INTO v_row FROM public._org_people_invite_row(
      p_org, CASE WHEN v_slot = 'billing' THEN 'billing' ELSE 'it_admin' END, v_email, v_first, v_last, v_uid);
  EXCEPTION WHEN SQLSTATE 'P0001' THEN
    IF SQLERRM = 'seat_limit_reached' THEN
      RETURN jsonb_build_object('success', false, 'error', 'seat_limit_reached');
    END IF;
    RAISE;
  END;

  IF v_slot = 'billing' THEN
    v_cid := public._org_billing_contact_link(p_org, v_row.member_id, v_phone, v_uid);
    INSERT INTO public.billing_change_log (organization_id, actor_id, action, detail)
    VALUES (p_org, v_uid, 'billing_login_added', jsonb_build_object('contact_id', v_cid, 'member_id', v_row.member_id, 'by', v_caller));
  ELSE
    INSERT INTO public.org_contacts (organization_id, role, company_name, member_id, created_by, updated_by)
    VALUES (p_org, v_slot, CASE WHEN v_slot = 'msp' THEN v_company END, v_row.member_id, v_uid, v_uid)
    RETURNING id INTO v_cid;
    IF v_phone IS NOT NULL THEN
      PERFORM public._member_phone_put(v_row.member_id, v_phone, v_uid);
    END IF;
  END IF;
  INSERT INTO public.billing_change_log (organization_id, actor_id, action, detail)
  VALUES (p_org, v_uid, 'contact_saved', jsonb_build_object('role', v_slot, 'contact_id', v_cid,
          'member_id', v_row.member_id, 'invited', true, 'company_name', v_company, 'by', v_caller));

  RETURN jsonb_build_object('success', true, 'slot', v_slot, 'token', v_row.token, 'email', v_email,
                            'name', nullif(btrim(concat_ws(' ', v_first, v_last)), ''),
                            'member_id', v_row.member_id, 'contact_id', v_cid,
                            'org_name', (SELECT o.name FROM public.organizations o WHERE o.id = p_org));
END
$function$;
REVOKE EXECUTE ON FUNCTION public.org_people_invite(uuid, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.org_people_invite(uuid, jsonb) TO authenticated, service_role;

-- =====================================================================================
-- 6. Readers
-- =====================================================================================

CREATE OR REPLACE FUNCTION public.org_contacts_list(p_org uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
  v_caller text := public._org_people_caller(p_org, false);
  v_writer text := public._org_people_caller(p_org, true);
BEGIN
  -- BACKLOG-4007 People v2
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '42501';
  END IF;
  IF v_caller IS NULL THEN
    RAISE EXCEPTION 'Not authorized' USING ERRCODE = '42501';
  END IF;
  RETURN jsonb_build_object(
    'success', true,
    'caller', v_writer,
    'can_edit', v_writer IS NOT NULL,
    'can_edit_billing', coalesce(v_writer IN ('staff', 'admin', 'broker'), false),
    'can_edit_it', coalesce(v_writer IN ('staff', 'admin', 'it_admin'), false),
    'can_edit_phone', coalesce(v_writer IN ('staff', 'admin', 'broker'), false),
    'deal_status', (SELECT d.status FROM public.org_deals d WHERE d.organization_id = p_org),
    'contacts', coalesce((
      SELECT jsonb_agg(jsonb_build_object(
               'id', c.id, 'role', c.role, 'member_id', c.member_id,
               'name', public._member_person(m.id) ->> 'name',
               -- An IT admin sees who the billing contact is and their phone, not their email (3855, PM c7c276be).
               'email', CASE WHEN c.role = 'billing' AND v_caller = 'it_admin' THEN NULL
                             ELSE public._member_person(m.id) ->> 'email' END,
               'phone', public._member_phone(m.id),
               'company_name', c.company_name,
               'login', CASE WHEN c.role = 'billing' AND m.license_status = 'unassigned' THEN 'billing_only'
                             ELSE m.role END,
               'login_claimed', m.user_id IS NOT NULL)
             ORDER BY c.role, lower(coalesce(c.company_name, '')), lower(public._member_person(m.id) ->> 'name'))
        FROM public.org_contacts c
        JOIN public.organization_members m ON m.id = c.member_id AND m.organization_id = p_org
       WHERE c.organization_id = p_org AND c.removed_at IS NULL), '[]'::jsonb),
    'members', coalesce((
      SELECT jsonb_agg(jsonb_build_object(
               'member_id', m.id, 'user_id', m.user_id, 'role', m.role,
               'license_status', m.license_status,
               'billing_only', coalesce(m.provisioning_metadata ->> 'billing_only', '') = 'true',
               'name', public._member_person(m.id) ->> 'name',
               'email', public._member_person(m.id) ->> 'email',
               'phone', public._member_phone(m.id),
               'idp_managed', public._member_role_idp_managed(m.id),
               'pending', m.user_id IS NULL)
             ORDER BY lower(public._member_person(m.id) ->> 'name'))
        FROM public.organization_members m
       WHERE m.organization_id = p_org AND m.license_status IN ('active', 'unassigned', 'pending')), '[]'::jsonb));
END
$function$;
REVOKE EXECUTE ON FUNCTION public.org_contacts_list(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.org_contacts_list(uuid) TO authenticated, service_role;

-- The Stripe customer phone of the billing contact (brokerageSync, service client only).
CREATE OR REPLACE FUNCTION public._org_billing_contact_phone(p_org uuid)
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO ''
AS $function$
  SELECT p.phone
    FROM public.org_contacts c
    JOIN public.organization_members m ON m.id = c.member_id
    JOIN public.user_phones p ON (m.user_id IS NOT NULL AND p.user_id = m.user_id)
                              OR (m.user_id IS NULL AND p.pending_member_id = m.id)
   WHERE c.organization_id = p_org AND c.role = 'billing' AND c.removed_at IS NULL
   LIMIT 1
$function$;
REVOKE ALL ON FUNCTION public._org_billing_contact_phone(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public._org_billing_contact_phone(uuid) TO service_role;

CREATE OR REPLACE FUNCTION public.broker_get_billing_setup(p_org uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_deal public.org_deals%ROWTYPE;
  v_price integer;
  v_today date := public._billing_business_date();
BEGIN
  -- BACKLOG-4007 People v2: the contact comes from the member and user_phones.
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '42501';
  END IF;
  -- Billing details are Broker/Admin only (3855): never IT admin or agent.
  IF NOT EXISTS (SELECT 1 FROM public.organization_members m
                  WHERE m.organization_id = p_org AND m.user_id = v_uid
                    AND m.license_status = 'active' AND m.role IN ('broker', 'admin')) THEN
    RAISE EXCEPTION 'Not authorized' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO v_deal FROM public.org_deals WHERE organization_id = p_org;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'no_deal');
  END IF;
  SELECT l.unit_price_cents INTO v_price FROM public.org_deal_lines l
   WHERE l.organization_id = p_org AND l.item_key = 'brokerage_seat';

  RETURN jsonb_build_object(
    'success', true,
    'state', CASE v_deal.status WHEN 'draft' THEN 'waiting_for_setup' ELSE v_deal.status END,
    'version', v_deal.version,
    'plan_name', (SELECT p.name FROM public.plans p WHERE p.id = v_deal.plan_id),
    'seats', v_deal.seats,
    'unit_price_cents', v_price,
    'monthly_total_cents', v_deal.seats * v_price,
    'start_date', v_deal.start_date,
    'billing_starts_on', coalesce(v_deal.billing_starts_on, greatest(v_today, v_deal.start_date)),
    'account_manager', (SELECT coalesce(u.display_name, u.email) FROM public.users u WHERE u.id = v_deal.account_manager_id),
    'contact', (SELECT jsonb_build_object('name', public._member_person(c.member_id) ->> 'name',
                                          'email', public._member_person(c.member_id) ->> 'email',
                                          'phone', public._member_phone(c.member_id))
                  FROM public.org_contacts c WHERE c.id = v_deal.billing_contact_id),
    'company', (SELECT to_jsonb(bp) - 'updated_by' - 'organization_id' FROM public.org_billing_profile bp WHERE bp.organization_id = p_org),
    'me', (SELECT jsonb_build_object('name', coalesce(nullif(btrim(u.display_name), ''),
                                                      nullif(btrim(concat_ws(' ', u.first_name, u.last_name)), ''), u.email),
                                     'email', u.email,
                                     'phone', (SELECT p.phone FROM public.user_phones p WHERE p.user_id = v_uid))
             FROM public.users u WHERE u.id = v_uid));
END
$function$;
REVOKE EXECUTE ON FUNCTION public.broker_get_billing_setup(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.broker_get_billing_setup(uuid) TO authenticated, service_role;

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
  -- BACKLOG-4007 People v2 (R1): the contact from the member + user_phones; has_login = the
  -- billing-only login (the member is still 'unassigned', org_billing_contact_login's rule).
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
    'business_date', public._billing_business_date(),
    'assigned_seats', (SELECT count(*) FROM public.organization_members m
                        WHERE m.organization_id = p_org
                          AND public.member_row_holds_seat(m.license_status, m.invitation_expires_at, m.user_id)),
    'deal', (SELECT to_jsonb(d) - 'entitlement_prior' FROM public.org_deals d WHERE d.organization_id = p_org),
    -- From status only (never from setup_completed_at): deals saved before BACKLOG-4007 have
    -- no completion time and are active.
    'state', (SELECT CASE d.status WHEN 'draft' THEN 'waiting_for_setup' ELSE d.status END
                FROM public.org_deals d WHERE d.organization_id = p_org),
    'contact', (SELECT jsonb_build_object('id', c.id,
                                          'name', public._member_person(m.id) ->> 'name',
                                          'email', public._member_person(m.id) ->> 'email',
                                          'phone', public._member_phone(m.id),
                                          'has_login', m.license_status = 'unassigned')
                  FROM public.org_deals d
                  JOIN public.org_contacts c ON c.id = d.billing_contact_id
                  JOIN public.organization_members m ON m.id = c.member_id
                 WHERE d.organization_id = p_org),
    'company', (SELECT to_jsonb(bp) - 'updated_by' FROM public.org_billing_profile bp WHERE bp.organization_id = p_org),
    'terms_accepted', (SELECT jsonb_build_object('at', a.accepted_at, 'deal_version', a.deal_version,
                                                 'terms_version', a.terms_version, 'by', coalesce(u.display_name, u.email))
                         FROM public.org_terms_acceptances a LEFT JOIN public.users u ON u.id = a.user_id
                        WHERE a.organization_id = p_org ORDER BY a.accepted_at DESC LIMIT 1),
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

-- =====================================================================================
-- 7. broker_complete_billing_setup (same signature)
-- =====================================================================================

-- p_contact: {"who": "me" | "other", "name"?, "email"?, "phone"}. p_billing_login is ignored:
-- "Someone else" is an existing member of this brokerage (by email), else a new billing-only
-- login, always. A refusal for the new person (has_personal_account, duplicate_invitation,
-- user_in_other_brokerage) stops setup before any write (PM c7c276be item 4).
-- Returns billing_login {success, token, email, name, org_name} when a login was created.
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
  v_member uuid;
  v_contact uuid;
  v_starts date;
  v_version integer;
  v_login jsonb;
  v_refusal text;
  v_row record;
  v_legal text := nullif(btrim(coalesce(p_company ->> 'legal_name', '')), '');
  v_line1 text := nullif(btrim(coalesce(p_company ->> 'address_line1', '')), '');
  v_line2 text := nullif(btrim(coalesce(p_company ->> 'address_line2', '')), '');
  v_city text := nullif(btrim(coalesce(p_company ->> 'city', '')), '');
  v_region text := nullif(btrim(coalesce(p_company ->> 'region', '')), '');
  v_postal text := nullif(btrim(coalesce(p_company ->> 'postal_code', '')), '');
  v_country text := upper(nullif(btrim(coalesce(p_company ->> 'country', '')), ''));
  v_po text := nullif(btrim(coalesce(p_company ->> 'po_number', '')), '');
BEGIN
  -- BACKLOG-4007 People v2
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '42501';
  END IF;
  SELECT m.id INTO v_member FROM public.organization_members m
   WHERE m.organization_id = p_org AND m.user_id = v_uid
     AND m.license_status = 'active' AND m.role IN ('broker', 'admin');
  IF v_member IS NULL THEN
    RAISE EXCEPTION 'Not authorized' USING ERRCODE = '42501';
  END IF;

  IF v_who = 'me' THEN
    NULL;  -- the caller's own member row
  ELSIF v_who = 'other' THEN
    v_name := nullif(btrim(coalesce(p_contact ->> 'name', '')), '');
    v_email := lower(nullif(btrim(coalesce(p_contact ->> 'email', '')), ''));
    IF v_name IS NULL THEN
      RETURN jsonb_build_object('success', false, 'error', 'contact_name_required');
    END IF;
    IF v_email IS NULL OR v_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' THEN
      RETURN jsonb_build_object('success', false, 'error', 'contact_email_required');
    END IF;
    -- An existing member of this brokerage with that email (account or invitation).
    SELECT m.id INTO v_member FROM public.organization_members m
      LEFT JOIN public.users u ON u.id = m.user_id
     WHERE m.organization_id = p_org
       AND m.license_status IN ('active', 'pending', 'unassigned')
       AND (lower(u.email) = v_email OR lower(m.invited_email) = v_email)
     ORDER BY (m.user_id IS NOT NULL) DESC, m.created_at LIMIT 1;
  ELSE
    RETURN jsonb_build_object('success', false, 'error', 'invalid_contact');
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
  IF p_expected_version IS DISTINCT FROM v_deal.version THEN
    RETURN jsonb_build_object('success', false, 'error', 'version_conflict', 'version', v_deal.version);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.org_terms_acceptances a
                  WHERE a.organization_id = p_org AND a.user_id = v_uid
                    AND a.deal_version = v_deal.version) THEN
    RETURN jsonb_build_object('success', false, 'error', 'terms_not_accepted');
  END IF;
  IF v_deal.stripe_mode = 'live' AND NOT public._billing_brokerage_live() THEN
    RETURN jsonb_build_object('success', false, 'error', 'billing_not_live');
  END IF;

  -- "Someone else" who is not a member: the billing-only login. Refused before any write.
  IF v_who = 'other' AND v_member IS NULL THEN
    v_refusal := public._org_billing_login_refusal(p_org, v_email);
    IF v_refusal IS NOT NULL THEN
      RETURN jsonb_build_object('success', false, 'error', v_refusal);
    END IF;
    SELECT * INTO v_row FROM public._org_people_invite_row(
      p_org, 'billing', v_email, split_part(v_name, ' ', 1),
      nullif(btrim(substr(v_name, length(split_part(v_name, ' ', 1)) + 1)), ''), v_uid);
    v_member := v_row.member_id;
    v_login := jsonb_build_object('success', true, 'token', v_row.token, 'email', v_email, 'name', v_name,
                                  'org_name', (SELECT o.name FROM public.organizations o WHERE o.id = p_org));
    INSERT INTO public.billing_change_log (organization_id, actor_id, action, detail)
    VALUES (p_org, v_uid, 'billing_login_added', jsonb_build_object('member_id', v_member, 'via', 'setup'));
  END IF;

  v_contact := public._org_billing_contact_link(p_org, v_member, v_phone, v_uid);

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

  RETURN jsonb_build_object('success', true, 'version', v_version, 'billing_starts_on', v_starts,
                            'billing_login', v_login);
END
$function$;
REVOKE EXECUTE ON FUNCTION public.broker_complete_billing_setup(uuid, integer, jsonb, jsonb, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.broker_complete_billing_setup(uuid, integer, jsonb, jsonb, boolean) TO authenticated, service_role;

-- =====================================================================================
-- 8. Triggers on organization_members
-- =====================================================================================

-- a493cf6f: an UPDATE that clears billing_only while claiming is refused too (reads OLD).
CREATE OR REPLACE FUNCTION public._guard_billing_login_personal_account()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
BEGIN
  -- BACKLOG-4007 People v2
  IF (coalesce(NEW.provisioning_metadata ->> 'billing_only', '') = 'true'
      OR coalesce(OLD.provisioning_metadata ->> 'billing_only', '') = 'true')
     AND public._user_has_personal_account(NEW.user_id) THEN
    RAISE EXCEPTION 'has_personal_account' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END
$function$;
REVOKE ALL ON FUNCTION public._guard_billing_login_personal_account() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public._guard_billing_login_personal_account() TO service_role;

-- R5 / C7: an invitation's pending phone follows its acceptance; the person's own phone wins.
-- SECURITY DEFINER: a claim made as authenticated has no user_phones grant.
CREATE OR REPLACE FUNCTION public._user_phones_claim_pending()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
BEGIN
  IF EXISTS (SELECT 1 FROM public.user_phones p WHERE p.user_id = NEW.user_id) THEN
    DELETE FROM public.user_phones WHERE pending_member_id = NEW.id;
  ELSE
    UPDATE public.user_phones SET user_id = NEW.user_id, pending_member_id = NULL, updated_at = now()
     WHERE pending_member_id = NEW.id;
  END IF;
  RETURN NULL;
END
$function$;
REVOKE ALL ON FUNCTION public._user_phones_claim_pending() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public._user_phones_claim_pending() TO service_role;

DROP TRIGGER IF EXISTS user_phones_claim_pending ON public.organization_members;
CREATE TRIGGER user_phones_claim_pending
  AFTER UPDATE OF user_id ON public.organization_members
  FOR EACH ROW
  WHEN (OLD.user_id IS NULL AND NEW.user_id IS NOT NULL)
  EXECUTE FUNCTION public._user_phones_claim_pending();

-- R10b: SCIM skips the billing-only invitation and inserts a second member row for the same
-- email. That new row takes over the billing contact and the pending phone; the invitation goes.
CREATE OR REPLACE FUNCTION public._org_billing_login_orphan_rekey()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
  v_email text;
  v_inv record;
BEGIN
  SELECT lower(u.email) INTO v_email FROM public.users u WHERE u.id = NEW.user_id;
  IF v_email IS NULL THEN
    RETURN NULL;
  END IF;
  FOR v_inv IN SELECT m.id FROM public.organization_members m
                WHERE m.organization_id = NEW.organization_id AND m.id <> NEW.id
                  AND m.user_id IS NULL AND lower(m.invited_email) = v_email
                  AND coalesce(m.provisioning_metadata ->> 'billing_only', '') = 'true' LOOP
    UPDATE public.org_contacts SET member_id = NEW.id, updated_at = now()
     WHERE member_id = v_inv.id AND removed_at IS NULL;
    IF EXISTS (SELECT 1 FROM public.user_phones p WHERE p.user_id = NEW.user_id) THEN
      DELETE FROM public.user_phones WHERE pending_member_id = v_inv.id;
    ELSE
      UPDATE public.user_phones SET user_id = NEW.user_id, pending_member_id = NULL, updated_at = now()
       WHERE pending_member_id = v_inv.id;
    END IF;
    DELETE FROM public.organization_members WHERE id = v_inv.id;
    INSERT INTO public.billing_change_log (organization_id, actor_id, action, detail)
    VALUES (NEW.organization_id, NULL, 'billing_login_replaced',
            jsonb_build_object('old_member_id', v_inv.id, 'member_id', NEW.id, 'provisioned_by', NEW.provisioned_by));
  END LOOP;
  RETURN NULL;
END
$function$;
REVOKE ALL ON FUNCTION public._org_billing_login_orphan_rekey() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public._org_billing_login_orphan_rekey() TO service_role;

DROP TRIGGER IF EXISTS org_billing_login_orphan_rekey ON public.organization_members;
CREATE TRIGGER org_billing_login_orphan_rekey
  AFTER INSERT ON public.organization_members
  FOR EACH ROW
  WHEN (NEW.user_id IS NOT NULL)
  EXECUTE FUNCTION public._org_billing_login_orphan_rekey();

-- R9 (founder refinement): the live billing contact's member row goes away by IdP deprovision.
-- The contact moves to the account admin, who is emailed; with no active admin the deal cache
-- is cleared and the account manager is alerted.
CREATE OR REPLACE FUNCTION public._org_billing_contact_reassign(p_org uuid, p_gone_member uuid, p_reason text)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
  v_admin uuid := public._org_account_admin_member(p_org, p_gone_member);
  v_mode text;
  v_cid uuid;
BEGIN
  SELECT d.stripe_mode INTO v_mode FROM public.org_deals d WHERE d.organization_id = p_org;
  IF v_admin IS NOT NULL THEN
    v_cid := public._org_billing_contact_link(p_org, v_admin, NULL, NULL, true);
    INSERT INTO public.billing_change_log (organization_id, actor_id, action, detail)
    VALUES (p_org, NULL, 'billing_contact_reassigned',
            jsonb_build_object('from_member_id', p_gone_member, 'member_id', v_admin, 'contact_id', v_cid, 'reason', p_reason));
    IF v_mode IS NOT NULL THEN
      INSERT INTO public.billing_outbox (stripe_mode, kind, organization_id, dedupe_key, payload)
      VALUES (v_mode, 'notify_billing_contact_reassigned', p_org,
              'notify_billing_contact_reassigned:' || v_mode || ':' || p_org::text || ':' || v_cid::text,
              jsonb_build_object('organization_id', p_org, 'member_id', v_admin, 'contact_id', v_cid, 'reason', p_reason))
      ON CONFLICT (dedupe_key) DO NOTHING;
    END IF;
    RETURN v_cid;
  END IF;

  UPDATE public.org_contacts SET removed_at = now(), updated_at = now()
   WHERE organization_id = p_org AND role = 'billing' AND removed_at IS NULL AND member_id = p_gone_member;
  UPDATE public.org_deals SET billing_contact_id = NULL, billing_contact_name = NULL, billing_contact_email = NULL
   WHERE organization_id = p_org;
  INSERT INTO public.billing_change_log (organization_id, actor_id, action, detail)
  VALUES (p_org, NULL, 'billing_contact_lost', jsonb_build_object('from_member_id', p_gone_member, 'reason', p_reason));
  IF v_mode IS NOT NULL THEN
    INSERT INTO public.billing_outbox (stripe_mode, kind, organization_id, dedupe_key, payload)
    VALUES (v_mode, 'notify_account_manager', p_org,
            'notify_account_manager:' || v_mode || ':' || p_org::text || ':billing_contact_removed:' || p_gone_member::text,
            jsonb_build_object('reason', 'billing_contact_removed', 'organization_id', p_org))
    ON CONFLICT (dedupe_key) DO NOTHING;
  END IF;
  RETURN NULL;
END
$function$;
REVOKE ALL ON FUNCTION public._org_billing_contact_reassign(uuid, uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public._org_billing_contact_reassign(uuid, uuid, text) TO service_role;

-- A client (the Users page) cannot delete the live billing contact's member row. Any other
-- deleter (service role, a cascade) reassigns first, so the cascade removes only history.
CREATE OR REPLACE FUNCTION public._org_billing_contact_member_delete_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
BEGIN
  IF EXISTS (SELECT 1 FROM public.org_contacts c
              WHERE c.member_id = OLD.id AND c.role = 'billing' AND c.removed_at IS NULL) THEN
    IF current_setting('role', true) IN ('authenticated', 'anon') THEN
      RAISE EXCEPTION 'billing_contact_member' USING ERRCODE = 'P0001',
        HINT = 'Pick another billing contact first.';
    END IF;
    PERFORM public._org_billing_contact_reassign(OLD.organization_id, OLD.id, 'member_deleted');
  END IF;
  RETURN OLD;
END
$function$;
REVOKE ALL ON FUNCTION public._org_billing_contact_member_delete_guard() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public._org_billing_contact_member_delete_guard() TO service_role;

DROP TRIGGER IF EXISTS org_billing_contact_member_delete_guard ON public.organization_members;
CREATE TRIGGER org_billing_contact_member_delete_guard
  BEFORE DELETE ON public.organization_members
  FOR EACH ROW
  EXECUTE FUNCTION public._org_billing_contact_member_delete_guard();

-- IdP deprovision: SCIM DELETE / active:false and directory-sync removal suspend the member row
-- with the service role AND stamp scim_synced_at in the same UPDATE. The Users-page Deactivate
-- (broker-portal deactivateUser.ts) also writes with the service client but does not stamp
-- scim_synced_at, so it does not reassign.
CREATE OR REPLACE FUNCTION public._org_billing_contact_on_deprovision()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
BEGIN
  IF current_setting('role', true) = 'service_role'
     AND EXISTS (SELECT 1 FROM public.org_contacts c
                  WHERE c.member_id = NEW.id AND c.role = 'billing' AND c.removed_at IS NULL) THEN
    PERFORM public._org_billing_contact_reassign(NEW.organization_id, NEW.id, 'idp_deprovisioned');
  END IF;
  RETURN NULL;
END
$function$;
REVOKE ALL ON FUNCTION public._org_billing_contact_on_deprovision() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public._org_billing_contact_on_deprovision() TO service_role;

DROP TRIGGER IF EXISTS org_billing_contact_on_deprovision ON public.organization_members;
CREATE TRIGGER org_billing_contact_on_deprovision
  AFTER UPDATE OF license_status, scim_synced_at ON public.organization_members
  FOR EACH ROW
  WHEN (OLD.license_status IS DISTINCT FROM 'suspended' AND NEW.license_status = 'suspended'
        AND NEW.scim_synced_at IS DISTINCT FROM OLD.scim_synced_at)
  EXECUTE FUNCTION public._org_billing_contact_on_deprovision();

-- R7 DB guard: a client sets role it_admin only as an active admin / IT admin of that brokerage
-- or as Keepr staff. The People RPCs check the same set themselves (they run as the owner).
CREATE OR REPLACE FUNCTION public._guard_it_admin_grant()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
BEGIN
  IF current_setting('role', true) IN ('authenticated', 'anon')
     AND NOT public.has_internal_role(auth.uid())
     AND NOT EXISTS (SELECT 1 FROM public.organization_members c
                      WHERE c.organization_id = NEW.organization_id AND c.user_id = auth.uid()
                        AND c.license_status = 'active' AND c.role IN ('admin', 'it_admin')) THEN
    RAISE EXCEPTION 'it_admin_not_allowed' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END
$function$;
REVOKE ALL ON FUNCTION public._guard_it_admin_grant() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public._guard_it_admin_grant() TO service_role;

-- Named with a leading underscore so it fires before guard_invite_acceptance (alphabetical).
DROP TRIGGER IF EXISTS _guard_it_admin_grant_ins ON public.organization_members;
CREATE TRIGGER _guard_it_admin_grant_ins
  BEFORE INSERT ON public.organization_members
  FOR EACH ROW
  WHEN (NEW.role = 'it_admin')
  EXECUTE FUNCTION public._guard_it_admin_grant();
DROP TRIGGER IF EXISTS _guard_it_admin_grant_upd ON public.organization_members;
CREATE TRIGGER _guard_it_admin_grant_upd
  BEFORE UPDATE OF role ON public.organization_members
  FOR EACH ROW
  WHEN (NEW.role = 'it_admin' AND OLD.role IS DISTINCT FROM 'it_admin')
  EXECUTE FUNCTION public._guard_it_admin_grant();

-- =====================================================================================
-- 9. Removed for good
-- =====================================================================================

DROP FUNCTION IF EXISTS public.org_billing_login_set(uuid, boolean);
DROP FUNCTION IF EXISTS public.admin_search_users_for_contact(uuid, text);
DROP FUNCTION IF EXISTS public._org_billing_login_create(uuid, uuid);
