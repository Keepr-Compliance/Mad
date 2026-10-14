-- BACKLOG-3940: support_ticket_backlog_links is read and written by internal
-- support staff only.
--
-- Replaces the two existing policies ("Admins can manage links",
-- "Authenticated users can read links") with one policy FOR ALL TO authenticated
-- whose USING and WITH CHECK are has_internal_role((SELECT auth.uid())), the same
-- check the support_* RPCs and policies use. The only readers and writers are the
-- admin portal's support pages, which run as the signed-in internal user.
-- No grants change. No data changes.
--
-- Apply as one transaction. No BEGIN/COMMIT here.
-- Rollback: supabase/tests/backlog-3938/rollback-3940.sql

DROP POLICY IF EXISTS "Admins can manage links" ON public.support_ticket_backlog_links;
DROP POLICY IF EXISTS "Authenticated users can read links" ON public.support_ticket_backlog_links;
DROP POLICY IF EXISTS support_ticket_backlog_links_internal_all ON public.support_ticket_backlog_links;
CREATE POLICY support_ticket_backlog_links_internal_all ON public.support_ticket_backlog_links
  FOR ALL TO authenticated
  USING (public.has_internal_role((SELECT auth.uid())))
  WITH CHECK (public.has_internal_role((SELECT auth.uid())));
