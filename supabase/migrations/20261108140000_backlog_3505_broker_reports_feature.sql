-- ============================================================================
-- Migration: Add the broker_reports feature definition and its plan rows
-- Backlog: BACKLOG-3505
-- Purpose:
--   The broker portal's Reports section. This key is the plan switch for the
--   Reports sidebar entry, the Reports index and every report page
--   (broker-portal/lib/reports/report-gate.ts, read FAIL-CLOSED).
--
-- Plan rows (founder, pm_comments 0ecfc989 on BACKLOG-3505):
--   team               -> offered, OFF by default  (enabled = false)
--   enterprise         -> ON  (enabled = true)
--   enterprise-preview -> ON  (enabled = true, follows Enterprise)
--   individual         -> no row
--   keepr-internal     -> no row (QA uses an organization override)
--   An organization with no plan row falls through to
--   feature_definitions.default_value, written 'false'.
--
--   min_tier 'team': offered on Team and above, never Individual.
--   category 'access', beside portal_my_transactions and transaction_checklists.
--   sort_order 136: free, directly after transaction_checklists (135).
--
--   is_built = false: the PR that carries this file registers NO report, so
--   the section has nothing to show yet. broker_get_org_features does not read
--   is_built; it only decides how the admin plan editor presents the switch.
--   The PR that registers the first report flips it.
--
-- Idempotent: ON CONFLICT DO NOTHING on both inserts; re-running changes
-- nothing. No function, grant or policy changes.
--
-- Rollback: supabase/tests/backlog-3505/rollback-3505.sql.
-- ============================================================================

INSERT INTO public.feature_definitions
  (key, name, description, category, value_type, default_value, min_tier, sort_order, is_built)
VALUES (
  'broker_reports',
  'Reports',
  'Lets brokers, admins and IT admins open the Reports section of the broker portal; agents see the agent-scoped reports, limited to their own rows (BACKLOG-3505).',
  'access',
  'boolean',
  'false',
  'team',
  136,
  false
)
ON CONFLICT (key) DO NOTHING;

INSERT INTO public.plan_features (plan_id, feature_id, enabled, value)
SELECT p.id, fd.id, v.enabled, v.enabled::text
FROM (
  VALUES
    ('team', false),
    ('enterprise', true),
    ('enterprise-preview', true)
) AS v(slug, enabled)
JOIN public.plans p ON p.slug = v.slug
CROSS JOIN public.feature_definitions fd
WHERE fd.key = 'broker_reports'
ON CONFLICT (plan_id, feature_id) DO NOTHING;
