-- The whole member-EXISTS goes, so the SUBJECT is unchecked in every respect: a
-- broker can write for a removed agent, for a deactivated one, and for a person
-- who was never a member. This mutant carries no `license_status` term because it
-- carries no member check at all -- its C25 reds are that, not a rebase miss.
-- m36 is the narrow version that drops only the status term.
DROP POLICY agent_split_agreements_insert_writer ON public.agent_split_agreements;
CREATE POLICY agent_split_agreements_insert_writer ON public.agent_split_agreements
  FOR INSERT TO authenticated
  WITH CHECK (public.can_write_split_agreements(agent_split_agreements.organization_id));
DO $m$ BEGIN
  IF position('organization_members' in (SELECT with_check FROM pg_policies WHERE policyname='agent_split_agreements_insert_writer')) > 0
  THEN RAISE EXCEPTION 'MUTATION NOT APPLIED'; END IF; END $m$;
SELECT 'MUTATION APPLIED: the INSERT policy no longer requires the subject to be a member of the org';
