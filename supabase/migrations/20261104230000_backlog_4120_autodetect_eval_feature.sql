-- ============================================================================
-- Migration: Add the autodetect_eval feature definition (OFF everywhere)
-- Backlog: BACKLOG-4120
-- Purpose:
--   Makes the desktop "Help Keepr learn" (Learn mode) settings section
--   available to an organization. The desktop reads it with the STRICT
--   (fail-closed) reader: absent key, empty map, no session or a failed read
--   all mean "not available". Learn mode is a separate switch from AI
--   detection and reads neither ai_detection nor enable_auto_detect. Even when
--   the key is on, each user's own Learn mode toggle starts OFF.
--
-- NOT APPLIED. The file ships in the PR; applying it is a separate act that
-- needs the founder's explicit apply go.
--
--   Every row below is written false, so the state the moment after the apply
--   equals the state the moment before. Before the apply the key is absent and
--   the desktop reads an absent key as "not available".
--
-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------
--   This file creates no function and no table: it inserts rows into two
--   existing tables. The revoke-by-default rules (REVOKE EXECUTE FROM PUBLIC,
--   anon; REVOKE TRUNCATE FROM anon, authenticated) have nothing to attach to.
--   A later revision that adds a function or a table must add them.
--
-- ---------------------------------------------------------------------------
-- One plan switch = Learn mode available for every organization on that plan
-- ---------------------------------------------------------------------------
--   The admin plan editor shows this key on every plan. Turning it on for a
--   plan (admin_update_plan_feature, plans.manage) makes Learn mode available
--   to EVERY organization on that plan. Per-organization grants go in
--   organization_plans.feature_overrides only:
--     {"autodetect_eval": {"enabled": true}}
--   Revoke = remove the key, never leave {} (an override without "enabled"
--   reads as enabled).
--
--   min_tier NULL is load-bearing: with a tier, an override on an
--   organization below it would be ignored by _override_above_tier.
--   default_value 'false' is load-bearing: an organization with no plan row
--   falls through to it.
--
--   sort_order 163: 160-162 are taken (checked 2026-11-04). Re-check at apply.
-- ============================================================================

INSERT INTO public.feature_definitions
  (key, name, description, category, value_type, default_value, min_tier, sort_order, is_built)
VALUES (
  'autodetect_eval',
  'Help Keepr learn',
  'Makes the desktop Learn mode settings section available. Each user turns Learn mode on for themselves; it starts off. Separate from AI detection (BACKLOG-4120).',
  'general',
  'boolean',
  'false',
  NULL,
  163,
  true
)
ON CONFLICT (key) DO NOTHING;

INSERT INTO public.plan_features (plan_id, feature_id, enabled, value)
SELECT p.id, fd.id, false, 'false'
FROM public.plans p
CROSS JOIN public.feature_definitions fd
WHERE fd.key = 'autodetect_eval'
ON CONFLICT (plan_id, feature_id) DO NOTHING;
