-- BACKLOG-3962 PR3a: domain capture. A brokerage with a VERIFIED domain claim moves the existing
-- personal-account users on that domain into the brokerage, after a 14-day notice.
--
-- Plan v2 (PR3 section), SR plan review, founder rulings on the item (seats B, undelivered notice A,
-- opt-out A, 14 days).
--
-- public.domain_capture_switches: one row per (organization, person) attempt.
--   status scheduled -> switched | opted_out | cancelled | failed
--   One SCHEDULED row per person (and so per organization and person).
--   switch_at = start + 14 days. The person is moved only when the day-0 notice was DELIVERED
--   (notice_delivered true = the mail service accepted the send, first try or a queued retry);
--   a notice that is not delivered cancels the switch with reason notice_undelivered.
--   No client role reads or writes the table: everything goes through the functions below.
--
-- Functions (every one SET search_path TO '', REVOKE from PUBLIC and anon, explicit GRANT):
--   _domain_capture_billing_ready()                internal: the 3850 plan-cancel trigger is live
--   _domain_capture_eval(uuid, uuid, text)          internal: candidate + attestation rule
--   _domain_capture_is_payer(uuid)                  internal: pays for a personal plan (live subscription, no organization)
--   domain_capture_candidates(uuid, uuid)           authenticated; admin of the org, claim verified
--   domain_capture_start(uuid, uuid, uuid[])        authenticated; admin of the org, claim verified
--   domain_capture_cancel(uuid)                     authenticated; admin of the row's org
--   domain_capture_opt_out_self(uuid)               authenticated; the row's own person
--   caller_capture_notice()                         authenticated; the caller's own rows
--   _domain_capture_mark_notice(uuid, text)         server role only (checked inside)
--   _domain_capture_due(integer)                    server role only (checked inside)
--   _domain_capture_switch(uuid)                    server role only (checked inside)
-- Replaced (same signatures, same grants), each now cancels the claim's scheduled switches in the
-- same transaction:
--   domain_claim_withdraw(uuid)                     reason claim_withdrawn
--   admin_revoke_domain_claim(uuid, text)           reason claim_revoked
--   _domain_claim_record_check(uuid, uuid, text[], boolean, text)   reason claim_lapsed (on lapse)
-- organization_members.provisioned_by CHECK gains 'domain_capture'.
--
-- Seats (ruling B): at switch the organization row is locked FOR NO KEY UPDATE (the lock the seat
-- trigger _enforce_member_seat_limit takes), seats are counted with member_row_holds_seat, and the
-- person joins 'active' when a seat is free, else 'unassigned'. A seat refusal from the trigger
-- (rule drift) falls back to 'unassigned'; a switch is never refused for seats.
-- The personal plan is cancelled by the 3850 trigger when the membership row is inserted; start and
-- switch both refuse while that trigger is not live (_domain_capture_billing_ready).
--
-- Rollback: supabase/tests/backlog-3962/rollback-3962-pr3.sql. Harness: supabase/tests/backlog-3962/.

-- Pre-check: nothing new exists yet; the bodies replaced and the seat rule mirrored are the bodies
-- read on keepr-test (and, for the seat functions, prod) on 2026-11-10.
DO $guard$
DECLARE v text;
BEGIN
  IF to_regclass('public.domain_capture_switches') IS NOT NULL THEN
    RAISE EXCEPTION 'BACKLOG-3962: public.domain_capture_switches already exists';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_proc
              WHERE pronamespace = 'public'::regnamespace
                AND proname IN ('_domain_capture_billing_ready', '_domain_capture_eval',
                                'domain_capture_candidates', 'domain_capture_start',
                                'domain_capture_cancel', 'domain_capture_opt_out_self',
                                'caller_capture_notice', '_domain_capture_mark_notice',
                                '_domain_capture_due', '_domain_capture_switch')) THEN
    RAISE EXCEPTION 'BACKLOG-3962: a domain capture function already exists';
  END IF;
  SELECT md5(prosrc) INTO v FROM pg_proc WHERE oid = 'public.domain_claim_withdraw(uuid)'::regprocedure;
  IF v IS DISTINCT FROM '74760b7c6272d9e29d23f26b785cdbd2' THEN
    RAISE EXCEPTION 'BACKLOG-3962: domain_claim_withdraw md5 % is not the PR1 body', v;
  END IF;
  SELECT md5(prosrc) INTO v FROM pg_proc WHERE oid = 'public.admin_revoke_domain_claim(uuid, text)'::regprocedure;
  IF v IS DISTINCT FROM '8886ba2c357f346ff68fd9b6edb2629f' THEN
    RAISE EXCEPTION 'BACKLOG-3962: admin_revoke_domain_claim md5 % is not the PR1 body', v;
  END IF;
  SELECT md5(prosrc) INTO v FROM pg_proc
   WHERE oid = 'public._domain_claim_record_check(uuid, uuid, text[], boolean, text)'::regprocedure;
  IF v IS DISTINCT FROM '251992795c4b241beed456a4746c93dc' THEN
    RAISE EXCEPTION 'BACKLOG-3962: _domain_claim_record_check md5 % is not the PR1 body', v;
  END IF;
  -- The switch mirrors the seat trigger's rule.
  SELECT md5(prosrc) INTO v FROM pg_proc WHERE oid = 'public._enforce_member_seat_limit()'::regprocedure;
  IF v IS DISTINCT FROM '2080be6b61fb35e5e3b933bf88f71c00' THEN
    RAISE EXCEPTION 'BACKLOG-3962: _enforce_member_seat_limit md5 % is not the expected body', v;
  END IF;
  SELECT md5(prosrc) INTO v FROM pg_proc
   WHERE oid = 'public.member_row_holds_seat(text, timestamptz, uuid)'::regprocedure;
  IF v IS DISTINCT FROM '72eda99a55c557d9a43cfc7d46ca6e95' THEN
    RAISE EXCEPTION 'BACKLOG-3962: member_row_holds_seat md5 % is not the expected body', v;
  END IF;
  SELECT pg_get_constraintdef(c.oid) INTO v FROM pg_constraint c
   WHERE c.conrelid = 'public.organization_members'::regclass
     AND c.conname = 'organization_members_provisioned_by_check';
  IF v IS DISTINCT FROM 'CHECK (((provisioned_by IS NULL) OR (provisioned_by = ANY (ARRAY[''manual''::text, ''scim''::text, ''jit''::text, ''invite''::text]))))' THEN
    RAISE EXCEPTION 'BACKLOG-3962: provisioned_by CHECK is not the expected one: %', v;
  END IF;
