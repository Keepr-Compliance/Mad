-- The INSERT policy's date comparison becomes `<` instead of `<=`, so an
-- agreement dated EXACTLY the day of deactivation is refused.
--
-- An off-by-one at the boundary is the classic way this rule goes wrong, and it
-- is invisible to any control that samples the interior rather than sweeping the
-- edge. C27 places effective_from on the day before, ON the day, and the day
-- after, which is what separates the two spellings.
--
-- The founder's rule reads "falls inside the period that agent was active". The
-- day they were deactivated is a day they were active -- they worked that
-- morning -- so the boundary is INCLUSIVE and this mutant is wrong.
DROP POLICY agent_split_agreements_insert_writer ON public.agent_split_agreements;
CREATE POLICY agent_split_agreements_insert_writer
  ON public.agent_split_agreements FOR INSERT TO authenticated
  WITH CHECK (public.can_write_split_agreements(agent_split_agreements.organization_id)
              AND EXISTS (SELECT 1 FROM public.organization_members m
                           WHERE m.organization_id = agent_split_agreements.organization_id
                             AND m.user_id = agent_split_agreements.agent_user_id
                             AND (m.license_status = 'active'
                                  OR (m.license_status = 'suspended'
                                      AND m.deactivated_at IS NOT NULL
                                      AND agent_split_agreements.effective_from
                                            <  (m.deactivated_at AT TIME ZONE 'UTC')::date))));
DO $m$
DECLARE wc text;
BEGIN
  SELECT with_check INTO wc FROM pg_policies
   WHERE tablename='agent_split_agreements'
     AND policyname='agent_split_agreements_insert_writer';
  IF wc IS NULL THEN RAISE EXCEPTION 'MUTATION NOT APPLIED: no such policy'; END IF;
  IF position('<=' in wc) > 0
  THEN RAISE EXCEPTION 'MUTATION NOT APPLIED: the comparison is still inclusive'; END IF;
  IF position('deactivated_at' in wc) = 0
   OR position('IS NOT NULL' in wc) = 0
   OR position('''suspended''::text' in wc) = 0
   OR position('AT TIME ZONE' in wc) = 0
  THEN RAISE EXCEPTION 'MUTATION NOT APPLIED: something else went missing too'; END IF;
END $m$;
SELECT 'MUTATION APPLIED: an agreement dated ON the day of deactivation is now refused';
