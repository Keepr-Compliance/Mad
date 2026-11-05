-- BACKLOG-4144 M2 rollback (keepr-test, or production with a go).
-- Restores the four SELECT policies to their text before 20261105110000, as pg_policies printed it on
-- production and keepr-test on 2026-11-05 (md5 of pg_policies.qual: analytics_events d247c211,
-- sync_outcomes internal 64cef7be, submission_attempts 77dde765, support_sla_settings d4f42f3f), and
-- clears the policy comments M2 set (there were none before). Idempotent.

ALTER POLICY analytics_events_select_own_or_internal ON public.analytics_events
  USING (((SELECT auth.uid()) = user_id) OR has_internal_role((SELECT auth.uid())));
COMMENT ON POLICY analytics_events_select_own_or_internal ON public.analytics_events IS NULL;

ALTER POLICY "Internal roles can read sync outcomes" ON public.sync_outcomes
  USING (EXISTS (SELECT 1 FROM internal_roles WHERE internal_roles.user_id = (SELECT auth.uid())));
COMMENT ON POLICY "Internal roles can read sync outcomes" ON public.sync_outcomes IS NULL;

ALTER POLICY submission_attempts_select ON public.submission_attempts
  USING (
    (user_id = (SELECT auth.uid()))
    OR can_review_submission(organization_id)
    OR (EXISTS (SELECT 1 FROM internal_roles ir WHERE ir.user_id = (SELECT auth.uid())))
  );
COMMENT ON POLICY submission_attempts_select ON public.submission_attempts IS NULL;

ALTER POLICY support_sla_settings_select_internal ON public.support_sla_settings
  USING (EXISTS (SELECT 1 FROM internal_roles ir WHERE ir.user_id = (SELECT auth.uid())));
COMMENT ON POLICY support_sla_settings_select_internal ON public.support_sla_settings IS NULL;
