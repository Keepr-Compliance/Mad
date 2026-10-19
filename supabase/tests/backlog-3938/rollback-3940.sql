-- BACKLOG-3940 rollback: restore production's two policies verbatim.
DROP POLICY IF EXISTS support_ticket_backlog_links_internal_all ON public.support_ticket_backlog_links;
CREATE POLICY "Admins can manage links" ON public.support_ticket_backlog_links FOR ALL TO public
  USING (EXISTS ( SELECT 1
   FROM organization_members om
  WHERE ((om.user_id = ( SELECT auth.uid() AS uid)) AND ((om.role)::text = ANY (ARRAY[('admin'::character varying)::text, ('super_admin'::character varying)::text])))))
  WITH CHECK (EXISTS ( SELECT 1
   FROM organization_members om
  WHERE ((om.user_id = ( SELECT auth.uid() AS uid)) AND ((om.role)::text = ANY (ARRAY[('admin'::character varying)::text, ('super_admin'::character varying)::text])))));
CREATE POLICY "Authenticated users can read links" ON public.support_ticket_backlog_links FOR SELECT TO public
  USING (( SELECT auth.uid() AS uid) IS NOT NULL);
