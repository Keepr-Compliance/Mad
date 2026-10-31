-- BACKLOG-3860 PR-1: solo agent free trial, database layer. Ships SWITCHED OFF.
--
-- A new solo agent gets Unlimited for a staff-set number of days (default 14), no card.
-- The trial is an unlimited_transactions override with an end date:
--   {"enabled": true, "paid_through": <started_at + days>, "source": "trial"}
-- When paid_through passes, _override_effective ignores it and the plan answers again.
-- Nothing runs at the end of a trial.
--
-- Objects:
--  1. billing_settings: the key check is widened to allow 'solo_trial'; nullable integer
--     column "days"; check billing_settings_solo_trial_days_ck (for solo_trial, days is
--     not null and 1-90). Seed row solo_trial: enabled false, days 14.
--  2. solo_trials: one row per user who ever started a trial (user_id primary key).
--     Service role only. The row outlives the override, so nobody gets a second trial.
--  3. _start_solo_trial_for(uuid): service role only. Every eligibility rule lives here:
--     switch on, length 1-90, no ledger row, licence not suspended, no active brokerage
--     membership, personal organization with a plan row, no unlimited_transactions
--     override already present (a Stripe or support grant wins). Writes the ledger row
--     and the override together. The length is read once, at start.
--  4. ensure_personal_organization(): when the internal function answers 'created', calls
--     _start_solo_trial_for(auth.uid()) inside its own exception block. A trial failure is
--     a WARNING and never blocks the personal organization. The ensure result is returned
--     unchanged. This is the ONLY trigger of a trial: a later "Start free trial" button
--     replaces this one call and nothing else.
--  5. grant_unlimited_from_subscription: a Stripe grant replaces a trial override (live or
--     ended). It still refuses any other non-Stripe override (support grants, sourceless,
--     any other source).
--  6. admin_get_solo_trial_setting(): internal staff read. admin_set_solo_trial_setting
--     (boolean, integer): billing.pricebook only (super-admin); writes an audit row with the
--     old and new values. Changes apply to new trials only; running trials keep their end.
--
-- Pins: the two replaced function bodies (md5 of the production body read 2026-10-31, or
-- this file's own body on a second apply), the internal ensure function (not replaced; its
-- 'created' answer is what starts a trial) and the old key check definition. Any drift
-- stops the migration before anything changes.
--
-- SWITCH-ON CHECKLIST (production; PR-1 switches nothing on anywhere):
--   [ ] BACKLOG-4088 merged (desktop subscription route lets a trialing agent subscribe)
--   [ ] BACKLOG-2123 trial terms shown before sign-up, and the Store listing text
--   [ ] the desktop "Trial ends <date>" follow-up decided
--   [ ] founder go
-- Then staff turn it on in the admin Plans page (PR-3). No code change.
--
-- Rollback: supabase/tests/backlog-3860/rollback-3860.sql (read its header).
-- Harness: supabase/tests/backlog-3860/ (keepr-test, every run rolled back).
-- Apply as one transaction. No BEGIN/COMMIT here.

-- ---------------------------------------------------------------------------
-- 0. Preconditions and pins
-- ---------------------------------------------------------------------------
DO $pre$
DECLARE
  v_src text;
  v_def text;
