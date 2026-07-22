-- BACKLOG-2180: Provision new individuals as ACTIVE (pay-per-deal credit model),
-- not as a 14-day TRIAL.
--
-- ⚠️  NOT YET APPLIED TO PRODUCTION — FLAGGED FOR FOUNDER / DB REVIEW.
--     This migration is committed with the PR but intentionally NOT run via
--     apply_migration on prod. It changes how first-sign-in license rows are
--     created and (optionally) how existing wrong-shape rows are corrected.
--     Apply only after founder sign-off on the "active individual" license shape
--     and the backfill decision below.
--
-- Context
-- -------
-- On first desktop sign-in the app calls a provisioning RPC (see
-- electron/services/licenseService.ts → createUserLicense). Historically that
-- was `create_trial_license`, which inserts:
--     license_type   = 'trial'
--     trial_status   = 'active'
--     trial_started_at = now()
--     trial_expires_at = now() + INTERVAL '14 days'
-- and relies on table defaults for status='active', transaction_limit=5,
-- max_devices=2.
--
-- Founder decision: individual accounts are ACTIVE from day one under the
-- pay-per-deal credit model (access is gated by credits / transaction_unlocks
-- via entitlementService, NOT by the license). Provisioning a trial produces
-- two defects:
--   (a) a misleading "N days left in your free trial / Upgrade now" banner and a
--       "14-Day Free Trial" onboarding message (no trial and no upgrade flow
--       exist — it is credits), and
--   (b) DAY-14 LOCKOUT RISK — when trial_expires_at passes, calculateLicenseStatus
--       maps license_type='trial' + expired → blockReason='expired', which the
--       renderer renders as the blocking "Trial Expired" UpgradeScreen for a user
--       who should simply keep going pay-per-deal (same failure family as
--       BACKLOG-2148's false Trial-Expired gate).
--
-- Change 1 (REQUIRED for the client fix): new provisioning RPC
-- ------------------------------------------------------------
-- Add `create_active_individual_license(p_user_id uuid)`. The desktop client
-- (this PR) now calls THIS function on first sign-in. It inserts an active
-- individual license with NO trial fields, so a fresh account can never show a
-- trial banner or flip to "Trial Expired".
--
--   license_type    = 'individual'
--   status          = 'active'
--   trial_status    = NULL        -- not on a trial lifecycle
--   trial_started_at= NULL
--   trial_expires_at= NULL        -- ← removes the day-14 lockout vector entirely
--   expires_at      = NULL        -- perpetual; access is governed by credits
--   max_devices     = 2           -- explicit (matches LICENSE_LIMITS.individual)
--   transaction_limit = 0         -- deprecated column; the renderer reads limits
--                                 --   from plan features (useFeatureGate), not
--                                 --   from this column (SPRINT-127 / TASK-2160).
--                                 --   0 here means "no license-column limit"; it
--                                 --   does NOT gate the client. Change to a large
--                                 --   sentinel if a future non-plan reader appears.
--
-- ON CONFLICT (user_id) DO NOTHING preserves the create_trial_license
-- idempotency contract (concurrent first-sign-ins race safely).
--
-- Change 2 (OPTIONAL / SUPERSEDE the old RPC): keep create_trial_license callable
-- --------------------------------------------------------------------------------
-- `create_trial_license` is referenced by name in prior migrations/comments and
-- may be called by other surfaces. This migration leaves the ORIGINAL
-- create_trial_license IN PLACE (a true 14-day trial) so any deliberate trial
-- provisioning still works. The desktop client no longer calls it. If the founder
-- wants ALL self-serve provisioning to be active, uncomment the redefinition in
-- the "OPTION B" block below to make create_trial_license itself provision active
-- (a safety net if any client build still references the old name).
--
-- ─────────────────────────────────────────────────────────────────────────────

-- Change 1: active individual provisioning RPC (REQUIRED).
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
  -- Generate a unique, non-trial license key.
  v_license_key := 'IND-' || REPLACE(gen_random_uuid()::text, '-', '');

  INSERT INTO public.licenses (
    user_id,
    license_key,
    license_type,
    status,
    trial_status,
    trial_started_at,
    trial_expires_at,
    expires_at,
    max_devices,
    transaction_limit
  )
  VALUES (
    p_user_id,
    v_license_key,
    'individual',
    'active',
    NULL,          -- not on a trial lifecycle
    NULL,
    NULL,          -- no day-14 expiry
    NULL,          -- perpetual; access governed by credits
    2,
    0              -- deprecated column; not read by the client
  )
  ON CONFLICT (user_id) DO NOTHING
  RETURNING * INTO v_license;

  -- If the row already existed (idempotent race), return the existing row.
  IF v_license IS NULL THEN
    SELECT * INTO v_license FROM public.licenses WHERE user_id = p_user_id;
  END IF;

  RETURN v_license;
END;
$function$;

-- Match the grants on the sibling create_trial_license RPC so the desktop
-- anon/authenticated client can call it. Adjust if create_trial_license used a
-- different grant set (verify with:
--   SELECT grantee, privilege_type FROM information_schema.routine_privileges
--   WHERE routine_name = 'create_trial_license';
-- ).
GRANT EXECUTE ON FUNCTION public.create_active_individual_license(uuid) TO anon, authenticated, service_role;


-- ─────────────────────────────────────────────────────────────────────────────
-- OPTION B (OPTIONAL — uncomment only if the founder wants the OLD RPC name to
-- also provision active, e.g. as a safety net for older client builds still
-- calling create_trial_license). Leaving this commented keeps a genuine trial
-- path available for any deliberate trial provisioning.
-- ─────────────────────────────────────────────────────────────────────────────
--
-- CREATE OR REPLACE FUNCTION public.create_trial_license(p_user_id uuid)
--  RETURNS licenses
--  LANGUAGE plpgsql
--  SECURITY DEFINER
--  SET search_path TO 'public'
-- AS $function$
-- BEGIN
--   -- BACKLOG-2180: redirected to active individual provisioning.
--   RETURN public.create_active_individual_license(p_user_id);
-- END;
-- $function$;


-- ─────────────────────────────────────────────────────────────────────────────
-- OPTIONAL BACKFILL (DECISION REQUIRED — DO NOT RUN WITHOUT FOUNDER SIGN-OFF).
--
-- As of 2026-07-21 there are 11 license_type='trial' rows, of which 8 already
-- have trial_expires_at < now() (i.e. would render "Trial Expired" today). If
-- these belong to individuals who should be active pay-per-deal, convert them:
--
--   UPDATE public.licenses
--   SET license_type    = 'individual',
--       status          = 'active',
--       trial_status    = NULL,
--       trial_expires_at= NULL,
--       expires_at      = NULL,
--       updated_at      = now()
--   WHERE license_type = 'trial';
--
-- ⚠️  This is destructive to the trial concept for EVERY current trial row. If any
--     of these are legitimately in a paid-trial-that-should-expire flow, scope the
--     WHERE clause (e.g. by specific user_id list) instead. Founder must confirm:
--       1. Should ALL existing trials become active individuals, or only a subset?
--       2. Should transaction_limit be zeroed/left as-is on backfilled rows?
--     Until confirmed, the client-side gate change in this PR
--     (calculateLicenseStatus) does NOT unblock these rows — an already-expired
--     license_type='trial' row still shows "Trial Expired" until it is backfilled
--     to license_type='individual'. The client change only guarantees that
--     individual-typed licenses are never gated by trial expiry.
-- ─────────────────────────────────────────────────────────────────────────────