END
$guard$;

-- ---------------------------------------------------------------------------
-- provisioned_by gains 'domain_capture'
-- ---------------------------------------------------------------------------
ALTER TABLE public.organization_members DROP CONSTRAINT organization_members_provisioned_by_check;
ALTER TABLE public.organization_members ADD CONSTRAINT organization_members_provisioned_by_check
  CHECK (provisioned_by IS NULL OR provisioned_by = ANY (ARRAY['manual', 'scim', 'jit', 'invite', 'domain_capture']::text[]));

-- ---------------------------------------------------------------------------
-- Table
-- ---------------------------------------------------------------------------
CREATE TABLE public.domain_capture_switches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  claim_id uuid NOT NULL REFERENCES public.domain_claims(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  email_at_start text NOT NULL,
  attestation text NOT NULL,
  status text NOT NULL DEFAULT 'scheduled',
  reason text,
  notice_sent_at timestamptz,
  notice_delivered boolean,
  switch_at timestamptz NOT NULL,
  started_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  member_id uuid REFERENCES public.organization_members(id) ON DELETE SET NULL,
  license_status text,
  payer boolean,
  last_attempt_at timestamptz,
  switched_at timestamptz,
  cancelled_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  ended_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT domain_capture_switches_status_check
    CHECK (status IN ('scheduled', 'opted_out', 'switched', 'cancelled', 'failed')),
  CONSTRAINT domain_capture_switches_attestation_check
    CHECK (attestation IN ('azure_tid', 'google_hd', 'email_confirmed')),
  CONSTRAINT domain_capture_switches_reason_check CHECK (reason IS NULL OR reason IN (
    'opted_out', 'admin_cancelled', 'notice_undelivered', 'claim_withdrawn', 'claim_revoked',
    'claim_lapsed', 'claim_not_verified', 'not_eligible', 'switch_error', 'brokerage_suspended')),
  CONSTRAINT domain_capture_switches_license_check
    CHECK (license_status IS NULL OR license_status IN ('active', 'unassigned'))
);

-- One scheduled switch per person (hence per organization and person).
CREATE UNIQUE INDEX domain_capture_switches_one_scheduled_per_user
  ON public.domain_capture_switches (user_id) WHERE status = 'scheduled';
CREATE UNIQUE INDEX domain_capture_switches_one_scheduled_per_org_user
  ON public.domain_capture_switches (organization_id, user_id) WHERE status = 'scheduled';
CREATE INDEX domain_capture_switches_due
  ON public.domain_capture_switches (switch_at) WHERE status = 'scheduled';
CREATE INDEX domain_capture_switches_claim
  ON public.domain_capture_switches (claim_id, status);

ALTER TABLE public.domain_capture_switches ENABLE ROW LEVEL SECURITY;
-- No policy: no client role reads or writes rows directly.
REVOKE ALL ON TABLE public.domain_capture_switches FROM PUBLIC, anon, authenticated;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON TABLE public.domain_capture_switches
  FROM anon, authenticated;

-- ---------------------------------------------------------------------------
-- Internal helpers
-- ---------------------------------------------------------------------------

-- True when joining a brokerage ends the personal plan (BACKLOG-3850): the enqueue function exists
-- and the membership trigger body calls it.
CREATE FUNCTION public._domain_capture_billing_ready()
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path TO ''
AS $function$
  SELECT to_regprocedure('public._billing_enqueue_agent_cancel_on_join(uuid, uuid, uuid)') IS NOT NULL
     AND coalesce((SELECT p.prosrc FROM pg_catalog.pg_proc p
                    WHERE p.oid = to_regprocedure('public._retire_personal_membership()')), '')
         LIKE '%_billing_enqueue_agent_cancel_on_join(%';
$function$;

