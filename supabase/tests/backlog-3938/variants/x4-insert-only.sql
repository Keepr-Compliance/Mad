DROP POLICY "Admins can manage links" ON public.support_ticket_backlog_links;
DROP POLICY "Authenticated users can read links" ON public.support_ticket_backlog_links;
CREATE POLICY support_ticket_backlog_links_internal_ins ON public.support_ticket_backlog_links
  FOR INSERT TO authenticated WITH CHECK (public.has_internal_role((SELECT auth.uid())));
CREATE POLICY support_ticket_backlog_links_internal_sel ON public.support_ticket_backlog_links
  FOR SELECT TO authenticated USING (public.has_internal_role((SELECT auth.uid())));
