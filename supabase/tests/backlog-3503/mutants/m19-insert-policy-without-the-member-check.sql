DROP POLICY agent_commission_agreements_insert_writer ON public.agent_commission_agreements;
CREATE POLICY agent_commission_agreements_insert_writer ON public.agent_commission_agreements
  FOR INSERT TO authenticated
  WITH CHECK (public.can_write_commission_agreements(agent_commission_agreements.organization_id));
DO $m$ BEGIN
  IF position('organization_members' in (SELECT with_check FROM pg_policies WHERE policyname='agent_commission_agreements_insert_writer')) > 0
  THEN RAISE EXCEPTION 'MUTATION NOT APPLIED'; END IF; END $m$;
SELECT 'MUTATION APPLIED: the INSERT policy no longer requires the subject to be a member of the org';
