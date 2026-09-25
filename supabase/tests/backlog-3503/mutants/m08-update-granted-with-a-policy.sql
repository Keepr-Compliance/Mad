GRANT UPDATE (agent_pct, brokerage_pct) ON public.agent_split_agreements TO authenticated;
CREATE POLICY agent_split_agreements_update_writer ON public.agent_split_agreements
  FOR UPDATE TO authenticated USING (public.can_write_split_agreements(organization_id))
  WITH CHECK (public.can_write_split_agreements(organization_id));
DO $m$ BEGIN
  IF NOT has_column_privilege('authenticated','public.agent_split_agreements','agent_pct','UPDATE')
     OR NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname='agent_split_agreements_update_writer')
  THEN RAISE EXCEPTION 'MUTATION NOT APPLIED'; END IF; END $m$;
SELECT 'MUTATION APPLIED: UPDATE granted AND an UPDATE policy added -- the table becomes mutable';
