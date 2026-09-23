-- REBASED onto the current INSERT policy (BACKLOG-3503, founder ruling of
-- 2026-09-22). This mutant re-creates the policy, so it must carry the SUBJECT's
-- `AND m.license_status = 'active'` term forward; a copy taken from the
-- pre-ruling body would drop that term as a side effect and collect a C25 red
-- that says nothing about the unqualified column this mutant names. That is the
-- artifact class m11/m16/m17 were rebased out of, and the self-check below is
-- what keeps it from drifting back.
DROP POLICY agent_commission_agreements_insert_writer ON public.agent_commission_agreements;
CREATE POLICY agent_commission_agreements_insert_writer ON public.agent_commission_agreements
  FOR INSERT TO authenticated
  WITH CHECK (public.can_write_commission_agreements(agent_commission_agreements.organization_id)
              AND EXISTS (SELECT 1 FROM public.organization_members m
                           WHERE m.organization_id = organization_id
                             AND m.user_id = agent_commission_agreements.agent_user_id
                             AND m.license_status = 'active'));
DO $m$
DECLARE wc text;
BEGIN
  SELECT with_check INTO wc FROM pg_policies
   WHERE tablename='agent_commission_agreements'
     AND policyname='agent_commission_agreements_insert_writer';
  IF wc IS NULL THEN RAISE EXCEPTION 'MUTATION NOT APPLIED: no such policy'; END IF;
  IF position('m.organization_id = m.organization_id' in wc) = 0
  THEN RAISE EXCEPTION 'MUTATION NOT APPLIED: the unqualified column did not bind to the alias'; END IF;
  -- the terms this mutant does NOT mean to touch are still present
  IF position('license_status' in wc) = 0
   OR position('can_write_commission_agreements' in wc) = 0
   OR position('agent_user_id' in wc) = 0
  THEN RAISE EXCEPTION 'MUTATION NOT APPLIED: something else went missing too'; END IF;
END $m$;
SELECT 'MUTATION APPLIED: the EXISTS clause uses an UNQUALIFIED organization_id (binds to m.organization_id -- vacuously true)';
