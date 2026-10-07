DROP POLICY agent_split_agreements_select_writer ON public.agent_split_agreements;
CREATE POLICY agent_split_agreements_select_writer ON public.agent_split_agreements
  FOR SELECT TO authenticated USING (true);
DO $m$ BEGIN
  IF (SELECT qual FROM pg_policies WHERE policyname='agent_split_agreements_select_writer') <> 'true'
  THEN RAISE EXCEPTION 'MUTATION NOT APPLIED'; END IF; END $m$;
SELECT 'MUTATION APPLIED: the writer SELECT policy is USING (true)';
