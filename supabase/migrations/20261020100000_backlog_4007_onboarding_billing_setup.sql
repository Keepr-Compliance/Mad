-- BACKLOG-4007 PR-1: one-invite brokerage onboarding (database layer).
--
-- Staff save a deal; it now WAITS in status 'draft' ("Waiting for customer setup") until the
-- invited broker/admin finishes the Billing step of the setup guide. Completion sets status
-- 'active' AND bumps the deal version in one UPDATE, so the 3853 trigger
-- (_billing_enqueue_org_work, body NOT changed here) enqueues exactly one
-- sync_org_subscription row. Saving or editing a waiting deal enqueues nothing (the trigger
-- only enqueues for active | canceling | suspended).
--
--  1. _billing_business_date(p_at)   one business date for every "today" rule:
--                                    America/Los_Angeles. The westernmost mainland US zone, so a
--                                    US user's own local date is never earlier than it.
--  2. _billing_normalize_phone(text) E.164 or NULL.
--  3. org_contacts                   brokerage contacts (billing | it | office | msp). RLS on,
--                                    no client grants; read and written through the functions
--                                    below. One live billing contact per brokerage (unique
--                                    index), which also bounds the billing-only login (the
--                                    member linked from that contact) to ONE per brokerage.
--                                    Phone is required for a billing contact by the RPCs, not
--                                    by a CHECK (backfilled rows carry no phone).
--  4. org_deals columns              billing_contact_id, billing_starts_on, setup_completed_at,
--                                    setup_completed_by.
--  5. _org_billing_contact_set       the ONE writer of a brokerage billing contact: the contact
--                                    row and org_deals.billing_contact_id / _name / _email in
--                                    one block. Never touches version or status.
--  6. _billing_save_deal (replaced)  a new deal is 'draft'; start_date from p_deal (default the
--                                    business date), refused when past ('start_date_past') and
--                                    editable only while 'draft' ('start_date_locked'); a staff
--                                    edit keeps 'draft' (only 'canceled' -> 'active' remains);
--                                    contact keys go through _org_billing_contact_set.
--  7. admin_save_deal                new 10-arg overload with p_start_date (NO default, so a
--                                    9-named-argument call still resolves to exactly one
--                                    function in PostgREST); the 9-arg function becomes a
--                                    wrapper passing NULL. A billing contact is no longer
--                                    required (the broker sets it in setup).
--  8. admin_get_org_billing (replaced) adds state (from status only: 'draft' ->
--                                    'waiting_for_setup'), business_date and contact.
--  9. broker_get_billing_setup       what the Billing step shows (incl. company details) (broker/admin of the org with
--                                    an active license; never IT admin or agent).
-- 10. broker_complete_billing_setup  the Billing step. Takes the deal version the broker saw
--                                    and refuses 'version_conflict' if staff changed the deal.
--                                    Takes no price or seat input. The billing-only login
--                                    (p_billing_login) is refused until PR-4.
-- 11. _billing_guard_invite_while_setup_pending (+ _billing_org_setup_pending): a client-session invite (broker portal) into
--                                    a brokerage whose deal is 'draft' is refused with
--                                    'billing_setup_incomplete' (founder 2026-10-19). Staff
--                                    invites (admin_invite_user, SECURITY DEFINER) pass.
-- 12. _billing_enqueue_setup_reminders: an unclaimed broker/admin invite (insert or resend)
--                                    into a 'draft' brokerage enqueues notify_setup_reminder at
--                                    +3 and +7 days from that send; a resend supersedes the
--                                    earlier pair. The handler (PR-3) resolves the recipient
--                                    when the row runs.
-- 3b. org_billing_profile          the brokerage's legal company name, billing address and
--                                    optional PO number (one row per organization). Company-level
--                                    billing data: not a person (org_contacts) and not a deal term
--                                    (an address edit must not bump the deal version, which would
--                                    re-sync the subscription). Same RLS/grant pattern as org_deals.
-- 9b. org_terms_acceptances +        recorded acceptance of the Terms of Service and this order:
--     broker_accept_terms            who, when, deal version, seats and price shown (read from the
--                                    deal at that version, never from the client), terms version
--                                    and URL. Completion requires the caller's acceptance for the
--                                    CURRENT deal version ('terms_not_accepted').
-- 13. Backfill                      each existing deal's billing contact -> one org_contacts
--                                    row; billing_contact_id set. No version, status or
--                                    updated_at change, so nothing is enqueued.
--
-- CREATE OR REPLACE / ADD COLUMN IF NOT EXISTS / CREATE TABLE IF NOT EXISTS only.
-- Pre-check: each replaced body is the known prior body (or this file's, on a re-run), and the
-- 3853 enqueue trigger body is the one this design relies on.
-- Apply order: after every billing migration from 20261016075118 to 20261019090000 (production
-- has none of them yet; the pre-check raises there until they are applied).
-- Rollback: supabase/tests/backlog-4007/rollback-4007-pr1.sql

DO $pre$
DECLARE
  v_md5 text;
  v_src text;
BEGIN
  SELECT md5(pg_get_functiondef(oid)), prosrc INTO v_md5, v_src FROM pg_proc
   WHERE oid = to_regprocedure('public._billing_save_deal(uuid,jsonb,uuid,text,integer)');
  IF v_md5 IS NULL OR (v_md5 <> '4471a965ddbfdde884108a891da73c01' AND v_src NOT LIKE '%start_date_locked%') THEN
    RAISE EXCEPTION '4007 PR-1 pre-check: _billing_save_deal is not the 3853 PR-1 body (md5 %)', v_md5;
  END IF;
  SELECT md5(pg_get_functiondef(oid)), prosrc INTO v_md5, v_src FROM pg_proc
   WHERE oid = to_regprocedure('public.admin_save_deal(uuid,text,integer,integer,text,text,uuid,text,integer)');
  IF v_md5 IS NULL OR (v_md5 <> 'f3ae35f5e1086f4da45a4394d08c55b1' AND v_src NOT LIKE '%BACKLOG-4007 wrapper%') THEN
    RAISE EXCEPTION '4007 PR-1 pre-check: admin_save_deal(9 args) is not the 3853 PR-2A body (md5 %)', v_md5;
  END IF;
  SELECT md5(pg_get_functiondef(oid)), prosrc INTO v_md5, v_src FROM pg_proc
   WHERE oid = to_regprocedure('public.admin_get_org_billing(uuid)');
  IF v_md5 IS NULL OR (v_md5 <> '998884311f45b031f4488fd9e5b25b20' AND v_src NOT LIKE '%waiting_for_setup%') THEN
    RAISE EXCEPTION '4007 PR-1 pre-check: admin_get_org_billing is not the 3853 PR-2A body (md5 %)', v_md5;
  END IF;
  SELECT md5(pg_get_functiondef(oid)) INTO v_md5 FROM pg_proc
   WHERE oid = to_regprocedure('public._billing_enqueue_org_work()');
  IF v_md5 IS DISTINCT FROM '11182fa518249149d9907e59d2c53390' THEN
    RAISE EXCEPTION '4007 PR-1 pre-check: _billing_enqueue_org_work is not the 3853 PR-2 body (md5 %)', v_md5;
  END IF;
  IF to_regclass('public.billing_outbox') IS NULL OR to_regclass('public.org_deals') IS NULL THEN
    RAISE EXCEPTION '4007 PR-1 pre-check: billing_outbox or org_deals is missing';
  END IF;
END $pre$;

-- =====================================================================================
-- 1. Business date
-- =====================================================================================

CREATE OR REPLACE FUNCTION public._billing_business_date(p_at timestamptz DEFAULT now())
RETURNS date
LANGUAGE sql
STABLE
SET search_path TO ''
AS $function$
  SELECT (p_at AT TIME ZONE 'America/Los_Angeles')::date
$function$;
REVOKE EXECUTE ON FUNCTION public._billing_business_date(timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public._billing_business_date(timestamptz) TO service_role;
COMMENT ON FUNCTION public._billing_business_date(timestamptz) IS
  'BACKLOG-4007: the one business date for deal start dates and billing start (America/Los_Angeles).';

-- =====================================================================================
-- 2. Phone normalisation
-- =====================================================================================

-- E.164, or NULL when the input is not a phone number. 10 digits = US (+1).
CREATE OR REPLACE FUNCTION public._billing_normalize_phone(p text)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
SET search_path TO ''
AS $function$
DECLARE
  v text := regexp_replace(btrim(coalesce(p, '')), '[[:space:]().-]', '', 'g');
BEGIN
  IF v ~ '^\+[1-9][0-9]{7,14}$' THEN
    RETURN v;
  ELSIF v ~ '^[2-9][0-9]{9}$' THEN
    RETURN '+1' || v;
  ELSIF v ~ '^1[2-9][0-9]{9}$' THEN
    RETURN '+' || v;
  END IF;
  RETURN NULL;
END
$function$;
REVOKE EXECUTE ON FUNCTION public._billing_normalize_phone(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public._billing_normalize_phone(text) TO service_role;

-- =====================================================================================
-- 3. Brokerage contacts
-- =====================================================================================

CREATE TABLE IF NOT EXISTS public.org_contacts (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id),
  role            text NOT NULL CONSTRAINT org_contacts_role_ck CHECK (role IN ('billing', 'it', 'office', 'msp')),
  full_name       text NOT NULL CONSTRAINT org_contacts_name_ck CHECK (btrim(full_name) <> ''),
  email           text NOT NULL CONSTRAINT org_contacts_email_ck CHECK (position('@' in email) > 1),
  phone           text CONSTRAINT org_contacts_phone_ck CHECK (phone IS NULL OR phone ~ '^\+[1-9][0-9]{7,14}$'),
  company_name    text,
  member_id       uuid REFERENCES public.organization_members(id) ON DELETE SET NULL,
  created_by      uuid,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_by      uuid,
  updated_at      timestamptz NOT NULL DEFAULT now(),
  removed_at      timestamptz
);
ALTER TABLE public.org_contacts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.org_contacts FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.org_contacts TO service_role;
-- One live billing contact per brokerage. The billing-only login is the member linked from
-- this contact (member_id), so this index also allows at most ONE billing-only login per
-- brokerage (founder 2026-10-19).
CREATE UNIQUE INDEX IF NOT EXISTS org_contacts_one_billing_idx
  ON public.org_contacts (organization_id) WHERE role = 'billing' AND removed_at IS NULL;
CREATE INDEX IF NOT EXISTS org_contacts_org_idx ON public.org_contacts (organization_id);
COMMENT ON TABLE public.org_contacts IS
  'BACKLOG-4007: brokerage contacts. One live billing contact per organization; its member_id (if any) is the single billing-only login. A billing contact needs a phone (enforced by the RPCs; backfilled rows have none).';

-- =====================================================================================
-- 3b. Company billing details and terms acceptance
-- =====================================================================================

CREATE TABLE IF NOT EXISTS public.org_billing_profile (
  organization_id uuid PRIMARY KEY REFERENCES public.organizations(id),
  legal_name      text NOT NULL CONSTRAINT org_billing_profile_name_ck CHECK (btrim(legal_name) <> ''),
  address_line1   text NOT NULL CONSTRAINT org_billing_profile_line1_ck CHECK (btrim(address_line1) <> ''),
  address_line2   text,
  city            text NOT NULL CONSTRAINT org_billing_profile_city_ck CHECK (btrim(city) <> ''),
  region          text,
  postal_code     text NOT NULL CONSTRAINT org_billing_profile_postal_ck CHECK (btrim(postal_code) <> ''),
  country         text NOT NULL CONSTRAINT org_billing_profile_country_ck CHECK (country ~ '^[A-Z]{2}$'),
  po_number       text,
  updated_by      uuid,
  updated_at      timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.org_billing_profile ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.org_billing_profile FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.org_billing_profile TO service_role;
COMMENT ON TABLE public.org_billing_profile IS
  'BACKLOG-4007: legal company name, billing address (country ISO 3166-1 alpha-2; region required for US) and optional PO number. PR-3 puts name + address on the Stripe customer and the PO number on invoices.';

CREATE TABLE IF NOT EXISTS public.org_terms_acceptances (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id     uuid NOT NULL REFERENCES public.organizations(id),
  user_id             uuid NOT NULL,
  deal_version        integer NOT NULL,
  seats               integer NOT NULL,
  unit_price_cents    integer NOT NULL,
  monthly_total_cents integer NOT NULL,
  terms_version       text NOT NULL CONSTRAINT org_terms_acceptances_version_ck CHECK (btrim(terms_version) <> ''),
  terms_url           text NOT NULL CONSTRAINT org_terms_acceptances_url_ck CHECK (terms_url ~ '^https://'),
  accepted_at         timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.org_terms_acceptances ENABLE ROW LEVEL SECURITY;
-- service_role included: Supabase default privileges grant it every right at create time.
REVOKE ALL ON public.org_terms_acceptances FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT, INSERT ON public.org_terms_acceptances TO service_role;
CREATE INDEX IF NOT EXISTS org_terms_acceptances_org_idx ON public.org_terms_acceptances (organization_id, deal_version);
COMMENT ON TABLE public.org_terms_acceptances IS
  'BACKLOG-4007: who accepted the Terms of Service and this order, when, for which deal version and price. Append-only for every role that is not the table owner (UPDATE, DELETE, TRUNCATE revoked from service_role too).';

-- =====================================================================================
-- 4. Deal columns
-- =====================================================================================

ALTER TABLE public.org_deals
  ADD COLUMN IF NOT EXISTS billing_contact_id uuid REFERENCES public.org_contacts(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS billing_starts_on date,
  ADD COLUMN IF NOT EXISTS setup_completed_at timestamptz,
  ADD COLUMN IF NOT EXISTS setup_completed_by uuid;
COMMENT ON COLUMN public.org_deals.billing_starts_on IS
  'BACKLOG-4007: the day Stripe billing starts = greatest(business date at setup completion, start_date). start_date stays the contract date. PR-3 (sync job) decides trial_end when the row RUNS, not here: trial_end = billing_starts_on 12:00 UTC only when that is at least 1 h in the future at run time, else none; the idempotency key carries the choice (subscription:v<N>:<trial_end|none>).';

-- =====================================================================================
-- 5. The one writer of a brokerage billing contact
-- =====================================================================================

-- p_phone NULL = not supplied: kept for the same person, cleared for a new person.
-- A different email is a different person: the old row is marked removed and a new one added
-- (its member_id, if any, stays on the removed row).
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

-- =====================================================================================
-- 6. _billing_save_deal (replaced, same signature)
-- =====================================================================================

-- Save a deal (service role; admin_save_deal wraps it).
-- p_deal: {stripe_mode, seats, unit_price_cents?, start_date?, billing_contact_name?,
--          billing_contact_email?, account_manager_id?, designated_broker_member_id?}
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

-- =====================================================================================
-- 7. admin_save_deal: 10-arg with p_start_date (no default); 9-arg wraps it
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
  p_expected_version integer,
  p_start_date date)
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
  -- BACKLOG-4007: the broker sets the billing contact in setup; staff may still set one.
  IF v_email IS NOT NULL AND position('@' in v_email) < 2 THEN
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
      'start_date', p_start_date,
      'billing_contact_name', nullif(btrim(coalesce(p_billing_contact_name, '')), ''),
      'billing_contact_email', v_email,
      'account_manager_id', p_account_manager_id)),
    v_uid, v_reason, p_expected_version);

  IF coalesce((v_res ->> 'success')::boolean, false) THEN
    INSERT INTO public.admin_audit_logs (actor_id, action, target_type, target_id, metadata)
    VALUES (v_uid, 'billing.deal_saved', 'organization', p_org::text, jsonb_build_object(
      'version', v_res -> 'version', 'seats', p_seats, 'unit_price_cents', p_unit_price_cents,
      'list_price_cents', v_list, 'pct_off', v_pct, 'cap_pct', v_cap, 'over_cap', v_over,
      'stripe_mode', p_stripe_mode, 'reason', v_reason, 'start_date', v_res -> 'start_date'));
  END IF;
  RETURN v_res;
END
$function$;
REVOKE EXECUTE ON FUNCTION public.admin_save_deal(uuid, text, integer, integer, text, text, uuid, text, integer, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_save_deal(uuid, text, integer, integer, text, text, uuid, text, integer, date) TO authenticated, service_role;

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
BEGIN
  -- BACKLOG-4007 wrapper: the 9-argument call keeps the start date (or today on a new deal).
  RETURN public.admin_save_deal(p_org, p_stripe_mode, p_seats, p_unit_price_cents,
    p_billing_contact_name, p_billing_contact_email, p_account_manager_id, p_reason,
    p_expected_version, NULL::date);
END
$function$;
REVOKE EXECUTE ON FUNCTION public.admin_save_deal(uuid, text, integer, integer, text, text, uuid, text, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_save_deal(uuid, text, integer, integer, text, text, uuid, text, integer) TO authenticated, service_role;

-- =====================================================================================
-- 8. admin_get_org_billing (replaced, same signature)
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
    'business_date', public._billing_business_date(),
    'assigned_seats', (SELECT count(*) FROM public.organization_members m
                        WHERE m.organization_id = p_org
                          AND public.member_row_holds_seat(m.license_status, m.invitation_expires_at, m.user_id)),
    'deal', (SELECT to_jsonb(d) - 'entitlement_prior' FROM public.org_deals d WHERE d.organization_id = p_org),
    -- From status only (never from setup_completed_at): deals saved before BACKLOG-4007 have
    -- no completion time and are active.
    'state', (SELECT CASE d.status WHEN 'draft' THEN 'waiting_for_setup' ELSE d.status END
                FROM public.org_deals d WHERE d.organization_id = p_org),
    'contact', (SELECT jsonb_build_object('id', c.id, 'name', c.full_name, 'email', c.email, 'phone', c.phone,
                                          'has_login', c.member_id IS NOT NULL)
                  FROM public.org_deals d JOIN public.org_contacts c ON c.id = d.billing_contact_id
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
-- 9. broker_get_billing_setup
-- =====================================================================================

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
    'contact', (SELECT jsonb_build_object('name', c.full_name, 'email', c.email, 'phone', c.phone)
                  FROM public.org_contacts c WHERE c.id = v_deal.billing_contact_id),
    'company', (SELECT to_jsonb(bp) - 'updated_by' - 'organization_id' FROM public.org_billing_profile bp WHERE bp.organization_id = p_org),
    'me', (SELECT jsonb_build_object('name', coalesce(nullif(btrim(u.display_name), ''),
                                                      nullif(btrim(concat_ws(' ', u.first_name, u.last_name)), ''), u.email),
                                     'email', u.email)
             FROM public.users u WHERE u.id = v_uid));
END
$function$;
REVOKE EXECUTE ON FUNCTION public.broker_get_billing_setup(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.broker_get_billing_setup(uuid) TO authenticated, service_role;

-- =====================================================================================
-- 9b. broker_accept_terms
-- =====================================================================================

-- Records the caller's acceptance of the Terms of Service and this order for the deal version
-- the Billing step showed. Seats and price are read from the deal, never from the client.
CREATE OR REPLACE FUNCTION public.broker_accept_terms(
  p_org uuid, p_expected_version integer, p_terms_version text, p_terms_url text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_deal public.org_deals%ROWTYPE;
  v_price integer;
  v_id uuid;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.organization_members m
                  WHERE m.organization_id = p_org AND m.user_id = v_uid
                    AND m.license_status = 'active' AND m.role IN ('broker', 'admin')) THEN
    RAISE EXCEPTION 'Not authorized' USING ERRCODE = '42501';
  END IF;
  IF nullif(btrim(coalesce(p_terms_version, '')), '') IS NULL OR coalesce(p_terms_url, '') !~ '^https://' THEN
    RETURN jsonb_build_object('success', false, 'error', 'invalid_terms');
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('billing_org:' || p_org::text, 0));
  SELECT * INTO v_deal FROM public.org_deals WHERE organization_id = p_org;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'no_deal');
  END IF;
  IF v_deal.status <> 'draft' THEN
    RETURN jsonb_build_object('success', false, 'error', 'not_waiting', 'status', v_deal.status);
  END IF;
  IF p_expected_version IS DISTINCT FROM v_deal.version THEN
    RETURN jsonb_build_object('success', false, 'error', 'version_conflict', 'version', v_deal.version);
  END IF;
  SELECT l.unit_price_cents INTO v_price FROM public.org_deal_lines l
   WHERE l.organization_id = p_org AND l.item_key = 'brokerage_seat';
  IF v_price IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'no_price');
  END IF;
  INSERT INTO public.org_terms_acceptances (organization_id, user_id, deal_version, seats, unit_price_cents,
    monthly_total_cents, terms_version, terms_url)
  VALUES (p_org, v_uid, v_deal.version, v_deal.seats, v_price, v_deal.seats * v_price,
    btrim(p_terms_version), p_terms_url)
  RETURNING id INTO v_id;
  RETURN jsonb_build_object('success', true, 'acceptance_id', v_id, 'deal_version', v_deal.version);
END
$function$;
REVOKE EXECUTE ON FUNCTION public.broker_accept_terms(uuid, integer, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.broker_accept_terms(uuid, integer, text, text) TO authenticated, service_role;

-- =====================================================================================
-- 10. broker_complete_billing_setup
-- =====================================================================================

-- p_contact: {"who": "me" | "other", "name"?, "email"?, "phone"}.
-- p_company: {"legal_name", "address_line1", "address_line2"?, "city", "region" (required for
--             US), "postal_code", "country" (ISO alpha-2), "po_number"?}.
-- Any other key (price, seats) is ignored. p_expected_version = the deal version the Billing
-- step showed; the caller must have accepted the terms for that version (broker_accept_terms).
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

-- =====================================================================================
-- 11. No broker invites while the deal waits for setup
-- =====================================================================================

-- Client sessions only (broker-portal inviteUser inserts as 'authenticated'). Staff invites
-- (admin_invite_user, SECURITY DEFINER: current_user is its owner) and service-role writers
-- pass. The trigger function is SECURITY INVOKER so current_user is the real caller; the
-- deal lookup goes through a SECURITY DEFINER helper that answers only for an organization the
-- caller belongs to (org_deals has no client grants).
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
REVOKE EXECUTE ON FUNCTION public._billing_org_setup_pending(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public._billing_org_setup_pending(uuid) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public._billing_guard_invite_while_setup_pending()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO ''
AS $function$
BEGIN
  IF current_user IN ('authenticated', 'anon')
     AND public._billing_org_setup_pending(NEW.organization_id) THEN
    RAISE EXCEPTION 'billing_setup_incomplete'
      USING ERRCODE = 'P0001', HINT = 'Finish the Billing step of your account setup before inviting people.';
  END IF;
  RETURN NEW;
END
$function$;
REVOKE EXECUTE ON FUNCTION public._billing_guard_invite_while_setup_pending() FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE TRIGGER _billing_guard_invite_while_setup_pending
  BEFORE INSERT ON public.organization_members
  FOR EACH ROW EXECUTE FUNCTION public._billing_guard_invite_while_setup_pending();

-- =====================================================================================
-- 12. Setup reminders, timed from the invite
-- =====================================================================================

CREATE OR REPLACE FUNCTION public._billing_enqueue_setup_reminders()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
  v_mode text;
  v_at timestamptz := now();
  v_day integer;
BEGIN
  IF NEW.user_id IS NOT NULL OR NEW.invitation_token IS NULL
     OR NEW.role NOT IN ('broker', 'admin')
     OR (TG_OP = 'UPDATE' AND NEW.invitation_token IS NOT DISTINCT FROM OLD.invitation_token) THEN
    RETURN NULL;
  END IF;
  SELECT d.stripe_mode INTO v_mode FROM public.org_deals d
   WHERE d.organization_id = NEW.organization_id AND d.status = 'draft';
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;
  -- A resend (new token) replaces the earlier pair for this invite. The dedupe key carries a
  -- hash of the token (never the token), so every send gets its own pair.
  UPDATE public.billing_outbox SET processed_at = now(), last_error = 'superseded_by_resend'
   WHERE kind = 'notify_setup_reminder' AND organization_id = NEW.organization_id
     AND processed_at IS NULL AND payload ->> 'member_id' = NEW.id::text;
  FOREACH v_day IN ARRAY ARRAY[3, 7] LOOP
    INSERT INTO public.billing_outbox (stripe_mode, kind, organization_id, dedupe_key, payload, run_after)
    VALUES (v_mode, 'notify_setup_reminder', NEW.organization_id,
            'notify_setup_reminder:' || v_mode || ':' || NEW.organization_id::text || ':' || NEW.id::text
              || ':' || left(md5(NEW.invitation_token), 16) || ':d' || v_day::text,
            jsonb_build_object('organization_id', NEW.organization_id, 'member_id', NEW.id,
                               'invite_sent_at', v_at, 'day', v_day),
            v_at + make_interval(days => v_day))
    ON CONFLICT (dedupe_key) DO NOTHING;
  END LOOP;
  RETURN NULL;
END
$function$;
REVOKE EXECUTE ON FUNCTION public._billing_enqueue_setup_reminders() FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE TRIGGER _billing_enqueue_setup_reminders
  AFTER INSERT OR UPDATE OF invitation_token ON public.organization_members
  FOR EACH ROW EXECUTE FUNCTION public._billing_enqueue_setup_reminders();

-- =====================================================================================
-- 13. Backfill: existing deals' billing contact -> org_contacts
-- =====================================================================================

INSERT INTO public.org_contacts (organization_id, role, full_name, email)
SELECT d.organization_id, 'billing',
       coalesce(nullif(btrim(d.billing_contact_name), ''), btrim(d.billing_contact_email)), btrim(d.billing_contact_email)
  FROM public.org_deals d
 WHERE d.billing_contact_id IS NULL
   AND position('@' in coalesce(d.billing_contact_email, '')) > 1
   AND NOT EXISTS (SELECT 1 FROM public.org_contacts c
                    WHERE c.organization_id = d.organization_id AND c.role = 'billing' AND c.removed_at IS NULL);

-- Sets billing_contact_id only (not version, status or updated_at): nothing is enqueued.
UPDATE public.org_deals d SET billing_contact_id = c.id
  FROM public.org_contacts c
 WHERE d.billing_contact_id IS NULL
   AND c.organization_id = d.organization_id AND c.role = 'billing' AND c.removed_at IS NULL;
