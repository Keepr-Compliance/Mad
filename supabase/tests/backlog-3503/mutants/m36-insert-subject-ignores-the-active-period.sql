-- The INSERT policy's member-EXISTS drops the WHOLE subject test -- both the
-- active arm and the date arm -- leaving only "is a member of this org at all".
--
-- This is the direct reversal of the founder's rule: with it, a broker can
-- record an agreement for a deactivated agent dated ANY date, including long
-- after they left. The refinement of 2026-09-23 loosened this clause on one
-- axis (a backdated agreement inside the active period is now allowed); this
-- mutant loosens it on the OTHER axis too, which is the mistake the refinement
-- is most likely to be confused with.
--
-- A REMOVED subject keeps failing either way -- there is no membership row for
-- the EXISTS to find -- so the half that goes quiet is exactly the half nothing
-- else in the suite watches. That was measured, not assumed: before C25 existed,
-- SR's msr01 probe moved this dimension and reddened NONE of the 25 controls
-- then present.
--
-- Everything else in the policy is left exactly as shipped, and the self-check
-- asserts that, so this mutant's RED set is evidence about the subject clause
-- and nothing else.
DROP POLICY agent_split_agreements_insert_writer ON public.agent_split_agreements;
CREATE POLICY agent_split_agreements_insert_writer
  ON public.agent_split_agreements FOR INSERT TO authenticated
  WITH CHECK (public.can_write_split_agreements(agent_split_agreements.organization_id)
              AND EXISTS (SELECT 1 FROM public.organization_members m
                           WHERE m.organization_id = agent_split_agreements.organization_id
                             AND m.user_id = agent_split_agreements.agent_user_id
));
DO $m$
DECLARE wc text;
BEGIN
  SELECT with_check INTO wc FROM pg_policies
   WHERE tablename='agent_split_agreements'
     AND policyname='agent_split_agreements_insert_writer';
  IF wc IS NULL THEN RAISE EXCEPTION 'MUTATION NOT APPLIED: no such policy'; END IF;
  IF position('license_status' in wc) > 0
  THEN RAISE EXCEPTION 'MUTATION NOT APPLIED: the subject status terms are still in the policy'; END IF;
  IF position('deactivated_at' in wc) > 0
  THEN RAISE EXCEPTION 'MUTATION NOT APPLIED: the date arm is still in the policy'; END IF;
  IF position('can_write_split_agreements' in wc) = 0
   OR position('agent_user_id' in wc) = 0
   OR position('organization_members' in wc) = 0
   OR position('m.organization_id = agent_split_agreements.organization_id' in wc) = 0
  THEN RAISE EXCEPTION 'MUTATION NOT APPLIED: something else went missing too'; END IF;
END $m$;
SELECT 'MUTATION APPLIED: the INSERT policy no longer tests the AGENT SUBJECT beyond bare membership';