-- A person who pays for their own plan: a live (not closed) subscription row that belongs to no
-- organization. This is the database copy of the subscription, not Stripe.
CREATE FUNCTION public._domain_capture_is_payer(p_user uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path TO ''
AS $function$
  SELECT EXISTS (SELECT 1 FROM public.billing_subscriptions b
                  WHERE b.user_id = p_user AND b.organization_id IS NULL
                    AND b.status NOT IN ('canceled', 'incomplete_expired', 'incomplete'));
$function$;

-- The candidate rule for one person, one organization, one verified domain.
-- Returns the attestation ('azure_tid' | 'google_hd' | 'email_confirmed') or a refusal 'no:<why>':
--   no:no_user           no such sign-in account
--   no:email_domain      the account email is not on the domain (exact domain, no subdomains)
--   no:not_personal      the person owns no personal organization
--   no:brokerage_member  the person has a row in any brokerage, any status (deactivated included)
--   no:no_tenant         a Microsoft sign-in, but the organization has no Microsoft tenant recorded
--   no:foreign_tenant    a Microsoft sign-in from a tenant that is not the organization's
--   no:no_attestation    email match only: listed, never converted automatically
CREATE FUNCTION public._domain_capture_eval(p_user uuid, p_org uuid, p_domain text)
RETURNS text
LANGUAGE plpgsql
STABLE
SET search_path TO ''
AS $function$
DECLARE
  v_email text;
  v_confirmed timestamptz;
  v_tenant text;
BEGIN
  SELECT u.email, u.email_confirmed_at INTO v_email, v_confirmed FROM auth.users u WHERE u.id = p_user;
  IF NOT FOUND THEN
    RETURN 'no:no_user';
  END IF;
  IF v_email IS NULL OR p_domain IS NULL
     OR lower(split_part(btrim(v_email), '@', 2)) IS DISTINCT FROM lower(p_domain)
     OR position('@' IN btrim(v_email)) = 0 THEN
    RETURN 'no:email_domain';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.organizations o WHERE o.personal_owner_user_id = p_user) THEN
    RETURN 'no:not_personal';
  END IF;
  IF EXISTS (SELECT 1 FROM public.organization_members m
               JOIN public.organizations o ON o.id = m.organization_id
              WHERE m.user_id = p_user AND o.personal_owner_user_id IS NULL) THEN
    RETURN 'no:brokerage_member';
  END IF;

  SELECT nullif(btrim(o.microsoft_tenant_id), '') INTO v_tenant FROM public.organizations o WHERE o.id = p_org;
  -- A Microsoft sign-in while the organization records no tenant: listed as "cannot convert", never
  -- scheduled (nothing says which directory it belongs to).
  IF v_tenant IS NULL AND EXISTS (SELECT 1 FROM auth.identities i
                                   WHERE i.user_id = p_user AND i.provider = 'azure') THEN
    RETURN 'no:no_tenant';
  END IF;
  -- Any Microsoft sign-in whose tenant is not this organization's is a different directory: never
  -- a candidate.
  IF EXISTS (SELECT 1 FROM auth.identities i
              WHERE i.user_id = p_user AND i.provider = 'azure'
                AND (v_tenant IS NULL
                     OR coalesce(i.identity_data -> 'custom_claims' ->> 'tid', '') IS DISTINCT FROM v_tenant)) THEN
    RETURN 'no:foreign_tenant';
  END IF;
  IF v_tenant IS NOT NULL AND v_tenant <> '9188040d-6c67-4c5b-b112-36a304b66dad' -- pii-allow-uuid: Microsoft's public consumer-account tenant id (same constant as jit_join_organization)
     AND EXISTS (SELECT 1 FROM auth.identities i
                  WHERE i.user_id = p_user AND i.provider = 'azure'
                    AND i.identity_data -> 'custom_claims' ->> 'tid' = v_tenant) THEN
    RETURN 'azure_tid';
  END IF;
  IF EXISTS (SELECT 1 FROM auth.identities i
              WHERE i.user_id = p_user AND i.provider = 'google'
                AND lower(i.identity_data -> 'custom_claims' ->> 'hd') = lower(p_domain)) THEN
    RETURN 'google_hd';
  END IF;
  IF v_confirmed IS NOT NULL
     AND EXISTS (SELECT 1 FROM auth.identities i WHERE i.user_id = p_user AND i.provider = 'email') THEN
    RETURN 'email_confirmed';
  END IF;
  RETURN 'no:no_attestation';
END;
$function$;

-- ---------------------------------------------------------------------------
-- Org admin functions
-- ---------------------------------------------------------------------------

-- People on the claim's domain who could be moved. Refusals other than no_attestation and no_tenant
-- are left out; those two are listed with convertible false and a reason.
CREATE FUNCTION public.domain_capture_candidates(p_org uuid, p_claim uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_claim public.domain_claims;
BEGIN
  IF v_uid IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'not_authenticated');
  END IF;
  IF p_org IS NULL OR NOT public.is_org_admin(v_uid, p_org) THEN
    RETURN jsonb_build_object('success', false, 'error', 'not_authorized');
  END IF;
  SELECT * INTO v_claim FROM public.domain_claims c WHERE c.id = p_claim AND c.organization_id = p_org;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'claim_not_found');
  END IF;
  IF v_claim.status <> 'verified' THEN
    RETURN jsonb_build_object('success', false, 'error', 'claim_not_verified');
  END IF;

  RETURN jsonb_build_object('success', true, 'domain', v_claim.domain, 'candidates', coalesce((
    SELECT jsonb_agg(jsonb_build_object(
             'user_id', x.id, 'email', x.email,
             'attestation', CASE WHEN x.ev LIKE 'no:%' THEN NULL ELSE x.ev END,
             'convertible', x.ev NOT LIKE 'no:%',
             'reason', CASE WHEN x.ev LIKE 'no:%' THEN substr(x.ev, 4) END,
             'switch_id', s.id, 'switch_at', s.switch_at, 'notice_delivered', s.notice_delivered)
           ORDER BY x.email)
      FROM (SELECT u.id, u.email, public._domain_capture_eval(u.id, p_org, v_claim.domain) AS ev
              FROM auth.users u
             WHERE lower(split_part(btrim(u.email), '@', 2)) = v_claim.domain) x
      LEFT JOIN public.domain_capture_switches s
             ON s.user_id = x.id AND s.organization_id = p_org AND s.status = 'scheduled'
     WHERE x.ev IN ('azure_tid', 'google_hd', 'email_confirmed', 'no:no_attestation', 'no:no_tenant')), '[]'::jsonb));
END;
$function$;

-- Schedules switches for the listed people. Each one is re-evaluated here; the browser's list is a
-- request, never a decision. Returns what to notify (the portal sends the day-0 notice).
CREATE FUNCTION public.domain_capture_start(p_org uuid, p_claim uuid, p_users uuid[])
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_claim public.domain_claims;
  v_org public.organizations;
  v_user uuid;
  v_ev text;
  v_email text;
  v_row public.domain_capture_switches;
  v_scheduled jsonb := '[]'::jsonb;
  v_skipped jsonb := '[]'::jsonb;
