-- Proves C17's sweep assertion (not just its named-site assertion) can fire: the
-- self-comparison is planted in the FRANCHISE select policy, so C17 assertions 1-3
-- pass and only the sweep can red.
DROP POLICY organization_franchise_fees_select_writer ON public.organization_franchise_fees;
CREATE POLICY organization_franchise_fees_select_writer ON public.organization_franchise_fees
  FOR SELECT TO authenticated
  USING (public.can_write_commission_agreements(organization_id)
         AND EXISTS (SELECT 1 FROM public.organization_members m
                      WHERE m.organization_id = m.organization_id
                        AND m.user_id = (SELECT auth.uid())));
DO $m$ BEGIN
  IF position('m.organization_id = m.organization_id' in
       (SELECT qual FROM pg_policies WHERE policyname='organization_franchise_fees_select_writer')) = 0
  THEN RAISE EXCEPTION 'MUTATION NOT APPLIED'; END IF; END $m$;
SELECT 'MUTATION APPLIED: a self-comparison planted in the franchise SELECT policy (a DIFFERENT site from C17 assertion 2)';
