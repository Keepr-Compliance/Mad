-- BACKLOG-3853 PR-1 M1: brokerage billing tables and the suspension gates.
--
-- A brokerage is suspended when its org_deals row has status 'suspended'. One predicate,
-- public.org_billing_suspended(org), is what every gate below reads. While it is true:
--   G1 exports      - get_org_features of the brokerage reads unlimited_transactions false
--                     (override written by _billing_apply_org_entitlement), and
--                     unlock_transaction refuses a credit unlock ('account_suspended') when
--                     the caller's deciding organization is suspended.
--   G2 submitting   - a new transaction_submissions row, a plain UPDATE out of 'uploading',
--                     finalize_submission and a storage upload into submission-attachments
--                     are refused.
--   G3 approvals    - the reviewer branch of transaction_submissions_update_public (USING and
--                     WITH CHECK) is refused, including a broker approving their own row.
--   G4 seeing       - can_review_submission is false, so reviewers see none of the org's
--                     submissions, messages, attachments or comments. A member keeps
--                     read-only sight of their OWN submissions (founder Q7 = a); writing a
--                     comment is refused for everyone.
--   G5 licenses     - a BEFORE trigger on organization_members refuses, for every writer:
--                     any INSERT; a license_status change to active / unassigned / pending;
--                     the claim of an unclaimed invitation (user_id NULL -> set, which covers
--                     a 'pending' invite and an 'unassigned' one from M4); a Resend (token or
--                     expiry change on an unclaimed 'pending' / 'unassigned' row); moving a
--                     row into the org. Deactivate (-> suspended / expired) and DELETE stay
--                     allowed.
-- Suspension itself never writes an organization_members row.
--
-- Darkness (SR R14): org_deals.stripe_mode is NOT NULL and carries _guard_stripe_mode_is_test
-- (a 'test' deal needs an is_test organization). _billing_save_deal, admin_suspend_org,
-- admin_reinstate_org and _billing_change_seats refuse a 'live' deal while
-- billing_settings.brokerage_billing_live is false (the default; the founder flips it).
--
-- Replaced (CREATE OR REPLACE only, same signatures, BACKLOG-3947; grants kept):
--   unlock_transaction(text), finalize_submission(uuid,jsonb), can_review_submission(uuid).
-- Policies changed by ALTER POLICY: agents_can_create_submissions,
--   transaction_submissions_update_public, users_can_create_comments (public) and
--   "Members can upload submission attachments" (storage.objects).
--
-- Pre-check (aborts on any difference): md5(pg_get_functiondef(oid)) of each replaced
-- function is the current one or this file's; md5 of each changed policy's qual / with_check
-- is the current one, or its WITH CHECK already calls org_billing_suspended (this file ran);
-- M4 (20261018170000) is applied (md5(prosrc) of
-- accept_invitation = M4's body), because the member trigger is written for M4's
-- 'unassigned' invitations. Re-running this file is a no-op.
--
-- Not in this file (PR-2): outbox kinds (sync_org_subscription, notify_org_suspended, ...)
-- and their enqueue; the purchase routes; the webhook. The drain alerts on an unknown kind,
-- so nothing here enqueues one.
-- Rollback: supabase/tests/backlog-3853/rollback-3853-m1.sql (refuses while any brokerage
-- is suspended).

DO $pre$
DECLARE
  r record;
  v_md5 text;
  v_done boolean;
BEGIN
  FOR r IN SELECT * FROM (VALUES
    ('public.unlock_transaction(text)', 'de52ee2e8f3642c21aa0200e108a175d', 'b312f6863b2e761ced1dbbb80f0e690a'),
    ('public.finalize_submission(uuid,jsonb)', '1f6f8a171ea7a5d77359c2e234e00956', '6b2896ac6370f58b0a4d382118b0ee52'),
    ('public.can_review_submission(uuid)', '9e6fc264d9528110e4f7811c37eddaf9', 'd8f86fd1942035f8902f3761db93b08d')
  ) AS t(sig, old_md5, new_md5) LOOP
    SELECT md5(pg_get_functiondef(oid)) INTO v_md5 FROM pg_proc WHERE oid = to_regprocedure(r.sig);
    IF v_md5 IS NULL OR v_md5 NOT IN (r.old_md5, r.new_md5) THEN
      RAISE EXCEPTION '3853 M1 pre-check: % differs from the expected one (md5(pg_get_functiondef) %)', r.sig, v_md5;
    END IF;
  END LOOP;

  FOR r IN SELECT * FROM (VALUES
    ('public', 'transaction_submissions', 'agents_can_create_submissions',
       'd41d8cd98f00b204e9800998ecf8427e/253296e01fc1f03a599b960b6c9b7608'),
    ('public', 'transaction_submissions', 'transaction_submissions_update_public',
       '477b9ae4a28460dce1de4d6dc939cabc/eb7c88e7baaf22490caed9be79767e47'),
    ('public', 'submission_comments', 'users_can_create_comments',
       'd41d8cd98f00b204e9800998ecf8427e/2f869c09a8036be794805ad06d96b7aa'),
    ('storage', 'objects', 'Members can upload submission attachments',
       'd41d8cd98f00b204e9800998ecf8427e/d1d5a42648942a4cbaf9e6e28faa0c9b')
  ) AS t(sch, tbl, pol, old_md5) LOOP
    SELECT md5(coalesce(qual, '')) || '/' || md5(coalesce(with_check, '')),
           position('org_billing_suspended' in coalesce(with_check, '')) > 0
      INTO v_md5, v_done
      FROM pg_policies WHERE schemaname = r.sch AND tablename = r.tbl AND policyname = r.pol;
    IF v_md5 IS NULL OR (v_md5 <> r.old_md5 AND NOT v_done) THEN
      RAISE EXCEPTION '3853 M1 pre-check: policy % on %.% differs from the expected one (%)', r.pol, r.sch, r.tbl, v_md5;
    END IF;
  END LOOP;

  SELECT md5(prosrc) INTO v_md5 FROM pg_proc WHERE oid = to_regprocedure('public.accept_invitation(text,text)');
  IF v_md5 IS DISTINCT FROM '37ce05772d72d25439d5ef2bdd5a2d08' THEN
    RAISE EXCEPTION '3853 M1 pre-check: M4 (20261018170000) is not applied (accept_invitation md5(prosrc) %)', v_md5;
  END IF;
END $pre$;

-- =====================================================================================
-- 1. Tables (RLS on, no client grants; service_role only)
-- =====================================================================================

CREATE TABLE IF NOT EXISTS public.billing_settings (
  key        text PRIMARY KEY CONSTRAINT billing_settings_key_ck CHECK (key IN ('brokerage_billing_live')),
  enabled    boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid
);
ALTER TABLE public.billing_settings ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.billing_settings FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.billing_settings TO service_role;
INSERT INTO public.billing_settings (key, enabled) VALUES ('brokerage_billing_live', false)
ON CONFLICT (key) DO NOTHING;
COMMENT ON TABLE public.billing_settings IS
  'BACKLOG-3853: DB-side billing switches. brokerage_billing_live = false keeps every brokerage RPC refusing a live-mode deal.';

CREATE TABLE IF NOT EXISTS public.price_book_items (
  key        text PRIMARY KEY,
  label      text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.price_book_items ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.price_book_items FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.price_book_items TO service_role;

CREATE TABLE IF NOT EXISTS public.price_book_prices (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  item_key       text NOT NULL REFERENCES public.price_book_items(key),
  billing_interval text NOT NULL CONSTRAINT price_book_prices_interval_ck CHECK (billing_interval IN ('month', 'year', 'one_time')),
  amount_cents   integer CONSTRAINT price_book_prices_amount_ck CHECK (amount_cents IS NULL OR amount_cents >= 0),
  effective_from timestamptz NOT NULL DEFAULT now(),
  effective_to   timestamptz,
  created_by     uuid,
  reason         text,
  created_at     timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.price_book_prices ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.price_book_prices FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.price_book_prices TO service_role;

INSERT INTO public.price_book_items (key, label) VALUES ('brokerage_seat', 'Keepr Team seat')
ON CONFLICT (key) DO NOTHING;
INSERT INTO public.price_book_prices (item_key, billing_interval, amount_cents, reason)
SELECT 'brokerage_seat', 'month', 2499, 'BACKLOG-3853 list price'
WHERE NOT EXISTS (SELECT 1 FROM public.price_book_prices WHERE item_key = 'brokerage_seat' AND billing_interval = 'month');

CREATE TABLE IF NOT EXISTS public.org_deals (
  organization_id   uuid PRIMARY KEY REFERENCES public.organizations(id),
  stripe_mode       text NOT NULL CONSTRAINT org_deals_stripe_mode_ck CHECK (stripe_mode IN ('test', 'live')),
  plan_id           uuid REFERENCES public.plans(id),
  term              text NOT NULL DEFAULT 'month' CONSTRAINT org_deals_term_ck CHECK (term IN ('month', 'year')),
  seats             integer NOT NULL CONSTRAINT org_deals_seats_ck CHECK (seats > 0),
  start_date        date NOT NULL DEFAULT current_date,
  status            text NOT NULL DEFAULT 'active'
                    CONSTRAINT org_deals_status_ck CHECK (status IN ('draft', 'active', 'suspended', 'canceling', 'canceled')),
  account_manager_id uuid,
  billing_contact_name  text,
  billing_contact_email text,
  designated_broker_member_id uuid REFERENCES public.organization_members(id) ON DELETE SET NULL,
  suspended_at      timestamptz,
  suspended_by      uuid,
  suspended_reason  text CONSTRAINT org_deals_suspended_reason_ck CHECK (suspended_reason IN ('non_payment', 'other')),
  suspended_note    text,
  status_before_suspension text CONSTRAINT org_deals_status_before_ck CHECK (status_before_suspension IN ('active', 'canceling')),
  entitlement_prior jsonb NOT NULL DEFAULT '{}'::jsonb,
  version           integer NOT NULL DEFAULT 1,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  updated_by        uuid,
  CONSTRAINT org_deals_suspension_shape_ck CHECK ((status = 'suspended') = (suspended_reason IS NOT NULL))
);
ALTER TABLE public.org_deals ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.org_deals FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.org_deals TO service_role;
CREATE OR REPLACE TRIGGER guard_stripe_mode_is_test
  BEFORE INSERT OR UPDATE OF stripe_mode, organization_id ON public.org_deals
  FOR EACH ROW EXECUTE FUNCTION public._guard_stripe_mode_is_test();
COMMENT ON TABLE public.org_deals IS
  'BACKLOG-3853: one brokerage deal per organization. status = ''suspended'' is the single suspension state every gate reads (org_billing_suspended).';

CREATE TABLE IF NOT EXISTS public.org_deal_lines (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id   uuid NOT NULL REFERENCES public.org_deals(organization_id) ON DELETE CASCADE,
  item_key          text NOT NULL REFERENCES public.price_book_items(key),
  quantity_rule     text NOT NULL CONSTRAINT org_deal_lines_qty_ck CHECK (quantity_rule IN ('seats', 'one')),
  unit_price_cents  integer NOT NULL CONSTRAINT org_deal_lines_price_ck CHECK (unit_price_cents >= 0),
  list_price_cents_at_save integer,
  pct_off           numeric GENERATED ALWAYS AS (
                      CASE WHEN list_price_cents_at_save > 0
                           THEN round(100.0 * (list_price_cents_at_save - unit_price_cents) / list_price_cents_at_save, 2) END) STORED,
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT org_deal_lines_org_item_key UNIQUE (organization_id, item_key)
);
ALTER TABLE public.org_deal_lines ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.org_deal_lines FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.org_deal_lines TO service_role;

CREATE TABLE IF NOT EXISTS public.org_billing_stripe (
  organization_id       uuid NOT NULL REFERENCES public.organizations(id),
  stripe_mode           text NOT NULL CONSTRAINT org_billing_stripe_mode_ck CHECK (stripe_mode IN ('test', 'live')),
  stripe_customer_id    text CONSTRAINT org_billing_stripe_customer_key UNIQUE,
  stripe_subscription_id text CONSTRAINT org_billing_stripe_subscription_key UNIQUE,
  status                text CONSTRAINT org_billing_stripe_status_ck CHECK (status IN
                          ('active', 'past_due', 'unpaid', 'canceled', 'incomplete', 'incomplete_expired', 'trialing', 'paused')),
  current_period_end    timestamptz,
  cancel_at_period_end  boolean NOT NULL DEFAULT false,
  collection_method     text,
  last_event_created    bigint,
  updated_at            timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, stripe_mode)
);
ALTER TABLE public.org_billing_stripe ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.org_billing_stripe FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.org_billing_stripe TO service_role;
CREATE OR REPLACE TRIGGER guard_stripe_mode_is_test
  BEFORE INSERT OR UPDATE OF stripe_mode, organization_id ON public.org_billing_stripe
  FOR EACH ROW EXECUTE FUNCTION public._guard_stripe_mode_is_test();
COMMENT ON COLUMN public.org_billing_stripe.status IS
  'BACKLOG-3853: Stripe subscription status mirror. past_due = the overdue state the 3855 banner reads; it never suspends by itself.';

CREATE TABLE IF NOT EXISTS public.billing_change_log (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  actor_id        uuid,
  action          text NOT NULL,
  detail          jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at      timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.billing_change_log ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.billing_change_log FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT ON public.billing_change_log TO service_role;
CREATE INDEX IF NOT EXISTS billing_change_log_org_idx ON public.billing_change_log (organization_id, created_at);

-- =====================================================================================
-- 2. Admin permission keys + role grants (B12), feature key for the desktop signal
-- =====================================================================================

INSERT INTO public.admin_permissions (key, label, description, category) VALUES
  ('billing.view', 'View billing', 'See brokerage deals, invoices and billing status', 'billing'),
  ('billing.manage', 'Manage billing', 'Save brokerage deals and seats', 'billing'),
  ('billing.approve', 'Approve discounts', 'Approve a deal price below the Sales cap', 'billing'),
  ('billing.pricebook', 'Edit price book', 'Change list prices', 'billing'),
  ('billing.suspend', 'Suspend brokerages', 'Suspend and reinstate a brokerage account', 'billing')
ON CONFLICT (key) DO NOTHING;

INSERT INTO public.admin_role_permissions (role_id, permission_id)
SELECT r.id, p.id
  FROM public.admin_roles r
  JOIN public.admin_permissions p ON
       (r.slug = 'super-admin' AND p.key IN ('billing.view', 'billing.manage', 'billing.approve', 'billing.pricebook', 'billing.suspend'))
    OR (r.slug = 'sales' AND p.key IN ('billing.view', 'billing.manage', 'billing.suspend'))
    OR (r.slug = 'executive' AND p.key = 'billing.view')
ON CONFLICT (role_id, permission_id) DO NOTHING;

INSERT INTO public.feature_definitions (key, name, description, value_type, default_value, category, sort_order, min_tier, is_built)
VALUES ('account_suspended', 'Account suspended',
        'The brokerage account is suspended for billing (BACKLOG-3853). Written by _billing_apply_org_entitlement only; the desktop reads it to explain refusals.',
        'boolean', 'false', 'access', 131, NULL, true)
ON CONFLICT (key) DO NOTHING;

-- =====================================================================================
-- 3. The predicate and the deciding-organization rule
-- =====================================================================================

CREATE OR REPLACE FUNCTION public.org_billing_suspended(p_org uuid)
RETURNS boolean
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO ''
AS $function$
  SELECT EXISTS (
    SELECT 1 FROM public.org_deals d
     WHERE d.organization_id = p_org AND d.status = 'suspended'
  );
$function$;
REVOKE EXECUTE ON FUNCTION public.org_billing_suspended(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.org_billing_suspended(uuid) TO authenticated, service_role;
COMMENT ON FUNCTION public.org_billing_suspended(uuid) IS
  'BACKLOG-3853: the only suspension predicate. Executable by authenticated because RLS policies call it; it discloses suspended yes/no for an organization id.';

-- Same rule as the desktop chooser and issue-offline-pass (chooseMembership): the caller''s
-- active memberships ordered by created_at, id; the first non-personal one, else the first.
CREATE OR REPLACE FUNCTION public.billing_deciding_org(p_user uuid)
RETURNS uuid
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO ''
AS $function$
  SELECT m.organization_id
    FROM public.organization_members m
    JOIN public.organizations o ON o.id = m.organization_id
   WHERE m.user_id = p_user AND m.license_status = 'active'
   ORDER BY (o.personal_owner_user_id IS NOT NULL), m.created_at, m.id
   LIMIT 1;
$function$;
REVOKE EXECUTE ON FUNCTION public.billing_deciding_org(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.billing_deciding_org(uuid) TO service_role;

-- Purchase refusal for the $14.99 routes (PR-2 calls it with the service role).
CREATE OR REPLACE FUNCTION public.billing_purchase_blocked(p_user uuid)
RETURNS boolean
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO ''
AS $function$
  SELECT coalesce(public.org_billing_suspended(public.billing_deciding_org(p_user)), false);
$function$;
REVOKE EXECUTE ON FUNCTION public.billing_purchase_blocked(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.billing_purchase_blocked(uuid) TO service_role;

CREATE OR REPLACE FUNCTION public._billing_brokerage_live()
RETURNS boolean
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO ''
AS $function$
  SELECT coalesce((SELECT s.enabled FROM public.billing_settings s WHERE s.key = 'brokerage_billing_live'), false);
$function$;
REVOKE EXECUTE ON FUNCTION public._billing_brokerage_live() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public._billing_brokerage_live() TO service_role;

-- =====================================================================================
-- 4. The single writer of billing-owned feature overrides (SR R2)
-- =====================================================================================
-- Keys: unlimited_transactions, broker_submission, broker_portal_access, account_suspended.
--   active | canceling -> unlimited_transactions {enabled:true}
--   suspended          -> unlimited_transactions, broker_submission, broker_portal_access
--                         {enabled:false}; account_suspended {enabled:true}
--   otherwise / no key wanted -> the prior (support / manual) override is restored, else the
--                         key is removed and the plan value applies.
-- A non-billing override present when billing first takes a key is kept in
-- org_deals.entitlement_prior. No org_deals row -> no-op.
CREATE OR REPLACE FUNCTION public._billing_apply_org_entitlement(p_org uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
  v_deal public.org_deals%ROWTYPE;
  v_prior jsonb;
  v_fo jsonb;
  v_key text;
  v_cur jsonb;
  v_want jsonb;
  v_src constant text := 'brokerage_billing';
BEGIN
  SELECT * INTO v_deal FROM public.org_deals WHERE organization_id = p_org FOR UPDATE;
  IF NOT FOUND THEN
    RETURN;
  END IF;
  SELECT coalesce(op.feature_overrides, '{}'::jsonb) INTO v_fo
    FROM public.organization_plans op WHERE op.organization_id = p_org FOR UPDATE;
  IF NOT FOUND THEN
    RETURN;
  END IF;
  v_prior := coalesce(v_deal.entitlement_prior, '{}'::jsonb);

  FOREACH v_key IN ARRAY ARRAY['unlimited_transactions', 'broker_submission', 'broker_portal_access', 'account_suspended'] LOOP
    v_cur := v_fo -> v_key;
    IF v_cur IS NOT NULL AND coalesce(v_cur ->> 'source', '') <> v_src AND NOT (v_prior ? v_key) THEN
      v_prior := v_prior || jsonb_build_object(v_key, v_cur);
    END IF;

    v_want := CASE
      WHEN v_deal.status = 'suspended' AND v_key = 'account_suspended'
        THEN jsonb_build_object('enabled', true, 'source', v_src)
      WHEN v_deal.status = 'suspended'
        THEN jsonb_build_object('enabled', false, 'source', v_src)
      WHEN v_deal.status IN ('active', 'canceling') AND v_key = 'unlimited_transactions'
        THEN jsonb_build_object('enabled', true, 'source', v_src)
      ELSE NULL
    END;

    IF v_want IS NOT NULL THEN
      v_fo := v_fo || jsonb_build_object(v_key, v_want);
    ELSIF v_prior ? v_key THEN
      v_fo := v_fo || jsonb_build_object(v_key, v_prior -> v_key);
      v_prior := v_prior - v_key;
    ELSE
      v_fo := v_fo - v_key;
    END IF;
  END LOOP;

  UPDATE public.organization_plans SET feature_overrides = v_fo, updated_at = now()
   WHERE organization_id = p_org AND feature_overrides IS DISTINCT FROM v_fo;
  UPDATE public.org_deals SET entitlement_prior = v_prior
   WHERE organization_id = p_org AND entitlement_prior IS DISTINCT FROM v_prior;
END
$function$;
REVOKE EXECUTE ON FUNCTION public._billing_apply_org_entitlement(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public._billing_apply_org_entitlement(uuid) TO service_role;

-- =====================================================================================
-- 5. Deal, suspension and seat entry points
-- =====================================================================================

-- Save a deal (service role; 3852's admin_save_deal wraps it in PR-2A).
-- p_deal: {stripe_mode, seats, unit_price_cents?, billing_contact_name?, billing_contact_email?,
--          account_manager_id?, designated_broker_member_id?}
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
REVOKE EXECUTE ON FUNCTION public._billing_save_deal(uuid, jsonb, uuid, text, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public._billing_save_deal(uuid, jsonb, uuid, text, integer) TO service_role;

-- Suspend (shared by the admin RPC; service role only).
CREATE OR REPLACE FUNCTION public._billing_suspend_org(p_org uuid, p_reason text, p_note text, p_actor uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
  v_deal public.org_deals%ROWTYPE;
BEGIN
  IF p_reason IS NULL OR p_reason NOT IN ('non_payment', 'other') THEN
    RETURN jsonb_build_object('success', false, 'error', 'invalid_reason');
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('billing_org:' || p_org::text, 0));
  SELECT * INTO v_deal FROM public.org_deals WHERE organization_id = p_org FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'no_deal');
  END IF;
  IF v_deal.stripe_mode = 'live' AND NOT public._billing_brokerage_live() THEN
    RETURN jsonb_build_object('success', false, 'error', 'billing_not_live');
  END IF;
  IF v_deal.status NOT IN ('active', 'canceling') THEN
    RETURN jsonb_build_object('success', false, 'error', 'deal_not_active', 'status', v_deal.status);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.organization_plans op WHERE op.organization_id = p_org) THEN
    RETURN jsonb_build_object('success', false, 'error', 'no_plan');
  END IF;

  UPDATE public.org_deals SET
    status_before_suspension = status,
    status = 'suspended',
    suspended_reason = p_reason,
    suspended_note = p_note,
    suspended_at = now(),
    suspended_by = p_actor,
    updated_at = now(),
    updated_by = p_actor
  WHERE organization_id = p_org;

  PERFORM public._billing_apply_org_entitlement(p_org);

  INSERT INTO public.billing_change_log (organization_id, actor_id, action, detail)
  VALUES (p_org, p_actor, 'suspended', jsonb_build_object('reason', p_reason, 'note', p_note));
  RETURN jsonb_build_object('success', true);
END
$function$;
REVOKE EXECUTE ON FUNCTION public._billing_suspend_org(uuid, text, text, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public._billing_suspend_org(uuid, text, text, uuid) TO service_role;

-- Reinstate (admin RPC, or system after payment via _billing_auto_reinstate).
CREATE OR REPLACE FUNCTION public._billing_reinstate_org(p_org uuid, p_note text, p_actor uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
  v_deal public.org_deals%ROWTYPE;
BEGIN
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
  VALUES (p_org, p_actor, 'reinstated', jsonb_build_object('note', p_note, 'was_reason', v_deal.suspended_reason));
  RETURN jsonb_build_object('success', true);
END
$function$;
REVOKE EXECUTE ON FUNCTION public._billing_reinstate_org(uuid, text, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public._billing_reinstate_org(uuid, text, uuid) TO service_role;

-- Auto-reinstate after payment (Q2 a, SR R8): only a 'non_payment' suspension, and only when
-- the mirrored Stripe subscription is active again. The webhook (PR-2) also checks that no
-- open invoice is past due before calling. actor = NULL (system).
CREATE OR REPLACE FUNCTION public._billing_auto_reinstate(p_org uuid, p_mode text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
  v_reason text;
  v_status text;
BEGIN
  SELECT d.suspended_reason INTO v_reason FROM public.org_deals d
   WHERE d.organization_id = p_org AND d.status = 'suspended' AND d.stripe_mode = p_mode;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'not_suspended');
  END IF;
  IF v_reason IS DISTINCT FROM 'non_payment' THEN
    RETURN jsonb_build_object('success', false, 'error', 'reason_not_non_payment');
  END IF;
  SELECT s.status INTO v_status FROM public.org_billing_stripe s
   WHERE s.organization_id = p_org AND s.stripe_mode = p_mode;
  IF v_status IS DISTINCT FROM 'active' THEN
    RETURN jsonb_build_object('success', false, 'error', 'subscription_not_active', 'status', v_status);
  END IF;
  RETURN public._billing_reinstate_org(p_org, 'auto: paid', NULL);
END
$function$;
REVOKE EXECUTE ON FUNCTION public._billing_auto_reinstate(uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public._billing_auto_reinstate(uuid, text) TO service_role;

-- Webhook mirror of the subscription (PR-2 calls it). Out-of-order events are ignored by
-- last_event_created. past_due never suspends.
CREATE OR REPLACE FUNCTION public._billing_apply_org_subscription(
  p_org uuid, p_mode text, p_fields jsonb, p_event_created bigint)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
  v_rows integer;
BEGIN
  INSERT INTO public.org_billing_stripe AS s (organization_id, stripe_mode, stripe_customer_id, stripe_subscription_id,
    status, current_period_end, cancel_at_period_end, collection_method, last_event_created, updated_at)
  VALUES (p_org, p_mode, p_fields ->> 'stripe_customer_id', p_fields ->> 'stripe_subscription_id',
    p_fields ->> 'status', nullif(p_fields ->> 'current_period_end', '')::timestamptz,
    coalesce((p_fields ->> 'cancel_at_period_end')::boolean, false), p_fields ->> 'collection_method',
    p_event_created, now())
  ON CONFLICT (organization_id, stripe_mode) DO UPDATE SET
    stripe_customer_id = coalesce(EXCLUDED.stripe_customer_id, s.stripe_customer_id),
    stripe_subscription_id = coalesce(EXCLUDED.stripe_subscription_id, s.stripe_subscription_id),
    status = coalesce(EXCLUDED.status, s.status),
    current_period_end = coalesce(EXCLUDED.current_period_end, s.current_period_end),
    cancel_at_period_end = EXCLUDED.cancel_at_period_end,
    collection_method = coalesce(EXCLUDED.collection_method, s.collection_method),
    last_event_created = EXCLUDED.last_event_created,
    updated_at = now()
  WHERE s.last_event_created IS NULL OR EXCLUDED.last_event_created IS NULL
     OR EXCLUDED.last_event_created >= s.last_event_created;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  RETURN jsonb_build_object('success', true, 'applied', v_rows = 1);
END
$function$;
REVOKE EXECUTE ON FUNCTION public._billing_apply_org_subscription(uuid, text, jsonb, bigint) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public._billing_apply_org_subscription(uuid, text, jsonb, bigint) TO service_role;

-- Seat change entry point for 3854 (signature fixed here). Refused while suspended.
CREATE OR REPLACE FUNCTION public._billing_change_seats(p_org uuid, p_seats integer, p_actor uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
  v_deal public.org_deals%ROWTYPE;
  v_holders integer;
  v_version integer;
BEGIN
  IF p_seats IS NULL OR p_seats < 1 THEN
    RETURN jsonb_build_object('success', false, 'error', 'invalid_seats');
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('billing_org:' || p_org::text, 0));
  SELECT * INTO v_deal FROM public.org_deals WHERE organization_id = p_org FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'no_deal');
  END IF;
  IF v_deal.status = 'suspended' THEN
    RETURN jsonb_build_object('success', false, 'error', 'account_suspended');
  END IF;
  IF v_deal.stripe_mode = 'live' AND NOT public._billing_brokerage_live() THEN
    RETURN jsonb_build_object('success', false, 'error', 'billing_not_live');
  END IF;
  IF v_deal.status NOT IN ('active', 'canceling') THEN
    RETURN jsonb_build_object('success', false, 'error', 'deal_not_active', 'status', v_deal.status);
  END IF;
  SELECT count(*) INTO v_holders FROM public.organization_members m
   WHERE m.organization_id = p_org
     AND public.member_row_holds_seat(m.license_status, m.invitation_expires_at, m.user_id);
  IF p_seats < v_holders THEN
    RETURN jsonb_build_object('success', false, 'error', 'seats_below_assigned', 'assigned', v_holders);
  END IF;
  UPDATE public.org_deals SET seats = p_seats, version = version + 1, updated_at = now(), updated_by = p_actor
   WHERE organization_id = p_org RETURNING version INTO v_version;
  UPDATE public.organizations SET max_seats = p_seats WHERE id = p_org AND max_seats IS DISTINCT FROM p_seats;
  INSERT INTO public.billing_change_log (organization_id, actor_id, action, detail)
  VALUES (p_org, p_actor, 'seats_changed', jsonb_build_object('from', v_deal.seats, 'to', p_seats, 'version', v_version));
  RETURN jsonb_build_object('success', true, 'version', v_version);
END
$function$;
REVOKE EXECUTE ON FUNCTION public._billing_change_seats(uuid, integer, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public._billing_change_seats(uuid, integer, uuid) TO service_role;

-- Admin portal RPCs (billing.suspend). Business refusals come back as {success:false, error}.
CREATE OR REPLACE FUNCTION public.admin_suspend_org(p_org uuid, p_reason text, p_note text)
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
  RETURN public._billing_suspend_org(p_org, p_reason, p_note, v_uid);
END
$function$;
REVOKE EXECUTE ON FUNCTION public.admin_suspend_org(uuid, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_suspend_org(uuid, text, text) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.admin_reinstate_org(p_org uuid, p_note text)
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
  RETURN public._billing_reinstate_org(p_org, p_note, v_uid);
END
$function$;
REVOKE EXECUTE ON FUNCTION public.admin_reinstate_org(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_reinstate_org(uuid, text) TO authenticated, service_role;

-- =====================================================================================
-- 6. G5: organization_members trigger (every writer, service role included)
-- =====================================================================================
-- Named with a leading underscore so it fires before guard_invite_acceptance and
-- seat_limit_enforce (BEFORE triggers fire in name order): the suspension error wins.
CREATE OR REPLACE FUNCTION public._billing_guard_member_while_suspended()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.org_deals d
                  WHERE d.organization_id = NEW.organization_id AND d.status = 'suspended') THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'INSERT'
     OR (TG_OP = 'UPDATE' AND NEW.organization_id IS DISTINCT FROM OLD.organization_id)
     OR (NEW.license_status IS DISTINCT FROM OLD.license_status
         AND NEW.license_status IN ('active', 'unassigned', 'pending'))
     OR (OLD.user_id IS NULL AND NEW.user_id IS NOT NULL)
     OR (OLD.user_id IS NULL AND NEW.license_status IN ('pending', 'unassigned')
         AND (NEW.invitation_token IS DISTINCT FROM OLD.invitation_token
              OR NEW.invitation_expires_at IS DISTINCT FROM OLD.invitation_expires_at)) THEN
    RAISE EXCEPTION 'account_suspended'
      USING ERRCODE = 'P0001', HINT = 'This brokerage account is suspended. Contact Keepr to restore it.';
  END IF;
  RETURN NEW;
END
$function$;
REVOKE EXECUTE ON FUNCTION public._billing_guard_member_while_suspended() FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE TRIGGER _billing_guard_member_while_suspended
  BEFORE INSERT OR UPDATE OF license_status, user_id, organization_id, invitation_token, invitation_expires_at
  ON public.organization_members
  FOR EACH ROW EXECUTE FUNCTION public._billing_guard_member_while_suspended();

-- =====================================================================================
-- 7. Replaced functions (CREATE OR REPLACE, same signatures; grants kept)
-- =====================================================================================

-- G1: a credit unlock is refused while the caller's deciding organization is suspended.
-- The refusal sits after the advisory lock and before any ledger write, so no credit is spent.
CREATE OR REPLACE FUNCTION public.unlock_transaction(p_local_transaction_id text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_uid            uuid := auth.uid();
  v_existing       public.transaction_unlocks;
  v_unlock_id      uuid;
  v_grant_remaining   integer;
  v_purchase_remaining integer;
  v_funded_by      uuid;
  v_funding_source text;
  v_debit_id       uuid;
  v_price_cents    integer;
  v_tier_id        uuid;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(v_uid::text, 0));

  -- BACKLOG-3853: no unlock while the deciding brokerage is suspended.
  IF public.org_billing_suspended(public.billing_deciding_org(v_uid)) THEN
    RAISE EXCEPTION 'account_suspended'
      USING ERRCODE = 'P0001', HINT = 'This brokerage account is suspended. Contact your broker.';
  END IF;

  SELECT * INTO v_existing
  FROM public.transaction_unlocks
  WHERE user_id = v_uid AND local_transaction_id = p_local_transaction_id;

  IF FOUND THEN
    RETURN jsonb_build_object(
      'unlocked', false,
      'already', true,
      'ledger_entry_id', v_existing.ledger_entry_id,
      'funding_source', v_existing.funding_source,
      'counts_toward_tier', v_existing.counts_toward_tier,
      'balance_after', public.get_credit_balance(v_uid)
    );
  END IF;

  -- CR1: grant net-capacity includes ALL adjustment rows (negatives reduce it), clamped at 0.
  WITH src AS (
    SELECT
      COALESCE(SUM(l.amount) FILTER (WHERE l.entry_type = 'adjustment'), 0) AS adj_sum,
      COALESCE(SUM(l.amount) FILTER (WHERE l.entry_type = 'purchase'), 0)   AS pur_sum
    FROM public.credit_ledger l
    WHERE l.user_id = v_uid
  ),
  drawn AS (
    SELECT
      count(*) FILTER (WHERE f.entry_type = 'adjustment') AS adj_debits,
      count(*) FILTER (WHERE f.entry_type = 'purchase')   AS pur_debits
    FROM public.credit_ledger d
    JOIN public.credit_ledger f ON f.id = d.funded_by
    WHERE d.user_id = v_uid AND d.entry_type = 'debit'
  )
  SELECT GREATEST(src.adj_sum - drawn.adj_debits, 0),
         (src.pur_sum - drawn.pur_debits)
  INTO v_grant_remaining, v_purchase_remaining
  FROM src, drawn;

  IF v_grant_remaining > 0 THEN
    SELECT l.id INTO v_funded_by
    FROM public.credit_ledger l
    WHERE l.user_id = v_uid AND l.entry_type = 'adjustment' AND l.amount > 0
      AND l.amount > (
        SELECT count(*) FROM public.credit_ledger d
        WHERE d.user_id = v_uid AND d.entry_type = 'debit' AND d.funded_by = l.id
      )
    ORDER BY l.created_at ASC
    LIMIT 1;
    v_funding_source := 'grant';
  ELSIF v_purchase_remaining > 0 THEN
    SELECT l.id INTO v_funded_by
    FROM public.credit_ledger l
    WHERE l.user_id = v_uid AND l.entry_type = 'purchase'
      AND l.amount > (
        SELECT count(*) FROM public.credit_ledger d
        WHERE d.user_id = v_uid AND d.entry_type = 'debit' AND d.funded_by = l.id
      )
    ORDER BY l.created_at ASC
    LIMIT 1;
    v_funding_source := 'purchase';
  ELSE
    RAISE EXCEPTION 'Insufficient credits';
  END IF;

  IF v_funded_by IS NULL THEN
    RAISE EXCEPTION 'Insufficient credits';
  END IF;

  IF v_funding_source = 'purchase' THEN
    SELECT q.unit_price_cents, q.pricing_tier_id INTO v_price_cents, v_tier_id
    FROM public.get_next_unlock_quote(v_uid) q;
  END IF;

  INSERT INTO public.credit_ledger
    (user_id, entry_type, amount, unit_price_cents, pricing_tier_id, funded_by, funding_source, created_by)
  VALUES
    (v_uid, 'debit', -1, v_price_cents, v_tier_id, v_funded_by, v_funding_source, v_uid)
  RETURNING id INTO v_debit_id;

  INSERT INTO public.transaction_unlocks
    (user_id, local_transaction_id, ledger_entry_id, funding_source, counts_toward_tier)
  VALUES
    (v_uid, p_local_transaction_id, v_debit_id, v_funding_source, (v_funding_source = 'purchase'))
  RETURNING id INTO v_unlock_id;

  IF public.get_credit_balance(v_uid) < 0 THEN
    RAISE EXCEPTION 'Insufficient credits';
  END IF;

  RETURN jsonb_build_object(
    'unlocked', true,
    'already', false,
    'ledger_entry_id', v_debit_id,
    'funding_source', v_funding_source,
    'counts_toward_tier', (v_funding_source = 'purchase'),
    'balance_after', public.get_credit_balance(v_uid)
  );
END;
$function$;

-- G2: finalize refuses while the submission's organization is suspended.
CREATE OR REPLACE FUNCTION public.finalize_submission(p_submission_id uuid, p_manifest jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_sub public.transaction_submissions%ROWTYPE;
  v_target text;
  v_msgs uuid[];
  v_att jsonb := coalesce(p_manifest->'attachments', '[]'::jsonb);
  v_att_ids int;
  v_prefix text;
  v_msg_missing int; v_msg_extra int;
  v_att_missing int; v_att_extra int; v_obj_missing int; v_outside int; v_link_bad int;
  v_cl_expected int := nullif(p_manifest->>'checklists', '')::int;
  v_cl_found int := 0;
BEGIN
  IF v_uid IS NULL THEN RETURN jsonb_build_object('ok', false, 'code', 'not_authenticated'); END IF;
  SELECT * INTO v_sub FROM public.transaction_submissions WHERE id = p_submission_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'code', 'not_found'); END IF;
  IF v_sub.submitted_by <> v_uid THEN RETURN jsonb_build_object('ok', false, 'code', 'not_owner'); END IF;
  v_target := CASE WHEN v_sub.parent_submission_id IS NOT NULL THEN 'resubmitted' ELSE 'submitted' END;
  IF v_sub.status = v_target THEN RETURN jsonb_build_object('ok', true, 'already_final', true, 'status', v_target); END IF;
  -- BACKLOG-3853: no submission while the brokerage is suspended.
  IF public.org_billing_suspended(v_sub.organization_id) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'account_suspended');
  END IF;
  IF v_sub.status <> 'uploading' THEN RETURN jsonb_build_object('ok', false, 'code', 'not_uploading'); END IF;
  IF v_sub.abandoned_at IS NOT NULL THEN
    RETURN jsonb_build_object('ok', false, 'code', 'abandoned');
  END IF;

  SELECT coalesce(array_agg(DISTINCT x::uuid), '{}') INTO v_msgs
    FROM jsonb_array_elements_text(coalesce(p_manifest->'message_ids', '[]'::jsonb)) x;
  SELECT count(*) INTO v_msg_missing FROM unnest(v_msgs) d
   WHERE NOT EXISTS (SELECT 1 FROM public.submission_messages m WHERE m.id = d AND m.submission_id = p_submission_id);
  SELECT count(*) INTO v_msg_extra FROM public.submission_messages m
   WHERE m.submission_id = p_submission_id AND NOT (m.id = ANY(v_msgs));

  v_prefix := v_sub.organization_id::text || '/' || p_submission_id::text || '/';
  WITH d AS (
    SELECT (e->>'id')::uuid id, e->>'storage_path' path, nullif(e->>'message_id', '')::uuid message_id
      FROM jsonb_array_elements(v_att) e)
  SELECT count(*) FILTER (WHERE a.id IS NULL OR a.storage_path IS DISTINCT FROM d.path),
         count(*) FILTER (WHERE a.id IS NOT NULL AND (a.message_id IS DISTINCT FROM d.message_id
                                OR (d.message_id IS NOT NULL AND NOT (d.message_id = ANY(v_msgs))))),
         count(*) FILTER (WHERE d.path IS NULL OR left(d.path, length(v_prefix)) <> v_prefix),
         count(*) FILTER (WHERE NOT EXISTS (SELECT 1 FROM storage.objects o
                                WHERE o.bucket_id = 'submission-attachments' AND o.name = d.path)),
         count(DISTINCT d.id)
    INTO v_att_missing, v_link_bad, v_outside, v_obj_missing, v_att_ids
    FROM d LEFT JOIN public.submission_attachments a ON a.id = d.id AND a.submission_id = p_submission_id;
  SELECT count(*) INTO v_att_extra FROM public.submission_attachments a
   WHERE a.submission_id = p_submission_id
     AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_att) e WHERE (e->>'id')::uuid = a.id);

  IF v_cl_expected IS NOT NULL THEN
    SELECT count(*) INTO v_cl_found FROM public.submission_checklists c WHERE c.submission_id = p_submission_id;
  END IF;

  IF v_msg_missing + v_msg_extra + v_att_missing + v_att_extra + v_obj_missing + v_outside + v_link_bad > 0
     OR (v_cl_expected IS NOT NULL AND v_cl_found <> v_cl_expected) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'incomplete',
      'messages_missing', v_msg_missing, 'messages_extra', v_msg_extra,
      'attachment_rows_missing', v_att_missing, 'attachment_rows_extra', v_att_extra,
      'objects_missing', v_obj_missing, 'paths_outside_submission', v_outside,
      'attachment_message_links_wrong', v_link_bad,
      'checklists_expected', v_cl_expected, 'checklists_found', v_cl_found);
  END IF;

  UPDATE public.transaction_submissions
     SET status = v_target,
         message_count = cardinality(v_msgs),
         attachment_count = v_att_ids,
         submission_metadata = coalesce(submission_metadata, '{}'::jsonb)
                               || jsonb_build_object('finalized_by', 'finalize_submission')
   WHERE id = p_submission_id;

  INSERT INTO public.submission_attempts AS a
    (submission_id, user_id, organization_id, is_resubmit, outcome, stage, ended_at)
  VALUES
    (p_submission_id, v_uid, v_sub.organization_id, v_sub.parent_submission_id IS NOT NULL, 'committed', 'finalize', now())
  ON CONFLICT (submission_id) DO UPDATE
     SET outcome = 'committed', stage = 'finalize', reason_code = NULL, updated_at = now(), ended_at = now()
   WHERE a.user_id = v_uid;

  RETURN jsonb_build_object('ok', true, 'already_final', false, 'status', v_target);
END
$function$;

-- G3/G4: reviewers lose sight of (and every review action on) a suspended org's submissions.
CREATE OR REPLACE FUNCTION public.can_review_submission(p_org_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  SELECT EXISTS (
    SELECT 1
      FROM public.organization_members om
     WHERE om.organization_id = p_org_id
       AND om.user_id = (SELECT auth.uid())
       AND om.role IN ('broker', 'admin', 'it_admin')
       AND public.member_status_grants_access(om.license_status)
       AND NOT public.org_billing_suspended(p_org_id)
  );
$function$;

-- =====================================================================================
-- 8. Policies
-- =====================================================================================

-- G2: no new submission row while suspended (any status).
ALTER POLICY agents_can_create_submissions ON public.transaction_submissions
  WITH CHECK (
    (submitted_by = (SELECT auth.uid() AS uid))
    AND (organization_id IN (
      SELECT submitter.organization_id
        FROM (public.organization_members submitter
          JOIN public.organizations o ON ((o.id = submitter.organization_id)))
       WHERE ((submitter.user_id = (SELECT auth.uid() AS uid))
         AND (o.personal_owner_user_id IS NULL)
         AND public.member_status_grants_access((submitter.license_status)::text))))
    AND ((status)::text = ANY ((ARRAY['uploading'::character varying, 'submitted'::character varying])::text[]))
    AND (reviewed_by IS NULL) AND (reviewed_at IS NULL) AND (review_notes IS NULL)
    AND (NOT public.org_billing_suspended(organization_id))
  );

-- G2 + G3 (SR R11): the submitter branch may not leave 'uploading' while suspended; the
-- reviewer branch is refused while suspended, in USING and WITH CHECK, with no carve-out
-- for a reviewer who is also the submitter.
ALTER POLICY transaction_submissions_update_public ON public.transaction_submissions
  USING (
    ((submitted_by = (SELECT auth.uid() AS uid)) AND ((status)::text = 'uploading'::text) AND (abandoned_at IS NULL))
    OR (((status)::text = ANY ((ARRAY['submitted'::character varying, 'resubmitted'::character varying, 'under_review'::character varying])::text[]))
        AND (organization_id IN (
          SELECT reviewer_using.organization_id
            FROM public.organization_members reviewer_using
           WHERE ((reviewer_using.user_id = (SELECT auth.uid() AS uid))
             AND ((reviewer_using.role)::text = ANY ((ARRAY['broker'::character varying, 'admin'::character varying])::text[]))
             AND public.member_status_grants_access((reviewer_using.license_status)::text))))
        AND (NOT public.org_billing_suspended(organization_id)))
  )
  WITH CHECK (
    ((submitted_by = (SELECT auth.uid() AS uid))
      AND ((status)::text = ANY ((ARRAY['resubmitted'::character varying, 'uploading'::character varying, 'submitted'::character varying])::text[]))
      AND (((status)::text = 'uploading'::text) OR (NOT public.org_billing_suspended(organization_id))))
    OR (((status)::text <> 'uploading'::text)
        AND (organization_id IN (
          SELECT reviewer_check.organization_id
            FROM public.organization_members reviewer_check
           WHERE ((reviewer_check.user_id = (SELECT auth.uid() AS uid))
             AND ((reviewer_check.role)::text = ANY ((ARRAY['broker'::character varying, 'admin'::character varying])::text[]))
             AND public.member_status_grants_access((reviewer_check.license_status)::text))))
        AND (NOT public.org_billing_suspended(organization_id)))
  );

-- Q7 = a (read-only): nobody writes a comment on a suspended org's submission.
ALTER POLICY users_can_create_comments ON public.submission_comments
  WITH CHECK (
    (user_id = (SELECT auth.uid() AS uid))
    AND (submission_id IN (
      SELECT transaction_submissions.id
        FROM public.transaction_submissions
       WHERE (((transaction_submissions.submitted_by = (SELECT auth.uid() AS uid))
           OR (transaction_submissions.organization_id IN (
             SELECT commenter.organization_id
               FROM public.organization_members commenter
              WHERE ((commenter.user_id = (SELECT auth.uid() AS uid))
                AND ((commenter.role)::text = ANY ((ARRAY['broker'::character varying, 'admin'::character varying])::text[]))
                AND public.member_status_grants_access((commenter.license_status)::text)))))
         AND (NOT public.org_billing_suspended(transaction_submissions.organization_id)))))
  );

-- G2: no attachment upload into a suspended org's folder.
ALTER POLICY "Members can upload submission attachments" ON storage.objects
  WITH CHECK (
    (bucket_id = 'submission-attachments'::text)
    AND (split_part(name, '/'::text, 1) IN (
      SELECT (uploader.organization_id)::text AS organization_id
        FROM (public.organization_members uploader
          JOIN public.organizations o ON ((o.id = uploader.organization_id)))
       WHERE ((uploader.user_id = auth.uid())
         AND (o.personal_owner_user_id IS NULL)
         AND public.member_status_grants_access((uploader.license_status)::text)
         AND (NOT public.org_billing_suspended(uploader.organization_id)))))
  );
