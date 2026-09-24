GRANT SELECT ON public.agent_commission_agreements TO anon;
GRANT SELECT ON public.organization_franchise_fees TO anon;
GRANT EXECUTE ON FUNCTION public.commission_agreement_in_force(uuid,uuid,date) TO anon;
GRANT EXECUTE ON FUNCTION public.franchise_fee_in_force(uuid,date) TO anon;
CREATE POLICY agent_commission_agreements_select_anon ON public.agent_commission_agreements
  FOR SELECT TO anon USING (true);
CREATE POLICY organization_franchise_fees_select_anon ON public.organization_franchise_fees
  FOR SELECT TO anon USING (true);
DO $m$ BEGIN
  IF NOT has_table_privilege('anon','public.agent_commission_agreements','SELECT')
  THEN RAISE EXCEPTION 'MUTATION NOT APPLIED'; END IF; END $m$;
SELECT 'MUTATION APPLIED: anon granted SELECT + EXECUTE and given a USING (true) policy';
