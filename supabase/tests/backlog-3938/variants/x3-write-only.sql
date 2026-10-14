DROP POLICY "Admins can manage links" ON public.support_ticket_backlog_links;
CREATE POLICY support_ticket_backlog_links_internal_all ON public.support_ticket_backlog_links
  FOR ALL TO authenticated USING (public.has_internal_role((SELECT auth.uid()))) WITH CHECK (public.has_internal_role((SELECT auth.uid())));
