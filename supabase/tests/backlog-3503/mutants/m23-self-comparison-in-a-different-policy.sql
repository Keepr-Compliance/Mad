-- Proves C17's sweep assertion (not just its named-site assertion) can fire: the
-- self-comparison is planted in the broker/admin SELECT policy -- a policy C17's
-- named assertions never inspect (they check only the own-row and INSERT
-- policies) -- so C17 assertions 1-3 pass and only the sweep can red.
--
-- RETARGETED (BACKLOG-3503 fee trim, pm_comments 95992a3e): the original site was
-- organization_franchise_fees_select_writer, removed with that table. The
-- broker/admin SELECT policy on agent_split_agreements is the same class of
-- "different, unnamed site" now that only one table remains.
DROP POLICY agent_split_agreements_select_writer ON public.agent_split_agreements;
CREATE POLICY agent_split_agreements_select_writer ON public.agent_split_agreements
  FOR SELECT TO authenticated
  USING (public.can_write_split_agreements(organization_id)
         AND EXISTS (SELECT 1 FROM public.organization_members m
                      WHERE m.organization_id = m.organization_id
                        AND m.user_id = (SELECT auth.uid())));
DO $m$ BEGIN
  IF position('m.organization_id = m.organization_id' in
       (SELECT qual FROM pg_policies WHERE policyname='agent_split_agreements_select_writer')) = 0
  THEN RAISE EXCEPTION 'MUTATION NOT APPLIED'; END IF; END $m$;
SELECT 'MUTATION APPLIED: a self-comparison planted in the broker/admin SELECT policy (a DIFFERENT site from C17''s named assertions)';
