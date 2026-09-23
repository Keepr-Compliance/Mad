-- The INSERT policy's member-EXISTS drops `AND m.license_status = 'active'` --
-- the term the founder ruled IN on 2026-09-22 (pm_comments on BACKLOG-3503), so
-- a broker can once again record an agreement FOR a deactivated agent.
--
-- This is the most likely WRONG implementation of that ruling, and the likeliest
-- regression afterwards: the term is one line in a clause that reads as being
-- about membership rather than about status, and an edit tidying the EXISTS drops
-- it without meaning to. The REMOVED subject keeps failing either way -- there is
-- no membership row to find -- so the half that goes quiet is exactly the half
-- nothing else in the suite watches.
--
-- Its ancestor is SR's `msr01` probe (pm_comments 8efcd82e), which measured the
-- INVERSE mutation -- ADDING the term, back when the shipped policy had none --
-- against the 25 controls that existed before C25: RED: NONE. The whole suite
-- stayed green and a reviewer reading the log would have concluded nothing moved.
-- C25 exists because of that silence, and this mutant is its red in the direction
-- the ruling left open.
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
                             AND m.user_id = agent_commission_agreements.agent_user_id));
DO $m$
DECLARE wc text;
BEGIN
  SELECT with_check INTO wc FROM pg_policies
   WHERE tablename='agent_commission_agreements'
     AND policyname='agent_commission_agreements_insert_writer';
  IF wc IS NULL THEN RAISE EXCEPTION 'MUTATION NOT APPLIED: no such policy'; END IF;
  IF position('license_status' in wc) > 0
  THEN RAISE EXCEPTION 'MUTATION NOT APPLIED: the subject status term is still in the policy'; END IF;
  -- and the rest of the policy is intact: a mutant that also dropped the write
  -- rule or the member check would red for a different reason.
  IF position('can_write_commission_agreements' in wc) = 0
   OR position('agent_user_id' in wc) = 0
   OR position('organization_members' in wc) = 0
   OR position('m.organization_id = agent_commission_agreements.organization_id' in wc) = 0
  THEN RAISE EXCEPTION 'MUTATION NOT APPLIED: something else went missing too'; END IF;
END $m$;
SELECT 'MUTATION APPLIED: the INSERT policy no longer requires the AGENT SUBJECT to be an active member';
