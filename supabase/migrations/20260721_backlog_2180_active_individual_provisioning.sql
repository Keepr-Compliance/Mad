-- BACKLOG-2180: Provision new individuals as ACTIVE (pay-per-deal credit model),
-- not as a 14-day TRIAL.
--
-- ✅ APPLIED TO PRODUCTION 2026-07-21 via MCP with founder sign-off on all three
--    decisions (this file mirrors exactly what was applied, so a later
--    CI/db-reset deploy is idempotent and does NOT revert prod):
--      1. Backfill: YES — all existing license_type='trial' rows → active individual.
--      2. Redirect old RPC: YES — create_trial_license now provisions active
--         (covers un-updated v2.25.0 clients still calling it by name).
--      3. transaction_limit on active individuals: 99999 (a never-blocks sentinel,
--         NOT 0 — a deprecated electron path does `transaction_count >= transaction_limit`
--         and 0 would evaluate as "always at limit"). The renderer reads the real
--         limit from plan features (SPRINT-127 / TASK-2160); this column is a safety
--         value only.
--
-- Context
-- -------
-- On first desktop sign-in the app calls a provisioning RPC (see
-- electron/services/licenseService.ts → createUserLicense). Historically that was
-- `create_trial_license`, which minted a 14-day trial. The real model is
-- pay-per-deal credits (access gated by credits/transaction_unlocks via
-- entitlementService, NOT by the license). A trial produced two defects:
--   (a) a misleading "N days left in your free trial / Upgrade now" banner, and
--   (b) DAY-14 LOCKOUT — trial_expires_at passing → blockReason='expired' →
--       "Trial Expired" UpgradeScreen for a user who should keep going pay-per-deal.

-- Change 1: active-individual provisioning RPC (transaction_limit = 99999).
CREATE OR REPLACE FUNCTION public.create_active_individual_license(p_user_id uuid)
 RETURNS licenses
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_license public.licenses;
  v_license_key TEXT;
BEGIN
  v_license_key := 'IND-' || REPLACE(gen_random_uuid()::text, '-', '');
  INSERT INTO public.licenses (
    user_id, license_key, license_type, status,
    trial_status, trial_started_at, trial_expires_at, expires_at,
    max_devices, transaction_limit
  )
  VALUES (
    p_user_id, v_license_key, 'individual', 'active',
    NULL, NULL, NULL, NULL,       -- no trial lifecycle, no day-14 expiry, perpetual
    2, 99999                       -- 99999 = never-blocks sentinel (see header)
  )
  ON CONFLICT (user_id) DO NOTHING
  RETURNING * INTO v_license;
  IF v_license IS NULL THEN
    SELECT * INTO v_license FROM public.licenses WHERE user_id = p_user_id;
  END IF;
  RETURN v_license;
END;
$function$;

GRANT EXECUTE ON FUNCTION public.create_active_individual_license(uuid) TO anon, authenticated, service_role;

-- Change 2: redirect the OLD RPC → active (decision 2 = YES). No more trials from
-- any client version.
CREATE OR REPLACE FUNCTION public.create_trial_license(p_user_id uuid)
 RETURNS licenses
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  -- BACKLOG-2180: no more trials — provision active individuals.
  RETURN public.create_active_individual_license(p_user_id);
END;
$function$;

-- Change 3: backfill existing trials → active individuals (decision 1 = YES).
-- Unblocks the 8 already-expired trial users (real brokers included). Idempotent:
-- a no-op once no trial rows remain.
UPDATE public.licenses
SET license_type    = 'individual',
    status          = 'active',
    trial_status    = NULL,
    trial_started_at= NULL,
    trial_expires_at= NULL,
    expires_at      = NULL,
    transaction_limit = 99999,
    updated_at      = now()
WHERE license_type = 'trial';
