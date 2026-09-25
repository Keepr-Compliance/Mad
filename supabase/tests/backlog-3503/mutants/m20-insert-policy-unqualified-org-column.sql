-- REBASED TWICE onto the current INSERT policy (BACKLOG-3503: the founder's
-- ruling of 2026-09-22, then its refinement of 2026-09-23). This mutant
-- re-creates the policy, so it must carry the WHOLE subject clause forward --
-- both the active arm and the active-period date arm. A copy taken from an
-- earlier body drops what it does not mention and collects reds that say nothing
-- about the unqualified column this mutant names.
--
-- MEASURED, at the refinement: left on the pre-refinement body this mutant
-- reddened c17 c25 c27 c28 c29. Carried forward it reds c17 ALONE, which is the
-- whole point of it. That is the artifact class m11/m16/m17 were rebased out of,
-- and the self-check below is what keeps it from drifting back.
DROP POLICY agent_split_agreements_insert_writer ON public.agent_split_agreements;
CREATE POLICY agent_split_agreements_insert_writer ON public.agent_split_agreements
  FOR INSERT TO authenticated
  WITH CHECK (public.can_write_split_agreements(agent_split_agreements.organization_id)
              AND EXISTS (SELECT 1 FROM public.organization_members m
                           WHERE m.organization_id = organization_id
                             AND m.user_id = agent_split_agreements.agent_user_id
                             AND (m.license_status = 'active'
                                  OR (m.license_status = 'suspended'
                                      AND m.deactivated_at IS NOT NULL
                                      AND agent_split_agreements.effective_from
                                            <= (m.deactivated_at AT TIME ZONE 'UTC')::date))));
DO $m$
DECLARE wc text;
BEGIN
  SELECT with_check INTO wc FROM pg_policies
   WHERE tablename='agent_split_agreements'
     AND policyname='agent_split_agreements_insert_writer';
  IF wc IS NULL THEN RAISE EXCEPTION 'MUTATION NOT APPLIED: no such policy'; END IF;
  IF position('m.organization_id = m.organization_id' in wc) = 0
  THEN RAISE EXCEPTION 'MUTATION NOT APPLIED: the unqualified column did not bind to the alias'; END IF;
  -- the terms this mutant does NOT mean to touch are still present
  IF position('license_status' in wc) = 0
   OR position('can_write_split_agreements' in wc) = 0
   OR position('agent_user_id' in wc) = 0
   OR position('deactivated_at' in wc) = 0
   OR position('IS NOT NULL' in wc) = 0
   OR position('AT TIME ZONE' in wc) = 0
   OR position('<=' in wc) = 0
   OR position('''suspended''::text' in wc) = 0
  THEN RAISE EXCEPTION 'MUTATION NOT APPLIED: something else went missing too'; END IF;
END $m$;
SELECT 'MUTATION APPLIED: the EXISTS clause uses an UNQUALIFIED organization_id (binds to m.organization_id -- vacuously true)';
