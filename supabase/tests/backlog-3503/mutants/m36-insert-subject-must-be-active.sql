-- SR's `msr01` probe (pm_comments 8efcd82e), promoted into the shipped suite.
--
-- The most likely WRONG implementation of this migration, given the founder has
-- just ruled that deactivation removes an agent's read: somebody "completes" the
-- ruling by adding the status term to the INSERT policy's member-EXISTS as well,
-- so a broker can no longer record anything for a deactivated agent. Measured by
-- SR against the 24 controls that existed before C25: RED: NONE. The whole suite
-- stayed green and a reviewer reading the log would have concluded nothing moved.
--
-- Everything else in the policy is left exactly as shipped, and the self-check
-- below asserts that, so this mutant's RED set is evidence about the subject's
-- status term and nothing else.
DROP POLICY agent_commission_agreements_insert_writer ON public.agent_commission_agreements;
CREATE POLICY agent_commission_agreements_insert_writer
  ON public.agent_commission_agreements FOR INSERT TO authenticated
  WITH CHECK (public.can_write_commission_agreements(agent_commission_agreements.organization_id)
              AND EXISTS (SELECT 1 FROM public.organization_members m
                           WHERE m.organization_id = agent_commission_agreements.organization_id
                             AND m.user_id = agent_commission_agreements.agent_user_id
                             AND m.license_status = 'active'));
DO $m$
DECLARE wc text;
BEGIN
  SELECT with_check INTO wc FROM pg_policies
   WHERE tablename='agent_commission_agreements'
     AND policyname='agent_commission_agreements_insert_writer';
  IF wc IS NULL THEN RAISE EXCEPTION 'MUTATION NOT APPLIED: no such policy'; END IF;
  IF position('license_status' in wc) = 0
  THEN RAISE EXCEPTION 'MUTATION NOT APPLIED: the subject status term is not in the policy'; END IF;
  -- and the rest of the policy is intact: a mutant that also dropped the write
  -- rule or the subject term would red for a different reason.
  IF position('can_write_commission_agreements' in wc) = 0
   OR position('agent_user_id' in wc) = 0
   OR position('organization_members' in wc) = 0
  THEN RAISE EXCEPTION 'MUTATION NOT APPLIED: something else went missing too'; END IF;
END $m$;
SELECT 'MUTATION APPLIED: the INSERT policy now requires the AGENT SUBJECT to be an active member';
