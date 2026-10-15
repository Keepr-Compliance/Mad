-- ============================================================================
-- Migration: Add the unlimited_transactions feature definition (OFF everywhere)
-- Backlog: BACKLOG-3675
-- Purpose:
--   An account with this feature enabled exports any transaction without an
--   unlock row and without spending a credit. The desktop export gate reads it
--   live; an offline pass signed by the issue-offline-pass Edge Function
--   carries it for at most 48 hours without a network.
--
-- NOT APPLIED. The file ships in the PR; applying it is a separate act that
-- needs the founder's explicit apply go.
--
--   Every row below is written false, so the state the moment after the apply
--   equals the state the moment before. Before the apply the key is absent and
--   the desktop reads an absent key as "not entitled".
--
-- ---------------------------------------------------------------------------
-- One plan switch = unlimited for every account on that plan
-- ---------------------------------------------------------------------------
--   The admin plan editor shows this key on every plan. Turning it on for a
--   plan (admin_update_plan_feature, plans.manage) grants unlimited exports to
--   EVERY organization on that plan, every solo account included when the
--   plan is Individual. Per-account grants go on the account's personal
--   organization as an override in organization_plans.feature_overrides:
--     {"unlimited_transactions": {"enabled": true, "paid_through": "<ISO-8601>"}}
--   paid_through is optional; the offline pass never outlives it.
--   Revoke = remove the key, never leave {} (an override without "enabled"
--   reads as enabled).
--
--   min_tier NULL is load-bearing: with 'team', an override on an Individual
--   personal organization would be ignored by _override_above_tier.
--   default_value 'false' is load-bearing: an organization with no plan row
--   falls through to it.
-- ============================================================================

INSERT INTO public.feature_definitions
  (key, name, description, category, value_type, default_value, min_tier, sort_order, is_built)
VALUES (
  'unlimited_transactions',
  'Unlimited transactions',
  'Exports any transaction without an unlock or a credit. Off unless a plan or an organization override turns it on (BACKLOG-3675).',
  'export',
  'boolean',
  'false',
  NULL,
  162,
  true
)
ON CONFLICT (key) DO NOTHING;

INSERT INTO public.plan_features (plan_id, feature_id, enabled, value)
SELECT p.id, fd.id, false, 'false'
FROM public.plans p
CROSS JOIN public.feature_definitions fd
WHERE fd.key = 'unlimited_transactions'
ON CONFLICT (plan_id, feature_id) DO NOTHING;
