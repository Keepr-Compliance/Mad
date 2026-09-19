-- ============================================================================
-- Migration: Add scim_provisioning Feature Definition (default OFF everywhere)
-- Backlog: BACKLOG-3087
-- Purpose:
--   Give the broker portal a plan feature it can gate the SCIM surfaces on, so
--   an IT admin is never handed a SCIM endpoint URL that returns 404.
--
-- Why the surface has to be hidden:
--   Verified 2026-09-03 against prod. Three edge functions are deployed
--   (system-health, send-ticket-confirmation, claim-tokens). There is no `scim`
--   function: GET /functions/v1/scim/v2/Users returns 404 while the control
--   system-health returns 401. scim_tokens and scim_sync_log have zero rows —
--   SCIM has never worked. BACKLOG-2241 stays open to actually build it.
--
-- ---------------------------------------------------------------------------
-- default_value = 'false' is the load-bearing line, NOT the plan_features rows
-- ---------------------------------------------------------------------------
--   broker_get_org_features() looks up organization_plans first. When an org has
--   NO plan row (v_has_plan = false) it never consults plan_features at all — it
--   falls straight through to feature_definitions.default_value for every key.
--
--   The brokerage this item was filed for is exactly that case: verified
--   2026-09-03, it has no organization_plans row, and all 21 of its features
--   resolve with source 'default'. A migration that seeded only plan_features
--   would leave SCIM enabled for precisely the org that prompted the item.
--   (The org id is deliberately not recorded here — this repo is public.)
--
--   Both are written anyway: default_value covers plan-less orgs, plan_features
--   covers orgs on a plan, and the two must agree.
--
-- Prerequisites:
--   - 20260312_tier_constraints_schema.sql (min_tier column, 'access' category)
--
-- Turning it on later (do NOT do it here):
--   Per-org:  organization_plans.feature_overrides -> {"scim_provisioning": {"enabled": true}}
--   Per-plan: admin_update_plan_feature(...)
--   Only once the `scim` edge function is deployed AND one real Entra sync has
--   been observed end to end.
-- ============================================================================

-- ============================================================================
-- 1. INSERT scim_provisioning FEATURE DEFINITION
-- ============================================================================
-- min_tier is NULL on purpose: this is not a tier entitlement, it is a
-- "the endpoint does not exist yet" switch. Enterprise does not get it either.

INSERT INTO public.feature_definitions (key, name, description, category, value_type, default_value, min_tier, sort_order)
VALUES (
  'scim_provisioning',
  'SCIM Provisioning',
  'Directory sync via SCIM 2.0. Off until the scim edge function is deployed and verified against a real identity provider (BACKLOG-2241).',
  'access',
  'boolean',
  'false',
  NULL,
  155
)
ON CONFLICT (key) DO NOTHING;

-- ============================================================================
-- 2. SEED plan_features — DISABLED ON EVERY PLAN
-- ============================================================================
-- No tier CASE: every plan gets enabled = false. Written against public.plans
-- rather than a hardcoded tier list so a plan added later is still covered by a
-- re-run (ON CONFLICT DO NOTHING makes this idempotent).

INSERT INTO public.plan_features (plan_id, feature_id, enabled, value)
SELECT p.id, fd.id, false, 'false'
FROM public.plans p
CROSS JOIN public.feature_definitions fd
WHERE fd.key = 'scim_provisioning'
ON CONFLICT (plan_id, feature_id) DO NOTHING;