BEGIN
  IF v_uid IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'not_authenticated');
  END IF;
  IF p_org IS NULL OR NOT public.is_org_admin(v_uid, p_org) THEN
    RETURN jsonb_build_object('success', false, 'error', 'not_authorized');
  END IF;
  SELECT * INTO v_org FROM public.organizations o WHERE o.id = p_org;
  IF NOT FOUND OR v_org.personal_owner_user_id IS NOT NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'not_authorized');
  END IF;
  SELECT * INTO v_claim FROM public.domain_claims c WHERE c.id = p_claim AND c.organization_id = p_org FOR SHARE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'claim_not_found');
  END IF;
  IF v_claim.status <> 'verified' THEN
    RETURN jsonb_build_object('success', false, 'error', 'claim_not_verified');
  END IF;
  IF NOT public._domain_capture_billing_ready() THEN
    RETURN jsonb_build_object('success', false, 'error', 'billing_not_ready');
  END IF;
  -- The brokerage's Billing step is not done: nobody is moved in (same predicate as the join guard).
  IF public._billing_org_join_blocked(p_org) THEN
    RETURN jsonb_build_object('success', false, 'error', 'billing_setup_incomplete');
  END IF;
  IF p_users IS NULL OR cardinality(p_users) = 0 OR cardinality(p_users) > 500 THEN
    RETURN jsonb_build_object('success', false, 'error', 'invalid_selection');
  END IF;

  FOR v_user IN SELECT DISTINCT x FROM unnest(p_users) AS t(x) WHERE x IS NOT NULL LOOP
    v_ev := public._domain_capture_eval(v_user, p_org, v_claim.domain);
    IF v_ev LIKE 'no:%' THEN
      v_skipped := v_skipped || jsonb_build_object('user_id', v_user, 'reason', substr(v_ev, 4));
      CONTINUE;
    END IF;
    SELECT u.email INTO v_email FROM auth.users u WHERE u.id = v_user;
    BEGIN
      INSERT INTO public.domain_capture_switches
        (organization_id, claim_id, user_id, email_at_start, attestation, switch_at, started_by)
      VALUES (p_org, v_claim.id, v_user, btrim(v_email), v_ev, now() + interval '14 days', v_uid)
      RETURNING * INTO v_row;
    EXCEPTION WHEN unique_violation THEN
      v_skipped := v_skipped || jsonb_build_object('user_id', v_user, 'reason', 'already_scheduled');
      CONTINUE;
    END;
    v_scheduled := v_scheduled || jsonb_build_object('switch_id', v_row.id, 'user_id', v_user,
      'email', v_row.email_at_start, 'switch_at', v_row.switch_at,
      'payer', public._domain_capture_is_payer(v_user));
  END LOOP;

  RETURN jsonb_build_object('success', true, 'domain', v_claim.domain,
    'brokerage_name', v_org.name, 'scheduled', v_scheduled, 'skipped', v_skipped);
END;
$function$;

CREATE FUNCTION public.domain_capture_cancel(p_switch uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_row public.domain_capture_switches;
BEGIN
  IF v_uid IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'not_authenticated');
  END IF;
  SELECT * INTO v_row FROM public.domain_capture_switches s WHERE s.id = p_switch FOR UPDATE;
  IF NOT FOUND OR NOT public.is_org_admin(v_uid, v_row.organization_id) THEN
    RETURN jsonb_build_object('success', false, 'error', 'switch_not_found');
  END IF;
  IF v_row.status <> 'scheduled' THEN
    RETURN jsonb_build_object('success', false, 'error', 'not_scheduled', 'status', v_row.status);
  END IF;
  UPDATE public.domain_capture_switches
     SET status = 'cancelled', reason = 'admin_cancelled', cancelled_by = v_uid, ended_at = now(), updated_at = now()
   WHERE id = v_row.id;
  RETURN jsonb_build_object('success', true, 'switch_id', v_row.id, 'status', 'cancelled');
END;
$function$;

-- ---------------------------------------------------------------------------
-- The person's own functions
-- ---------------------------------------------------------------------------

-- Opt out of one's own scheduled switch, before the switch time. The portal asks for a confirm
-- step first; a link (GET) never calls this.
CREATE FUNCTION public.domain_capture_opt_out_self(p_switch uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_row public.domain_capture_switches;
BEGIN
  IF v_uid IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'not_authenticated');
  END IF;
  SELECT * INTO v_row FROM public.domain_capture_switches s WHERE s.id = p_switch FOR UPDATE;
  -- Not found and someone else's row read the same.
  IF NOT FOUND OR v_row.user_id IS DISTINCT FROM v_uid THEN
    RETURN jsonb_build_object('success', false, 'error', 'switch_not_found');
  END IF;
  IF v_row.status <> 'scheduled' THEN
    RETURN jsonb_build_object('success', false, 'error', 'not_scheduled', 'status', v_row.status);
  END IF;
  IF now() >= v_row.switch_at THEN
    RETURN jsonb_build_object('success', false, 'error', 'too_late');
  END IF;
  UPDATE public.domain_capture_switches
     SET status = 'opted_out', reason = 'opted_out', ended_at = now(), updated_at = now()
   WHERE id = v_row.id;
  RETURN jsonb_build_object('success', true, 'switch_id', v_row.id, 'status', 'opted_out');
END;
$function$;

-- The caller's own scheduled switches (for the personal-owner banner).
CREATE FUNCTION public.caller_capture_notice()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE v_uid uuid := auth.uid();
BEGIN
  IF v_uid IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'not_authenticated');
  END IF;
  RETURN jsonb_build_object('success', true, 'switches', coalesce((
    SELECT jsonb_agg(jsonb_build_object(
             'switch_id', s.id, 'brokerage_name', o.name, 'domain', c.domain,
             'switch_at', s.switch_at) ORDER BY s.switch_at)
      FROM public.domain_capture_switches s
      JOIN public.organizations o ON o.id = s.organization_id
      JOIN public.domain_claims c ON c.id = s.claim_id
     WHERE s.user_id = v_uid AND s.status = 'scheduled'), '[]'::jsonb));
END;
$function$;

