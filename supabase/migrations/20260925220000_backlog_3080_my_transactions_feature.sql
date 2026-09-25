-- ============================================================================
-- Migration: Add the portal_my_transactions feature definition (OFF everywhere)
-- Backlog: BACKLOG-3080
-- Purpose:
--   The broker portal's "My Transactions" tab: a brokerage agent sees their own
--   submitted transactions, read-only. This key is the plan switch for it.
--
-- NOT APPLIED. The file ships in the PR; applying it is a separate act.
-- The founder's yes is required, and the apply comes only
-- AFTER the portal deploy that carries the My Transactions pages.
--
--   Until it is applied the key is ABSENT for every organization, and the
--   portal reads an absent key fail-closed: a brokerage agent sees the plan
--   message, never the list. Every row below is written false, so the state
--   the moment after the apply equals the state the moment before. Turning it
--   on for a plan is a later, per-plan decision.
--
-- ---------------------------------------------------------------------------
-- default_value 'false' is load-bearing, not only the plan_features rows
-- ---------------------------------------------------------------------------
--   An organization with no plan row falls through to
--   feature_definitions.default_value. Both are written false and agree.
--
--   min_tier NULL: any plan may carry this feature; it is not a tier privilege.
--
--   is_built = true: the page ships with this PR. broker_get_org_features does
--   not read is_built, so it opens nothing; it only decides how the admin plan
--   editor presents the switch. That is why the apply waits for the deploy.
--
--   category 'access', beside broker_portal_access and transaction_checklists.
-- ============================================================================

INSERT INTO public.feature_definitions
  (key, name, description, category, value_type, default_value, min_tier, sort_order, is_built)
VALUES (
  'portal_my_transactions',
  'My Transactions',
  'Lets a brokerage agent view their own submitted transactions in the broker portal, read-only. Off unless a plan or an organization override turns it on (BACKLOG-3080).',
  'access',
  'boolean',
  'false',
  NULL,
  128,
  true
)
ON CONFLICT (key) DO NOTHING;

INSERT INTO public.plan_features (plan_id, feature_id, enabled, value)
SELECT p.id, fd.id, false, 'false'
FROM public.plans p
CROSS JOIN public.feature_definitions fd
WHERE fd.key = 'portal_my_transactions'
ON CONFLICT (plan_id, feature_id) DO NOTHING;
