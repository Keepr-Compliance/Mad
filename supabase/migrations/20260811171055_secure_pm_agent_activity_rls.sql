-- Version 20260811171055 / secure_pm_agent_activity_rls
--
-- BACKLOG-2658. Written after the fact, like the registry migration it repairs.
-- The fix below is already live; it was applied with `apply_migration` and so
-- had no file either. Verified against production before transcription:
--   pg_class.relrowsecurity = true
--   pg_policies -> exactly one policy, SELECT, no WITH CHECK
--   pg_class.reloptions -> {security_invoker=true} on all three views
--
-- Supabase security advisor, 2026-08-11:
--   rls_disabled_in_public  -> pm_agent_activity  (CRITICAL: readable/writable by anyone
--                              holding the public anon key; the table carries branch names,
--                              work descriptions, session ids and absolute worktree paths)
--   security_definer_view   -> pm_agents_active, pm_agent_file_collisions, pm_agent_bypassed
--                              (a SECURITY DEFINER view reads with the OWNER's rights, so it
--                              would keep exposing the table after RLS is enabled)
--
-- Shape copied verbatim from the sibling tables that already pass the advisor
-- (pm_backlog_items, pm_token_metrics): RLS enabled, ONE select policy for internal
-- users, and NO write policy — writes reach it only through the service role, which
-- bypasses RLS. The registry hooks use that role, which is why they already write to
-- pm_token_metrics while it is locked.

ALTER TABLE public.pm_agent_activity ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Internal users can read pm_agent_activity"
  ON public.pm_agent_activity
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM internal_roles
      WHERE internal_roles.user_id = (SELECT auth.uid())
    )
  );

-- The three views must not run as their definer, or they re-open what the policy just closed.
ALTER VIEW public.pm_agents_active            SET (security_invoker = true);
ALTER VIEW public.pm_agent_file_collisions    SET (security_invoker = true);
ALTER VIEW public.pm_agent_bypassed           SET (security_invoker = true);