BEGIN
  IF to_regclass('public.billing_settings') IS NULL THEN
    RAISE EXCEPTION 'BACKLOG-3860: public.billing_settings is missing (needs 20261018230000)';
  END IF;
  IF to_regprocedure('public.has_permission(uuid,text)') IS NULL
     OR to_regprocedure('public.has_internal_role(uuid)') IS NULL
     OR to_regprocedure('public.log_admin_action(text,text,text,jsonb,inet,text)') IS NULL
     OR to_regprocedure('public.member_status_is_deactivated(text)') IS NULL THEN
    RAISE EXCEPTION 'BACKLOG-3860: a helper function is missing (has_permission, has_internal_role, log_admin_action, member_status_is_deactivated)';
  END IF;

  -- Not replaced, but its 'created' answer starts a trial: production body of 2026-10-31.
  SELECT md5(p.prosrc) INTO v_src FROM pg_proc p
   WHERE p.oid = to_regprocedure('public._ensure_personal_organization_for(uuid)');
  IF v_src IS DISTINCT FROM '831f08148d71458c8aa66e106304d6af' THEN
    RAISE EXCEPTION 'BACKLOG-3860: _ensure_personal_organization_for body changed (md5 %); re-review before applying', coalesce(v_src, '<missing>');
  END IF;

  SELECT p.prosrc INTO v_src FROM pg_proc p
   WHERE p.oid = to_regprocedure('public.ensure_personal_organization()');
  IF v_src IS NULL OR (md5(v_src) <> '52a3b051fd7f1b464e929fecdc4a90f8' AND v_src NOT LIKE '%BACKLOG-3860%') THEN
    RAISE EXCEPTION 'BACKLOG-3860: ensure_personal_organization body changed (md5 %); re-review before applying', coalesce(md5(v_src), '<missing>');
  END IF;

  SELECT p.prosrc INTO v_src FROM pg_proc p
   WHERE p.oid = to_regprocedure('public.grant_unlimited_from_subscription(uuid,timestamptz,text)');
  IF v_src IS NULL OR (md5(v_src) <> '7a38ab6b47b2c66d85b0f920d74ee68a' AND v_src NOT LIKE '%BACKLOG-3860%') THEN
    RAISE EXCEPTION 'BACKLOG-3860: grant_unlimited_from_subscription body changed (md5 %); re-review before applying', coalesce(md5(v_src), '<missing>');
  END IF;

  SELECT pg_get_constraintdef(c.oid) INTO v_def FROM pg_constraint c
   WHERE c.conrelid = 'public.billing_settings'::regclass AND c.conname = 'billing_settings_key_ck';
  IF v_def IS DISTINCT FROM 'CHECK ((key = ''brokerage_billing_live''::text))'
     AND v_def IS DISTINCT FROM 'CHECK ((key = ANY (ARRAY[''brokerage_billing_live''::text, ''solo_trial''::text])))' THEN
    RAISE EXCEPTION 'BACKLOG-3860: billing_settings_key_ck differs from the expected definition: %', coalesce(v_def, '<missing>');
  END IF;
END
$pre$;

-- ---------------------------------------------------------------------------
-- 1. Setting: billing_settings key solo_trial (enabled = on/off, days = length)
-- ---------------------------------------------------------------------------
DO $settings$
BEGIN
  IF (SELECT pg_get_constraintdef(c.oid) FROM pg_constraint c
       WHERE c.conrelid = 'public.billing_settings'::regclass AND c.conname = 'billing_settings_key_ck')
     = 'CHECK ((key = ''brokerage_billing_live''::text))' THEN
    ALTER TABLE public.billing_settings DROP CONSTRAINT billing_settings_key_ck;
    ALTER TABLE public.billing_settings ADD CONSTRAINT billing_settings_key_ck
      CHECK (key IN ('brokerage_billing_live', 'solo_trial'));
  END IF;
END
$settings$;

ALTER TABLE public.billing_settings ADD COLUMN IF NOT EXISTS days integer;

DO $days$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint c
                  WHERE c.conrelid = 'public.billing_settings'::regclass
                    AND c.conname = 'billing_settings_solo_trial_days_ck') THEN
    -- "days IS NOT NULL" is required: a check whose result is unknown passes.
    ALTER TABLE public.billing_settings ADD CONSTRAINT billing_settings_solo_trial_days_ck
      CHECK (key <> 'solo_trial' OR (days IS NOT NULL AND days BETWEEN 1 AND 90));
  END IF;
END
$days$;

INSERT INTO public.billing_settings (key, enabled, days) VALUES ('solo_trial', false, 14)
ON CONFLICT (key) DO NOTHING;

COMMENT ON TABLE public.billing_settings IS
  'BACKLOG-3853/3860: DB-side billing switches. brokerage_billing_live = false keeps every brokerage RPC refusing a live-mode deal. solo_trial: enabled = new solo agents get a free trial; days = its length (new trials only).';

-- ---------------------------------------------------------------------------
-- 2. Ledger: one trial per user, ever
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.solo_trials (
  user_id         uuid PRIMARY KEY REFERENCES auth.users (id) ON DELETE CASCADE,
  organization_id uuid REFERENCES public.organizations (id) ON DELETE SET NULL,
  started_at      timestamptz NOT NULL,
  ends_at         timestamptz NOT NULL,
  length_days     integer NOT NULL CONSTRAINT solo_trials_length_ck CHECK (length_days BETWEEN 1 AND 90),
  CONSTRAINT solo_trials_ends_after_start_ck CHECK (ends_at > started_at)
);
ALTER TABLE public.solo_trials ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.solo_trials FROM PUBLIC, anon, authenticated;
REVOKE TRUNCATE ON public.solo_trials FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.solo_trials TO service_role;
COMMENT ON TABLE public.solo_trials IS
  'BACKLOG-3860: every user who started a solo free trial. Outlives the override, so a user never gets a second trial. Service role only.';