-- ---------------------------------------------------------------------------
-- Server-role functions (the portal's notice sender and the hourly switch job). Granted to the
-- server role only, AND each refuses any other role inside.
-- ---------------------------------------------------------------------------

-- Records the day-0 notice outcome reported by the mail layer:
--   'sent'    accepted by the mail service (first send or queued retry) -> delivered
--   'queued'  a transient failure was queued for retry -> undecided (resolved by the switch job)
--   'failed' | 'skipped'  not sent and not retried -> the switch is cancelled, notice_undelivered
CREATE FUNCTION public._domain_capture_mark_notice(p_switch uuid, p_outcome text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE v_row public.domain_capture_switches;
BEGIN
  IF coalesce(auth.role(), '') <> 'service_role' THEN
    RAISE EXCEPTION 'Not allowed' USING ERRCODE = '42501';
  END IF;
  IF p_outcome IS NULL OR p_outcome NOT IN ('sent', 'queued', 'failed', 'skipped') THEN
    RETURN jsonb_build_object('success', false, 'error', 'invalid_outcome');
  END IF;
  SELECT * INTO v_row FROM public.domain_capture_switches s WHERE s.id = p_switch FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'switch_not_found');
  END IF;
  IF v_row.status <> 'scheduled' THEN
    RETURN jsonb_build_object('success', false, 'error', 'not_scheduled', 'status', v_row.status);
  END IF;
  IF p_outcome = 'sent' THEN
    UPDATE public.domain_capture_switches
       SET notice_delivered = true, notice_sent_at = coalesce(notice_sent_at, now()), updated_at = now()
     WHERE id = v_row.id;
    RETURN jsonb_build_object('success', true, 'status', 'scheduled', 'notice_delivered', true);
  END IF;
  IF p_outcome = 'queued' THEN
    UPDATE public.domain_capture_switches
       SET notice_sent_at = coalesce(notice_sent_at, now()), updated_at = now()
     WHERE id = v_row.id;
    RETURN jsonb_build_object('success', true, 'status', 'scheduled', 'notice_delivered', null);
  END IF;
  UPDATE public.domain_capture_switches
     SET notice_delivered = false, status = 'cancelled', reason = 'notice_undelivered',
         ended_at = now(), updated_at = now()
   WHERE id = v_row.id;
  RETURN jsonb_build_object('success', true, 'status', 'cancelled', 'reason', 'notice_undelivered');
END;
$function$;

-- Scheduled switches whose time has come, not attempted in the last 50 minutes. Selects and stamps
-- in one statement (FOR UPDATE SKIP LOCKED), so two overlapping runs never take the same row.
CREATE FUNCTION public._domain_capture_due(p_limit integer)
RETURNS TABLE (switch_id uuid, organization_id uuid, claim_id uuid, user_id uuid, domain text,
               notice_delivered boolean)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
BEGIN
  IF coalesce(auth.role(), '') <> 'service_role' THEN
    RAISE EXCEPTION 'Not allowed' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY
  WITH due AS (
    SELECT s.id FROM public.domain_capture_switches s
     WHERE s.status = 'scheduled'
       AND s.switch_at <= now()
       AND (s.last_attempt_at IS NULL OR s.last_attempt_at < now() - interval '50 minutes')
     ORDER BY s.switch_at
     LIMIT least(greatest(coalesce(p_limit, 100), 1), 500)
     FOR UPDATE SKIP LOCKED
  )
  UPDATE public.domain_capture_switches d
     SET last_attempt_at = now(), updated_at = now()
    FROM due
   WHERE d.id = due.id
  RETURNING d.id, d.organization_id, d.claim_id, d.user_id,
            (SELECT c.domain FROM public.domain_claims c WHERE c.id = d.claim_id),
            d.notice_delivered;
END;
$function$;

-- Moves one person. Every condition is re-checked here, under the row lock:
--   still scheduled and due; notice delivered (else cancelled notice_undelivered); claim verified
--   (else cancelled claim_not_verified) with a verified DNS answer recorded in the last hour (else
--   left scheduled, retried next run); the candidate rule and attestation still hold (else
--   cancelled not_eligible); the 3850 plan-cancel trigger is live and the brokerage's Billing step
--   is done (else left scheduled). A suspended brokerage cancels the switch (brokerage_suspended).
-- Then the seat decision and the membership insert, in this transaction, under the organization lock.
CREATE FUNCTION public._domain_capture_switch(p_switch uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
  v_row public.domain_capture_switches;
  v_claim public.domain_claims;
  v_ev text;
  v_max integer;
  v_personal uuid;
  v_name text;
  v_used integer;
  v_status text;
  v_member uuid;
  v_payer boolean;
  v_fallback boolean := false;
  v_suspended boolean := false;
  v_role text;
BEGIN
  IF coalesce(auth.role(), '') <> 'service_role' THEN
    RAISE EXCEPTION 'Not allowed' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO v_row FROM public.domain_capture_switches s WHERE s.id = p_switch FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'switch_not_found');
  END IF;
  IF v_row.status <> 'scheduled' THEN
    RETURN jsonb_build_object('success', false, 'error', 'not_scheduled', 'status', v_row.status);
  END IF;
  IF now() < v_row.switch_at THEN
    RETURN jsonb_build_object('success', false, 'error', 'not_due');
  END IF;

  IF v_row.notice_delivered IS NOT TRUE THEN
    UPDATE public.domain_capture_switches
       SET status = 'cancelled', reason = 'notice_undelivered', notice_delivered = false,
           ended_at = now(), updated_at = now()
     WHERE id = v_row.id;
    RETURN jsonb_build_object('success', true, 'outcome', 'cancelled', 'reason', 'notice_undelivered');
  END IF;

  SELECT * INTO v_claim FROM public.domain_claims c
   WHERE c.id = v_row.claim_id AND c.organization_id = v_row.organization_id FOR SHARE;
  IF NOT FOUND OR v_claim.status <> 'verified' THEN
    UPDATE public.domain_capture_switches
       SET status = 'cancelled', reason = 'claim_not_verified', ended_at = now(), updated_at = now()
     WHERE id = v_row.id;
    RETURN jsonb_build_object('success', true, 'outcome', 'cancelled', 'reason', 'claim_not_verified');
  END IF;
  IF v_claim.last_check_result IS DISTINCT FROM 'verified'
     OR v_claim.last_checked_at IS NULL OR v_claim.last_checked_at < now() - interval '1 hour' THEN
    RETURN jsonb_build_object('success', false, 'error', 'dns_not_fresh');
  END IF;

  v_ev := public._domain_capture_eval(v_row.user_id, v_row.organization_id, v_claim.domain);
  IF v_ev LIKE 'no:%' THEN
    UPDATE public.domain_capture_switches
       SET status = 'cancelled', reason = 'not_eligible', ended_at = now(), updated_at = now()
     WHERE id = v_row.id;
    RETURN jsonb_build_object('success', true, 'outcome', 'cancelled', 'reason', 'not_eligible',
                              'detail', substr(v_ev, 4));
  END IF;

  IF NOT public._domain_capture_billing_ready() THEN
    RETURN jsonb_build_object('success', false, 'error', 'billing_not_ready');
  END IF;
  IF public._billing_org_join_blocked(v_row.organization_id) THEN
    RETURN jsonb_build_object('success', false, 'error', 'billing_setup_incomplete');
  END IF;

  -- Seats (ruling B). Same lock as the seat trigger: one seat writer per organization at a time.
  SELECT o.max_seats, o.personal_owner_user_id, o.name, CASE WHEN o.default_member_role IN ('agent', 'broker') THEN o.default_member_role ELSE 'agent' END
    INTO v_max, v_personal, v_name, v_role
    FROM public.organizations o WHERE o.id = v_row.organization_id
    FOR NO KEY UPDATE;
  IF v_personal IS NOT NULL THEN
    UPDATE public.domain_capture_switches
       SET status = 'cancelled', reason = 'not_eligible', ended_at = now(), updated_at = now()
     WHERE id = v_row.id;
    RETURN jsonb_build_object('success', true, 'outcome', 'cancelled', 'reason', 'not_eligible');
  END IF;
  SELECT count(*) INTO v_used FROM public.organization_members m
   WHERE m.organization_id = v_row.organization_id
     AND public.member_row_holds_seat(m.license_status, m.invitation_expires_at, m.user_id);
  v_status := CASE WHEN v_max IS NULL OR v_max <= 0 OR v_used < v_max THEN 'active' ELSE 'unassigned' END;

  v_payer := public._domain_capture_is_payer(v_row.user_id);

  BEGIN
    INSERT INTO public.organization_members
      (organization_id, user_id, role, license_status, joined_at, provisioned_by, provisioned_at)
    VALUES (v_row.organization_id, v_row.user_id, v_role, v_status, now(), 'domain_capture', now())
    RETURNING id INTO v_member;
  EXCEPTION WHEN SQLSTATE 'P0001' THEN
    IF SQLERRM = 'account_suspended' THEN
      v_suspended := true;
    ELSIF v_status <> 'active' OR SQLERRM NOT LIKE '%seat_limit_reached%' THEN
      RAISE;
    ELSE
      -- The seat trigger disagreed with the count above: join without a seat, never refuse.
      RAISE WARNING 'BACKLOG-3962: seat trigger refused a counted free seat in organization %', v_row.organization_id;
      v_status := 'unassigned';
      v_fallback := true;
      BEGIN
        INSERT INTO public.organization_members
          (organization_id, user_id, role, license_status, joined_at, provisioned_by, provisioned_at)
        VALUES (v_row.organization_id, v_row.user_id, v_role, v_status, now(), 'domain_capture', now())
        RETURNING id INTO v_member;
      EXCEPTION WHEN SQLSTATE 'P0001' THEN
        IF SQLERRM = 'account_suspended' THEN
          v_suspended := true;
        ELSE
          RAISE;
        END IF;
      END;
    END IF;
  END;

  -- A suspended brokerage takes nobody in (the member trigger refused): no membership, no plan
  -- cancellation, the switch ends.
  IF v_suspended THEN
    UPDATE public.domain_capture_switches
       SET status = 'cancelled', reason = 'brokerage_suspended', ended_at = now(), updated_at = now()
     WHERE id = v_row.id;
    RETURN jsonb_build_object('success', true, 'outcome', 'cancelled', 'reason', 'brokerage_suspended');
  END IF;

  UPDATE public.domain_capture_switches
     SET status = 'switched', member_id = v_member, license_status = v_status, payer = v_payer,
         switched_at = now(), ended_at = now(), updated_at = now()
   WHERE id = v_row.id;

  RETURN jsonb_build_object('success', true, 'outcome', 'switched', 'switch_id', v_row.id,
    'member_id', v_member, 'license_status', v_status, 'payer', v_payer,
    'user_id', v_row.user_id, 'email', v_row.email_at_start,
    'organization_id', v_row.organization_id, 'brokerage_name', v_name, 'seat_fallback', v_fallback);
END;
$function$;

-- ---------------------------------------------------------------------------
-- Replaced PR1 bodies: the claim leaving 'verified' cancels its scheduled switches here.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.domain_claim_withdraw(p_claim uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_row public.domain_claims;
BEGIN
  IF v_uid IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'not_authenticated');
  END IF;
  SELECT * INTO v_row FROM public.domain_claims c WHERE c.id = p_claim FOR UPDATE;
  -- Not found and not this caller's org read the same, so a claim id leaks nothing.
  IF NOT FOUND OR NOT public.is_org_admin(v_uid, v_row.organization_id) THEN
    RETURN jsonb_build_object('success', false, 'error', 'claim_not_found');
  END IF;
  IF v_row.status NOT IN ('pending', 'verified', 'lapsed') THEN
    RETURN jsonb_build_object('success', false, 'error', 'not_withdrawable');
  END IF;
  UPDATE public.domain_claims SET status = 'withdrawn', updated_at = now() WHERE id = v_row.id;
  -- BACKLOG-3962 PR3a: scheduled switches end with the claim.
  UPDATE public.domain_capture_switches
     SET status = 'cancelled', reason = 'claim_withdrawn', ended_at = now(), updated_at = now()
   WHERE claim_id = v_row.id AND status = 'scheduled';
  RETURN jsonb_build_object('success', true, 'claim_id', v_row.id, 'status', 'withdrawn');
END;
$function$;

CREATE OR REPLACE FUNCTION public.admin_revoke_domain_claim(p_claim uuid, p_reason text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_row public.domain_claims;
  v_reason text := btrim(coalesce(p_reason, ''));
BEGIN
  IF v_uid IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'not_authenticated');
  END IF;
  IF NOT public.has_internal_role(v_uid) THEN
    RETURN jsonb_build_object('success', false, 'error', 'not_internal_user');
  END IF;
  IF NOT public.has_permission(v_uid, 'organizations.edit') THEN
    RETURN jsonb_build_object('success', false, 'error', 'insufficient_permissions');
  END IF;
  IF v_reason = '' OR length(v_reason) > 500 THEN
    RETURN jsonb_build_object('success', false, 'error', 'invalid_reason');
  END IF;
  SELECT * INTO v_row FROM public.domain_claims c WHERE c.id = p_claim FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'claim_not_found');
  END IF;
  IF v_row.status NOT IN ('pending', 'verified', 'lapsed') THEN
    RETURN jsonb_build_object('success', false, 'error', 'not_revocable');
  END IF;

  UPDATE public.domain_claims
     SET status = 'revoked', revoked_at = now(), revoked_by = v_uid, revoke_reason = v_reason,
         updated_at = now()
   WHERE id = v_row.id;
  -- BACKLOG-3962 PR3a: scheduled switches end with the claim.
  UPDATE public.domain_capture_switches
     SET status = 'cancelled', reason = 'claim_revoked', ended_at = now(), updated_at = now()
   WHERE claim_id = v_row.id AND status = 'scheduled';

  PERFORM public.log_admin_action(
    'domain_claim.revoke',
    'domain_claim',
    v_row.id::text,
    jsonb_build_object(
      'organization_id', v_row.organization_id,
      'domain', v_row.domain,
      'before', jsonb_build_object('status', v_row.status),
      'after', jsonb_build_object('status', 'revoked'),
      'reason', v_reason
    )
  );

  RETURN jsonb_build_object('success', true, 'claim_id', v_row.id, 'status', 'revoked');
