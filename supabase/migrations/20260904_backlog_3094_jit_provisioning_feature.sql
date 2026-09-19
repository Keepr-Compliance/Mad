-- ============================================================================
-- Migration: Add jit_provisioning Feature Definition (default OFF everywhere)
-- Backlog: BACKLOG-3094 (shipped with BACKLOG-3078)
-- Purpose:
--   Give the broker portal a plan feature it can gate the Just-in-Time
--   provisioning toggle on, so an admin is never invited to switch on automatic
--   joining that fails every single time.
--
-- Why the surface has to be hidden:
--   Verified 2026-09-03 against prod. Every JIT join fails and signs the user
--   out, for two independent reasons:
--     1. Signature drift — the portal calls
--        jit_join_organization(p_provider_type, p_identifier); production only
--        has jit_join_organization(p_tenant_id text). PostgREST cannot resolve
--        the call.
--     2. EXECUTE revoked — that remaining one-argument function has EXECUTE
--        revoked from `authenticated` (acl: postgres, service_role only),
--        applied 2026-07-11 as the interim mitigation for the cross-org
--        escalation in BACKLOG-1954. The call site uses the anon-key user
--        session.
--   Last JIT-provisioned member: 2026-03-05. Nothing has joined this way since.
--
--   The toggle defaults ON (organizations.jit_provisioning_enabled defaults to
--   true), so the card already reads as though the feature is live.
--
-- ---------------------------------------------------------------------------
-- default_value = 'false' is the load-bearing line, NOT the plan_features rows
-- ---------------------------------------------------------------------------
--   broker_get_org_features() looks up organization_plans first. When an org has
--   NO plan row it never consults plan_features at all — it falls straight
--   through to feature_definitions.default_value for every key. A migration
--   that seeded only plan_features would leave JIT enabled for exactly the
--   plan-less orgs, which is what a newly onboarded brokerage is.
--
--   Both are written anyway: default_value covers plan-less orgs, plan_features
--   covers orgs on a plan, and the two must agree.
--
-- This migration does NOT touch organizations.jit_provisioning_enabled.
--   Hiding the control must not change any org's stored value; the column
--   matters again the moment BACKLOG-1954 lands and JIT actually works.
--
-- Prerequisites:
--   - 20260312_tier_constraints_schema.sql (min_tier column, 'access' category)
--
-- Turning it on later (do NOT do it here):
--   Per-org:  organization_plans.feature_overrides -> {"jit_provisioning": {"enabled": true}}
--   Per-plan: admin_update_plan_feature(...)
--   Only once BACKLOG-1954 has landed a working jit_join_organization AND one
--   real join has been observed end to end.
-- ============================================================================

-- ============================================================================
-- 1. INSERT jit_provisioning FEATURE DEFINITION
-- ============================================================================
-- min_tier is NULL on purpose: this is not a tier entitlement, it is a
-- "the join does not work yet" switch. Enterprise does not get it either.

INSERT INTO public.feature_definitions (key, name, description, category, value_type, default_value, min_tier, sort_order)
VALUES (
  'jit_provisioning',
  'Just-in-Time Provisioning',
  'Automatic organization joining for users signing in with a matching work account. Off until jit_join_organization is restored and verified end to end (BACKLOG-1954).',
  'access',
  'boolean',
  'false',
  NULL,
  156
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
WHERE fd.key = 'jit_provisioning'
ON CONFLICT (plan_id, feature_id) DO NOTHING;
