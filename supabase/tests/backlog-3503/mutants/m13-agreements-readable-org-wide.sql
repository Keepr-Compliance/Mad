DROP POLICY agent_commission_agreements_select_own ON public.agent_commission_agreements;
CREATE POLICY agent_commission_agreements_select_own ON public.agent_commission_agreements
  FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.organization_members m
                  WHERE m.organization_id = agent_commission_agreements.organization_id
                    AND m.user_id = (SELECT auth.uid())));
DO $m$ BEGIN
  IF position('organization_members' in (SELECT qual FROM pg_policies WHERE policyname='agent_commission_agreements_select_own')) = 0
  THEN RAISE EXCEPTION 'MUTATION NOT APPLIED'; END IF; END $m$;
SELECT 'MUTATION APPLIED: the own-row policy widened to any member of the org';