END;
$function$;

CREATE OR REPLACE FUNCTION public._domain_claim_record_check(
  p_claim uuid,
  p_org uuid,
  p_answers text[],
  p_resolver_ok boolean,
  p_source text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
  v_row public.domain_claims;
  v_found boolean;
  v_result text;
  v_misses integer;
  v_status text;
  v_counted timestamptz;
BEGIN
  IF coalesce(auth.role(), '') <> 'service_role' THEN
    RAISE EXCEPTION 'Not allowed' USING ERRCODE = '42501';
  END IF;
  IF p_source IS NULL OR p_source NOT IN ('manual', 'recheck') THEN
    RETURN jsonb_build_object('success', false, 'error', 'invalid_source');
  END IF;

  SELECT * INTO v_row FROM public.domain_claims c
   WHERE c.id = p_claim AND c.organization_id = p_org
   FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'claim_not_found');
  END IF;
  IF v_row.status NOT IN ('pending', 'verified', 'lapsed') THEN
    RETURN jsonb_build_object('success', false, 'error', 'not_checkable');
  END IF;

  -- A resolver outage is never a miss.
  IF p_resolver_ok IS NOT TRUE THEN
    UPDATE public.domain_claims
       SET last_check_result = 'resolver_unavailable', last_checked_at = now(), updated_at = now()
     WHERE id = v_row.id;
    RETURN jsonb_build_object('success', true, 'result', 'resolver_unavailable', 'status', v_row.status);
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM unnest(coalesce(p_answers, ARRAY[]::text[])) AS a(answer)
     WHERE btrim(a.answer) = v_row.token
  ) INTO v_found;

  IF v_found THEN
    IF v_row.status = 'verified' THEN
      UPDATE public.domain_claims
         SET consecutive_misses = 0, last_miss_counted_at = NULL, last_check_result = 'verified',
             last_checked_at = now(), updated_at = now()
       WHERE id = v_row.id;
      RETURN jsonb_build_object('success', true, 'result', 'verified', 'status', 'verified');
    END IF;
    BEGIN
      UPDATE public.domain_claims
         SET status = 'verified', verified_at = now(), consecutive_misses = 0,
             last_miss_counted_at = NULL, last_check_result = 'verified',
             last_checked_at = now(), updated_at = now()
       WHERE id = v_row.id;
    EXCEPTION WHEN unique_violation THEN
      -- Another organization verified this domain first. This row keeps its status.
      UPDATE public.domain_claims
         SET last_check_result = 'domain_taken', last_checked_at = now(), updated_at = now()
       WHERE id = v_row.id;
      RETURN jsonb_build_object('success', true, 'result', 'domain_taken', 'status', v_row.status);
    END;
    RETURN jsonb_build_object('success', true, 'result', 'verified', 'status', 'verified');
  END IF;

  SELECT CASE WHEN EXISTS (
           SELECT 1 FROM unnest(coalesce(p_answers, ARRAY[]::text[])) AS a(answer)
            WHERE left(btrim(a.answer), length('keepr-domain-verification=')) = 'keepr-domain-verification='
         ) THEN 'mismatch' ELSE 'not_found' END
    INTO v_result;

  v_misses := v_row.consecutive_misses;
  v_status := v_row.status;
  v_counted := v_row.last_miss_counted_at;
  IF v_row.status = 'verified' AND p_source = 'recheck'
     AND (v_row.last_miss_counted_at IS NULL OR v_row.last_miss_counted_at <= now() - interval '20 hours') THEN
    v_misses := v_misses + 1;
    v_counted := now();
    IF v_misses >= 3 THEN
      v_status := 'lapsed';
    END IF;
  END IF;

  UPDATE public.domain_claims
     SET last_check_result = v_result, consecutive_misses = v_misses, last_miss_counted_at = v_counted,
         status = v_status, last_checked_at = now(), updated_at = now()
   WHERE id = v_row.id;

  -- BACKLOG-3962 PR3a: a lapse ends the claim's scheduled switches.
  IF v_status = 'lapsed' AND v_row.status = 'verified' THEN
    UPDATE public.domain_capture_switches
       SET status = 'cancelled', reason = 'claim_lapsed', ended_at = now(), updated_at = now()
     WHERE claim_id = v_row.id AND status = 'scheduled';
  END IF;

  RETURN jsonb_build_object('success', true, 'result', v_result, 'status', v_status,
                            'consecutive_misses', v_misses);
