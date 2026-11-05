-- BACKLOG-4144 M2 — report-only tables readable per report
--
-- Four tables are read by exactly one admin report each (two for analytics_events). Until now their
-- SELECT policies let ANY internal role read every row. This migration replaces ONLY that internal-role
-- branch with a per-report check, public.report_my_access(<report key>) IS NOT NULL (BACKLOG-4144 M1,
-- 20261105100000). Every other branch is kept exactly as it was:
--   * a user's own rows (the desktop app updates and upserts its own analytics_events / sync_outcomes);
--   * can_review_submission(organization_id) on submission_attempts (brokerage reviewers);
--   * the service-role policy on analytics_events, and service_role, which bypasses RLS.
--
-- The policies are changed IN PLACE with ALTER POLICY: same names, same commands, same roles, same
-- count. No policy is added beside an old one (permissive policies OR together, so an added policy
-- would leave the old internal-role access open).
--
-- report_my_access() is caller-bound (auth.uid() inside, EXECUTE to authenticated). The private helper
-- _report_access_role() is NOT used here: its EXECUTE is revoked from authenticated, and a policy that
-- calls it fails every read. Each call is wrapped in (SELECT ...) so it runs once per statement.
--
-- Keys, per report (admin-portal/lib/reports):
--   analytics_events.event_name
--     'paywall-viewed', 'unlock-clicked', 'payment-succeeded'   -> funnel        (funnel-analytics.ts FUNNEL_STEP_EVENTS)
--     'export-completed'                                        -> funnel OR exports
--                                    (FUNNEL_STEP_EVENTS includes it; exports.ts EXPORT_EVENT_NAME)
--     any other event name                                      -> no internal read (no report reads one)
--   sync_outcomes.source
--     'iphone-backup'    -> iphone-sync            (iphone-sync-queries.ts IPHONE source; electron syncTimeline.ts)
--     'google-messages'  -> google-messages-sync   (google-messages-sync.ts GM_SOURCE; electron rcsSyncOutcome.ts)
--     any other source   -> no internal read
--   submission_attempts   -> submissions
--   support_sla_settings  -> support-sla
--
-- Note: support_sla_settings_update_admin (support.admin) is unchanged, but an UPDATE only reaches rows
-- the caller can SELECT, so a support.admin holder without support-sla access updates 0 rows. No code
-- writes this table today.
--
-- Idempotent: ALTER POLICY sets the same text on every run.
-- Rollback: supabase/tests/backlog-4144-rls/rollback-4144-rls.sql.

-- ============================================================
-- 1. analytics_events — funnel / exports
-- ============================================================
ALTER POLICY analytics_events_select_own_or_internal ON public.analytics_events
  USING (
    ((SELECT auth.uid()) = user_id)
    OR (
      event_name IN ('paywall-viewed', 'unlock-clicked', 'payment-succeeded', 'export-completed')
      AND (SELECT public.report_my_access('funnel')) IS NOT NULL
    )
    OR (
      event_name = 'export-completed'
      AND (SELECT public.report_my_access('exports')) IS NOT NULL
    )
  );

COMMENT ON POLICY analytics_events_select_own_or_internal ON public.analytics_events IS
  'BACKLOG-4144: own rows; funnel events to funnel report access; export-completed to funnel or exports report access.';

-- ============================================================
-- 2. sync_outcomes — iphone-sync / google-messages-sync
--    (own rows are a separate policy, "Users can read own sync outcomes", unchanged)
-- ============================================================
ALTER POLICY "Internal roles can read sync outcomes" ON public.sync_outcomes
  USING (
    (
      source = 'iphone-backup'
      AND (SELECT public.report_my_access('iphone-sync')) IS NOT NULL
    )
    OR (
      source = 'google-messages'
      AND (SELECT public.report_my_access('google-messages-sync')) IS NOT NULL
    )
  );

COMMENT ON POLICY "Internal roles can read sync outcomes" ON public.sync_outcomes IS
  'BACKLOG-4144: iphone-backup rows to iphone-sync report access; google-messages rows to google-messages-sync report access.';

-- ============================================================
-- 3. submission_attempts — submissions
-- ============================================================
ALTER POLICY submission_attempts_select ON public.submission_attempts
  USING (
    (user_id = (SELECT auth.uid()))
    OR can_review_submission(organization_id)
    OR (SELECT public.report_my_access('submissions')) IS NOT NULL
  );

COMMENT ON POLICY submission_attempts_select ON public.submission_attempts IS
  'BACKLOG-4144: own rows; brokerage reviewers; submissions report access.';

-- ============================================================
-- 4. support_sla_settings — support-sla
-- ============================================================
ALTER POLICY support_sla_settings_select_internal ON public.support_sla_settings
  USING (
    (SELECT public.report_my_access('support-sla')) IS NOT NULL
  );

COMMENT ON POLICY support_sla_settings_select_internal ON public.support_sla_settings IS
  'BACKLOG-4144: support-sla report access.';
