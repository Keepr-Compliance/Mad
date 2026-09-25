GRANT DELETE ON public.agent_split_agreements TO authenticated;
GRANT DELETE ON public.organization_franchise_fees TO authenticated;
CREATE POLICY agent_split_agreements_delete_writer ON public.agent_split_agreements
  FOR DELETE TO authenticated USING (public.can_write_split_agreements(organization_id));
CREATE POLICY organization_franchise_fees_delete_writer ON public.organization_franchise_fees
  FOR DELETE TO authenticated USING (public.can_write_split_agreements(organization_id));
DO $m$ BEGIN
  IF NOT has_table_privilege('authenticated','public.agent_split_agreements','DELETE')
     OR NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname='agent_split_agreements_delete_writer')
  THEN RAISE EXCEPTION 'MUTATION NOT APPLIED'; END IF; END $m$;
SELECT 'MUTATION APPLIED: DELETE granted AND a DELETE policy added -- history becomes erasable';