END;
$function$;

-- ---------------------------------------------------------------------------
-- Grants: revoke by default, then grant only the callers.
-- ---------------------------------------------------------------------------
REVOKE ALL ON FUNCTION public._domain_capture_billing_ready() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._domain_capture_eval(uuid, uuid, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._domain_capture_is_payer(uuid) FROM PUBLIC, anon, authenticated;

REVOKE ALL ON FUNCTION public.domain_capture_candidates(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.domain_capture_candidates(uuid, uuid) TO authenticated;
REVOKE ALL ON FUNCTION public.domain_capture_start(uuid, uuid, uuid[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.domain_capture_start(uuid, uuid, uuid[]) TO authenticated;
REVOKE ALL ON FUNCTION public.domain_capture_cancel(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.domain_capture_cancel(uuid) TO authenticated;
REVOKE ALL ON FUNCTION public.domain_capture_opt_out_self(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.domain_capture_opt_out_self(uuid) TO authenticated;
REVOKE ALL ON FUNCTION public.caller_capture_notice() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.caller_capture_notice() TO authenticated;

REVOKE ALL ON FUNCTION public._domain_capture_mark_notice(uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public._domain_capture_mark_notice(uuid, text) TO service_role;
REVOKE ALL ON FUNCTION public._domain_capture_due(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public._domain_capture_due(integer) TO service_role;
REVOKE ALL ON FUNCTION public._domain_capture_switch(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public._domain_capture_switch(uuid) TO service_role;

-- Replaced bodies: unchanged by CREATE OR REPLACE; restated so the file stands on its own.
REVOKE ALL ON FUNCTION public.domain_claim_withdraw(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.domain_claim_withdraw(uuid) TO authenticated;
REVOKE ALL ON FUNCTION public.admin_revoke_domain_claim(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_revoke_domain_claim(uuid, text) TO authenticated;
REVOKE ALL ON FUNCTION public._domain_claim_record_check(uuid, uuid, text[], boolean, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public._domain_claim_record_check(uuid, uuid, text[], boolean, text) TO service_role;

-- Post-check: every new or replaced function, every client role, the table, the definer settings.
-- POSTCHECK BEGIN
DO $guard$
DECLARE
  f text;
  v_client_ok text[] := ARRAY[
    'public.domain_capture_candidates(uuid, uuid)',
    'public.domain_capture_start(uuid, uuid, uuid[])',
    'public.domain_capture_cancel(uuid)',
    'public.domain_capture_opt_out_self(uuid)',
    'public.caller_capture_notice()',
    'public.domain_claim_withdraw(uuid)',
    'public.admin_revoke_domain_claim(uuid, text)'];
  v_closed text[] := ARRAY[
    'public._domain_capture_billing_ready()',
    'public._domain_capture_eval(uuid, uuid, text)',
    'public._domain_capture_is_payer(uuid)',
    'public._domain_capture_mark_notice(uuid, text)',
    'public._domain_capture_due(integer)',
    'public._domain_capture_switch(uuid)',
    'public._domain_claim_record_check(uuid, uuid, text[], boolean, text)'];
  v_service text[] := ARRAY[
    'public._domain_capture_mark_notice(uuid, text)',
    'public._domain_capture_due(integer)',
    'public._domain_capture_switch(uuid)',
    'public._domain_claim_record_check(uuid, uuid, text[], boolean, text)'];
  v_definer text[] := ARRAY[
    'public.domain_capture_candidates(uuid, uuid)',
    'public.domain_capture_start(uuid, uuid, uuid[])',
    'public.domain_capture_cancel(uuid)',
    'public.domain_capture_opt_out_self(uuid)',
    'public.caller_capture_notice()',
    'public._domain_capture_mark_notice(uuid, text)',
    'public._domain_capture_due(integer)',
    'public._domain_capture_switch(uuid)',
    'public.domain_claim_withdraw(uuid)',
    'public.admin_revoke_domain_claim(uuid, text)',
    'public._domain_claim_record_check(uuid, uuid, text[], boolean, text)'];
BEGIN
  FOREACH f IN ARRAY v_client_ok || v_closed LOOP
    IF has_function_privilege('anon', f, 'EXECUTE') THEN
      RAISE EXCEPTION 'BACKLOG-3962: anon can execute %', f;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_proc p WHERE p.oid = f::regprocedure
                     AND p.proconfig @> ARRAY['search_path=""']) THEN
      RAISE EXCEPTION 'BACKLOG-3962: % does not pin an empty search_path', f;
    END IF;
  END LOOP;
  FOREACH f IN ARRAY v_closed LOOP
    IF has_function_privilege('authenticated', f, 'EXECUTE') THEN
      RAISE EXCEPTION 'BACKLOG-3962: authenticated can execute %', f;
    END IF;
  END LOOP;
  FOREACH f IN ARRAY v_client_ok LOOP
    IF NOT has_function_privilege('authenticated', f, 'EXECUTE') THEN
      RAISE EXCEPTION 'BACKLOG-3962: authenticated cannot execute %', f;
    END IF;
  END LOOP;
  FOREACH f IN ARRAY v_service LOOP
    IF NOT has_function_privilege('service_role', f, 'EXECUTE') THEN
      RAISE EXCEPTION 'BACKLOG-3962: the server role cannot execute %', f;
    END IF;
  END LOOP;
  FOREACH f IN ARRAY v_definer LOOP
    IF NOT (SELECT p.prosecdef FROM pg_proc p WHERE p.oid = f::regprocedure) THEN
      RAISE EXCEPTION 'BACKLOG-3962: % is not SECURITY DEFINER', f;
    END IF;
  END LOOP;
  IF has_table_privilege('anon', 'public.domain_capture_switches', 'SELECT')
     OR has_table_privilege('authenticated', 'public.domain_capture_switches', 'SELECT')
     OR has_table_privilege('anon', 'public.domain_capture_switches', 'INSERT')
     OR has_table_privilege('anon', 'public.domain_capture_switches', 'UPDATE')
     OR has_table_privilege('anon', 'public.domain_capture_switches', 'DELETE')
     OR has_table_privilege('anon', 'public.domain_capture_switches', 'TRUNCATE')
     OR has_table_privilege('authenticated', 'public.domain_capture_switches', 'INSERT')
     OR has_table_privilege('authenticated', 'public.domain_capture_switches', 'UPDATE')
     OR has_table_privilege('authenticated', 'public.domain_capture_switches', 'DELETE')
     OR has_table_privilege('authenticated', 'public.domain_capture_switches', 'TRUNCATE') THEN
    RAISE EXCEPTION 'BACKLOG-3962: a client role has a grant on domain_capture_switches';
  END IF;
  IF NOT (SELECT c.relrowsecurity FROM pg_class c WHERE c.oid = 'public.domain_capture_switches'::regclass) THEN
    RAISE EXCEPTION 'BACKLOG-3962: row level security is off on domain_capture_switches';
  END IF;
  IF (SELECT count(*) FROM pg_policy p WHERE p.polrelid = 'public.domain_capture_switches'::regclass) <> 0 THEN
    RAISE EXCEPTION 'BACKLOG-3962: domain_capture_switches must carry no policy';
  END IF;
END
$guard$;
-- POSTCHECK END
