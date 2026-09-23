-- The decision that was reversed: the own-row policy as a bare auth.uid() test,
-- with no membership term at all. A removed or deactivated agent keeps reading.
DROP POLICY agent_commission_agreements_select_own ON public.agent_commission_agreements;
CREATE POLICY agent_commission_agreements_select_own ON public.agent_commission_agreements
  FOR SELECT TO authenticated
  USING (agent_user_id = (SELECT auth.uid()));
DO $m$ BEGIN
  IF position('is_active_commission_member' in (SELECT qual FROM pg_policies
       WHERE policyname='agent_commission_agreements_select_own')) > 0
  THEN RAISE EXCEPTION 'MUTATION NOT APPLIED'; END IF; END $m$;
SELECT 'MUTATION APPLIED: the own-row policy reverted to the bare auth.uid() predicate';
