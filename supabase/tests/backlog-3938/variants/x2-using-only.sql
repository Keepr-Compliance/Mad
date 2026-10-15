ALTER POLICY "Admins can manage links" ON public.support_ticket_backlog_links USING (public.has_internal_role((SELECT auth.uid())));
DROP POLICY "Authenticated users can read links" ON public.support_ticket_backlog_links;
