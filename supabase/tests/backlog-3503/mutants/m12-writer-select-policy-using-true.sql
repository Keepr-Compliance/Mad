DROP POLICY agent_commission_agreements_select_writer ON public.agent_commission_agreements;
CREATE POLICY agent_commission_agreements_select_writer ON public.agent_commission_agreements
  FOR SELECT TO authenticated USING (true);
DROP POLICY organization_franchise_fees_select_writer ON public.organization_franchise_fees;
CREATE POLICY organization_franchise_fees_select_writer ON public.organization_franchise_fees
  FOR SELECT TO authenticated USING (true);
DO $m$ BEGIN
  IF (SELECT qual FROM pg_policies WHERE policyname='agent_commission_agreements_select_writer') <> 'true'
  THEN RAISE EXCEPTION 'MUTATION NOT APPLIED'; END IF; END $m$;
SELECT 'MUTATION APPLIED: both writer SELECT policies are USING (true)';
