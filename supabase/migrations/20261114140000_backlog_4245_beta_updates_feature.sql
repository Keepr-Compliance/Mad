-- ============================================================================
-- Migration: Add the beta_updates feature definition (OFF everywhere)
-- Backlog: BACKLOG-4245
-- Purpose:
--   Makes an organization's members eligible to receive Keepr beta versions
--   when they turn on "Get beta versions" in the desktop app. The desktop
--   reads it with the STRICT (fail-closed) reader in the main process: absent
--   key, empty map, no session or a failed read all mean "not eligible".
--
--   Every row below is written false, so the state the moment after the apply
--   equals the state the moment before. Before the apply the key is absent and
--   the desktop reads an absent key as "not eligible".
--
-- ---------------------------------------------------------------------------
-- Pre-check
-- ---------------------------------------------------------------------------
--   get_org_features must be at the body this key was traced against
--   (20261015152446_backlog_3851_license_model.sql). The expected md5 is
--   md5 of the text between "AS $function$" and the closing "$function$;" of
--   that file's CREATE OR REPLACE FUNCTION public.get_org_features, which is
--   what pg_proc.prosrc stores. If it differs, the apply stops.
--
-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------
--   This file creates no function and no table: it inserts rows into two
--   existing tables. The revoke-by-default rules have nothing to attach to.
--
-- ---------------------------------------------------------------------------
-- Granting
-- ---------------------------------------------------------------------------
--   Per organization only: organization_plans.feature_overrides
--     {"beta_updates": {"enabled": true}}
--   Revoke = remove the key, never leave {} (an override without "enabled"
--   reads as enabled). Never switch it on for a plan; the admin plan editor
--   does not list this key (PLAN_EDITOR_HIDDEN_FEATURE_KEYS).
--
--   min_tier NULL is load-bearing: with a tier, an override on an
--   organization below it would be ignored by _override_above_tier.
--   default_value 'false' is load-bearing: an organization with no plan row
--   falls through to it.
--   is_built false: the broker portal hides it.
--   sort_order 166: 165 was the highest in use on keepr-test (2026-11-15).
--   Re-check at apply.
--
-- Rollback: supabase/tests/backlog-4245/rollback-4245.sql
-- ============================================================================

DO $precheck$
DECLARE
  v_md5 text;
BEGIN
  SELECT md5(p.prosrc) INTO v_md5
    FROM pg_proc p
   WHERE p.proname = 'get_org_features'
     AND p.pronamespace = 'public'::regnamespace;
  IF v_md5 IS DISTINCT FROM 'ab7769fae1a97e4865a3522014b115b3' THEN
    RAISE EXCEPTION 'BACKLOG-4245: get_org_features is not at the traced body (md5 %)', coalesce(v_md5, 'missing');
  END IF;
END
$precheck$;

INSERT INTO public.feature_definitions
  (key, name, description, category, value_type, default_value, min_tier, sort_order, is_built)
VALUES (
  'beta_updates',
  'Beta versions',
  'Lets the desktop app receive Keepr beta versions for a user who turns on "Get beta versions". Off unless an organization override grants it (BACKLOG-4245).',
  'general',
  'boolean',
  'false',
  NULL,
  166,
  false
)
ON CONFLICT (key) DO NOTHING;

INSERT INTO public.plan_features (plan_id, feature_id, enabled, value)
SELECT p.id, fd.id, false, 'false'
FROM public.plans p
CROSS JOIN public.feature_definitions fd
WHERE fd.key = 'beta_updates'
ON CONFLICT (plan_id, feature_id) DO NOTHING;
