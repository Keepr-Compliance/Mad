-- BACKLOG-3860 PR-1 rollback: supabase/migrations/20261031140000_backlog_3860_solo_trial.sql
--
-- Run as ONE transaction (the database owner; a migration runner or the SQL editor).
-- Order (plan v1.1 item 9, SR condition C5):
--   1. Switch the trial off by writing the settings row DIRECTLY (not through the admin
--      setter: a rollback has no signed-in user, so the setter would refuse).
--   2. Count personal plan rows whose unlimited_transactions override has source 'trial'.
--      Above zero: STOP and print the count. The old grant body refuses every non-Stripe
--      override, live or ended, so a leftover trial override would lock that user out of
--      subscribing. Removing those overrides is a separate explicit flag, used only on a
--      founder go:  SET LOCAL keepr.rollback_3860_remove_trial_overrides = 'yes';
--      (the flag keeps the ledger; the ledger is removed in step 6 anyway).
--   3. Restore ensure_personal_organization() (verbatim body of 20260915160637).
--   4. Restore grant_unlimited_from_subscription (verbatim body of 20261011230913).
--   5. Remove the admin get/set functions and _start_solo_trial_for.
--   6. Remove the solo_trials ledger. Harmless in the automatic variant: a re-applied
--      version starts a trial only on 'created'. (In a "Start free trial" button variant
--      the ledger is the only guard; do not roll back without keeping a copy.)
--   7. Remove the solo_trial settings row, the days check and column, then restore
--      billing_settings_key_ck to the pinned old definition (it would fail while a
--      solo_trial row exists, hence this order).
-- Every step checks its result; the final block compares the restored md5s and the
-- constraint text with the pre-3860 values and raises on any difference.

-- 1 + 2
DO $rb1$
DECLARE
  n integer;
BEGIN
  IF to_regclass('public.billing_settings') IS NOT NULL
     AND EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema = 'public' AND table_name = 'billing_settings' AND column_name = 'days') THEN
    UPDATE public.billing_settings SET enabled = false, updated_at = now() WHERE key = 'solo_trial';
  END IF;

  SELECT count(*) INTO n
    FROM public.organization_plans op
   WHERE op.feature_overrides -> 'unlimited_transactions' ->> 'source' = 'trial';
  IF n > 0 THEN
    IF coalesce(current_setting('keepr.rollback_3860_remove_trial_overrides', true), '') = 'yes' THEN
      UPDATE public.organization_plans op
         SET feature_overrides = op.feature_overrides - 'unlimited_transactions'
       WHERE op.feature_overrides -> 'unlimited_transactions' ->> 'source' = 'trial';
      RAISE NOTICE 'rollback-3860: removed % trial override(s) (flag set)', n;
    ELSE
      RAISE EXCEPTION 'rollback-3860: % trial override(s) exist; the old grant body would lock those users out of subscribing. Stopped. See the header for the flag.', n;
    END IF;
  END IF;
END
$rb1$;

-- 3. ensure_personal_organization(), body of 20260915160637
CREATE OR REPLACE FUNCTION public.ensure_personal_organization()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
BEGIN
  IF v_uid IS NULL THEN
    RETURN jsonb_build_object('status', 'not_authenticated');
  END IF;
  RETURN public._ensure_personal_organization_for(v_uid);
END;
$$;

REVOKE ALL ON FUNCTION public.ensure_personal_organization() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.ensure_personal_organization() FROM anon;
GRANT EXECUTE ON FUNCTION public.ensure_personal_organization() TO authenticated;

-- 4. grant_unlimited_from_subscription, body of 20261011230913
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
  IF v_existing IS NOT NULL AND (v_existing ->> 'source') IS DISTINCT FROM 'stripe' THEN
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

-- 5
DROP FUNCTION IF EXISTS public.admin_set_solo_trial_setting(boolean, integer);
DROP FUNCTION IF EXISTS public.admin_get_solo_trial_setting();
DROP FUNCTION IF EXISTS public._start_solo_trial_for(uuid);

-- 6
DROP TABLE IF EXISTS public.solo_trials;

-- 7
DELETE FROM public.billing_settings WHERE key = 'solo_trial';
ALTER TABLE public.billing_settings DROP CONSTRAINT IF EXISTS billing_settings_solo_trial_days_ck;
ALTER TABLE public.billing_settings DROP COLUMN IF EXISTS days;
ALTER TABLE public.billing_settings DROP CONSTRAINT IF EXISTS billing_settings_key_ck;
ALTER TABLE public.billing_settings ADD CONSTRAINT billing_settings_key_ck
  CHECK (key IN ('brokerage_billing_live'));
COMMENT ON TABLE public.billing_settings IS
  'BACKLOG-3853: DB-side billing switches. brokerage_billing_live = false keeps every brokerage RPC refusing a live-mode deal.';

-- Verify the pre-3860 state.
DO $rbv$
DECLARE
  bad text := '';
BEGIN
  IF (SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.ensure_personal_organization()'::regprocedure)
     IS DISTINCT FROM '52a3b051fd7f1b464e929fecdc4a90f8' THEN bad := bad || ' ensure_personal_organization'; END IF;
  IF (SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.grant_unlimited_from_subscription(uuid,timestamptz,text)'::regprocedure)
     IS DISTINCT FROM '7a38ab6b47b2c66d85b0f920d74ee68a' THEN bad := bad || ' grant_unlimited_from_subscription'; END IF;
  IF (SELECT pg_get_constraintdef(oid) FROM pg_constraint
       WHERE conrelid = 'public.billing_settings'::regclass AND conname = 'billing_settings_key_ck')
     IS DISTINCT FROM 'CHECK ((key = ''brokerage_billing_live''::text))' THEN bad := bad || ' billing_settings_key_ck'; END IF;
  IF to_regclass('public.solo_trials') IS NOT NULL
     OR to_regprocedure('public._start_solo_trial_for(uuid)') IS NOT NULL
     OR to_regprocedure('public.admin_get_solo_trial_setting()') IS NOT NULL
     OR to_regprocedure('public.admin_set_solo_trial_setting(boolean,integer)') IS NOT NULL THEN
    bad := bad || ' 3860-objects-left';
  END IF;
  IF bad <> '' THEN
    RAISE EXCEPTION 'rollback-3860: not restored:%', bad;
  END IF;
END
$rbv$;