-- ---------------------------------------------------------------------------
-- 3. Start a trial (service role only; SECURITY INVOKER, so it runs with the
--    caller's rights: the definer wrapper below, or the service role)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public._start_solo_trial_for(p_user_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_enabled  boolean;
  v_days     integer;
  v_org_id   uuid;
  v_existing jsonb;
  v_started  timestamptz;
  v_ends     timestamptz;
BEGIN
  IF p_user_id IS NULL THEN
    RETURN jsonb_build_object('status', 'refused', 'reason', 'no_user');
  END IF;

  -- Same lock as the personal organization ensure / retirement for this user.
  PERFORM pg_advisory_xact_lock(hashtextextended(p_user_id::text, 3364));

  -- An absent row leaves both NULL: refused (switch check is null-safe).
  SELECT s.enabled, s.days INTO v_enabled, v_days
    FROM public.billing_settings s
   WHERE s.key = 'solo_trial';
  IF v_enabled IS NOT TRUE THEN
    RETURN jsonb_build_object('status', 'refused', 'reason', 'off');
  END IF;
  IF v_days IS NULL OR v_days < 1 OR v_days > 90 THEN
    RETURN jsonb_build_object('status', 'refused', 'reason', 'bad_length');
  END IF;

  -- One trial per user. The ledger primary key would also stop a second row;
  -- this check gives a clean answer instead of an error.
  IF EXISTS (SELECT 1 FROM public.solo_trials t WHERE t.user_id = p_user_id) THEN
    RETURN jsonb_build_object('status', 'refused', 'reason', 'already_used');
  END IF;

  IF EXISTS (SELECT 1 FROM public.licenses l WHERE l.user_id = p_user_id AND l.status = 'suspended') THEN
    RETURN jsonb_build_object('status', 'refused', 'reason', 'licence_suspended');
  END IF;

  IF EXISTS (
    SELECT 1
      FROM public.organization_members m
      JOIN public.organizations o ON o.id = m.organization_id
     WHERE m.user_id = p_user_id
       AND o.personal_owner_user_id IS NULL
       AND NOT public.member_status_is_deactivated(m.license_status)
  ) THEN
    RETURN jsonb_build_object('status', 'refused', 'reason', 'has_membership');
  END IF;

  SELECT o.id INTO v_org_id
    FROM public.organizations o
   WHERE o.personal_owner_user_id = p_user_id;
  IF v_org_id IS NULL THEN
    RETURN jsonb_build_object('status', 'refused', 'reason', 'no_personal_org');
  END IF;

  SELECT op.feature_overrides -> 'unlimited_transactions' INTO v_existing
    FROM public.organization_plans op
   WHERE op.organization_id = v_org_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('status', 'refused', 'reason', 'no_plan_row', 'organization_id', v_org_id);
  END IF;
  -- A Stripe or support grant is never replaced by a trial.
  IF v_existing IS NOT NULL THEN
    RETURN jsonb_build_object('status', 'refused', 'reason', 'override_present', 'organization_id', v_org_id);
  END IF;

  v_started := now();
  v_ends := v_started + make_interval(days => v_days);
  -- Second defence: an override without an end date would be a permanent Unlimited.
  IF v_ends IS NULL THEN
    RETURN jsonb_build_object('status', 'refused', 'reason', 'no_end_date');
  END IF;

  INSERT INTO public.solo_trials (user_id, organization_id, started_at, ends_at, length_days)
  VALUES (p_user_id, v_org_id, v_started, v_ends, v_days);

  UPDATE public.organization_plans op
     SET feature_overrides = COALESCE(op.feature_overrides, '{}'::jsonb)
           || jsonb_build_object('unlimited_transactions',
                jsonb_build_object('enabled', true,
                                   'paid_through', to_jsonb(v_ends),
                                   'source', 'trial'))
   WHERE op.organization_id = v_org_id;

  RETURN jsonb_build_object('status', 'started', 'organization_id', v_org_id,
                            'paid_through', to_jsonb(v_ends), 'length_days', v_days);
END
$fn$;
REVOKE EXECUTE ON FUNCTION public._start_solo_trial_for(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public._start_solo_trial_for(uuid) TO service_role;

-- ---------------------------------------------------------------------------
-- 4. The trigger: the signed-in wrapper starts a trial when it has just created
--    the personal organization. CREATE OR REPLACE keeps its grants.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.ensure_personal_organization()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_res jsonb;
BEGIN
  IF v_uid IS NULL THEN
    RETURN jsonb_build_object('status', 'not_authenticated');
  END IF;
  v_res := public._ensure_personal_organization_for(v_uid);
  -- BACKLOG-3860: free trial for a new solo agent. Own sub-transaction: a failure
  -- rolls back only the trial and never blocks the personal organization.
  IF v_res ->> 'status' = 'created' THEN
    BEGIN
      PERFORM public._start_solo_trial_for(v_uid);
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING 'ensure_personal_organization: solo trial not started for % (%: %)',
        v_uid, SQLSTATE, SQLERRM;
    END;
  END IF;
  RETURN v_res;
END;
$$;
REVOKE ALL ON FUNCTION public.ensure_personal_organization() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.ensure_personal_organization() FROM anon;
GRANT EXECUTE ON FUNCTION public.ensure_personal_organization() TO authenticated;

-- ---------------------------------------------------------------------------
-- 5. A Stripe grant replaces a trial override; every other non-Stripe override
--    (support grant, sourceless, any other source) still refuses.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.grant_unlimited_from_subscription(
  p_user_id uuid, p_paid_through timestamptz, p_mode text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_org_id   uuid;
  v_is_test  boolean;
  v_existing jsonb;
BEGIN
  IF p_mode IS NULL OR p_mode NOT IN ('test', 'live') THEN
    RAISE EXCEPTION 'grant_unlimited_from_subscription: invalid mode %', p_mode USING ERRCODE = '22023';
  END IF;
  IF p_user_id IS NULL THEN
    RAISE EXCEPTION 'grant_unlimited_from_subscription: user id required' USING ERRCODE = '22004';
  END IF;
  -- A NULL paid_through would be a permanent Unlimited.
  IF p_paid_through IS NULL THEN
    RAISE EXCEPTION 'grant_unlimited_from_subscription: paid_through required' USING ERRCODE = '22004';
  END IF;

  SELECT o.id, o.is_test INTO v_org_id, v_is_test
    FROM public.organizations o
   WHERE o.personal_owner_user_id = p_user_id;
  IF v_org_id IS NULL THEN
    RAISE EXCEPTION 'grant_unlimited_from_subscription: user has no personal organization' USING ERRCODE = '42501';
  END IF;
  IF p_mode = 'test' AND v_is_test IS NOT TRUE THEN
    RAISE EXCEPTION 'grant_unlimited_from_subscription: test mode requires an is_test personal organization' USING ERRCODE = '42501';
  END IF;
  IF p_mode = 'live' AND v_is_test IS NOT FALSE THEN
    RAISE EXCEPTION 'grant_unlimited_from_subscription: live mode refuses an is_test personal organization' USING ERRCODE = '42501';
  END IF;

  IF EXISTS (SELECT 1 FROM public.licenses l WHERE l.user_id = p_user_id AND l.status = 'suspended') THEN
    RETURN jsonb_build_object('status', 'refused', 'reason', 'licence_suspended', 'organization_id', v_org_id);
  END IF;

  SELECT op.feature_overrides -> 'unlimited_transactions' INTO v_existing
    FROM public.organization_plans op
   WHERE op.organization_id = v_org_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'grant_unlimited_from_subscription: personal organization has no plan row' USING ERRCODE = 'P0002';
  END IF;
  -- BACKLOG-3860: a trial override (live or ended) is replaced by the Stripe grant.
  -- Two clauses on purpose: a sourceless override gives NULL ->> 'source', which is
  -- distinct from both, so it stays refused.
  IF v_existing IS NOT NULL
     AND (v_existing ->> 'source') IS DISTINCT FROM 'stripe'
     AND (v_existing ->> 'source') IS DISTINCT FROM 'trial' THEN
    RETURN jsonb_build_object('status', 'refused', 'reason', 'non_stripe_override', 'organization_id', v_org_id);
  END IF;

  UPDATE public.organization_plans op
     SET feature_overrides = COALESCE(op.feature_overrides, '{}'::jsonb)
           || jsonb_build_object('unlimited_transactions',
                jsonb_build_object('enabled', true,
                                   'paid_through', to_jsonb(p_paid_through),
                                   'source', 'stripe'))
   WHERE op.organization_id = v_org_id;

  RETURN jsonb_build_object('status', 'granted', 'organization_id', v_org_id,
                            'paid_through', to_jsonb(p_paid_through));
END
$fn$;
REVOKE EXECUTE ON FUNCTION public.grant_unlimited_from_subscription(uuid, timestamptz, text) FROM PUBLIC, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 6. Admin read and write of the setting
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.admin_get_solo_trial_setting()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO ''
AS $fn$
DECLARE
  v_uid uuid := auth.uid();
  v_enabled boolean;
  v_days integer;
  v_updated_at timestamptz;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '42501';
  END IF;
  IF NOT coalesce(public.has_internal_role(v_uid), false) THEN
    RAISE EXCEPTION 'Not authorized' USING ERRCODE = '42501';
  END IF;
  SELECT s.enabled, s.days, s.updated_at INTO v_enabled, v_days, v_updated_at
    FROM public.billing_settings s
   WHERE s.key = 'solo_trial';
  -- An absent row reads as off.
  RETURN jsonb_build_object(
    'enabled', coalesce(v_enabled, false),
    'days', v_days,
    'updated_at', v_updated_at,
    'can_edit', coalesce(public.has_permission(v_uid, 'billing.pricebook'), false));
END
$fn$;
REVOKE EXECUTE ON FUNCTION public.admin_get_solo_trial_setting() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_get_solo_trial_setting() TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.admin_set_solo_trial_setting(p_enabled boolean, p_days integer)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $fn$
DECLARE
  v_uid uuid := auth.uid();
  v_old_enabled boolean;
  v_old_days integer;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '42501';
  END IF;
  IF NOT coalesce(public.has_permission(v_uid, 'billing.pricebook'), false) THEN
    RAISE EXCEPTION 'Not authorized' USING ERRCODE = '42501';
  END IF;
  IF p_enabled IS NULL THEN
    RAISE EXCEPTION 'admin_set_solo_trial_setting: enabled required' USING ERRCODE = '22004';
  END IF;
  IF p_days IS NULL OR p_days < 1 OR p_days > 90 THEN
    RAISE EXCEPTION 'admin_set_solo_trial_setting: days must be 1 to 90' USING ERRCODE = '22023';
  END IF;

  SELECT s.enabled, s.days INTO v_old_enabled, v_old_days
    FROM public.billing_settings s
   WHERE s.key = 'solo_trial'
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'admin_set_solo_trial_setting: solo_trial setting row is missing' USING ERRCODE = 'P0002';
  END IF;

  -- The setting only. Running trials keep the end date written when they started.
  UPDATE public.billing_settings s
     SET enabled = p_enabled, days = p_days, updated_at = now(), updated_by = v_uid
   WHERE s.key = 'solo_trial';

  PERFORM public.log_admin_action(
    'billing.solo_trial_updated',
    'billing_setting',
    'solo_trial',
    jsonb_build_object(
      'old', jsonb_build_object('enabled', v_old_enabled, 'days', v_old_days),
      'new', jsonb_build_object('enabled', p_enabled, 'days', p_days)));

  RETURN jsonb_build_object('enabled', p_enabled, 'days', p_days);
END
$fn$;
REVOKE EXECUTE ON FUNCTION public.admin_set_solo_trial_setting(boolean, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_set_solo_trial_setting(boolean, integer) TO authenticated, service_role;

COMMENT ON FUNCTION public._start_solo_trial_for(uuid) IS
  'BACKLOG-3860: start a solo free trial for a user (service role only). Every eligibility rule is here.';
COMMENT ON FUNCTION public.admin_get_solo_trial_setting() IS
  'BACKLOG-3860: the solo free trial setting for internal staff; can_edit = billing.pricebook.';
COMMENT ON FUNCTION public.admin_set_solo_trial_setting(boolean, integer) IS
  'BACKLOG-3860: change the solo free trial setting (billing.pricebook). New trials only. Audited.';
