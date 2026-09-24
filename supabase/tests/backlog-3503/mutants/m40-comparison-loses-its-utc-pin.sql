-- The INSERT policy's date comparison drops `AT TIME ZONE 'UTC'` and truncates
-- with a bare `::date` instead.
--
-- On a UTC connection this mutant is BEHAVIOURALLY IDENTICAL to the shipped
-- rule, and production runs UTC everywhere today. That is precisely why it is
-- here: the shipped spelling's value is that it does not DEPEND on that, and a
-- control which cannot tell the two apart would let the pin be deleted with no
-- red anywhere. C27 runs its boundary arm under an explicit non-UTC
-- `SET LOCAL TimeZone`, which is the only condition that separates them.
--
-- If this mutant ever reports RED: NONE, the sweep has lost its non-UTC arm --
-- treat that as a broken control, not as a redundant pin.
DROP POLICY agent_commission_agreements_insert_writer ON public.agent_commission_agreements;
CREATE POLICY agent_commission_agreements_insert_writer
  ON public.agent_commission_agreements FOR INSERT TO authenticated
  WITH CHECK (public.can_write_commission_agreements(agent_commission_agreements.organization_id)
              AND EXISTS (SELECT 1 FROM public.organization_members m
                           WHERE m.organization_id = agent_commission_agreements.organization_id
                             AND m.user_id = agent_commission_agreements.agent_user_id
                             AND (m.license_status = 'active'
                                  OR (m.license_status = 'suspended'
                                      AND m.deactivated_at IS NOT NULL
                                      AND agent_commission_agreements.effective_from
                                            <= m.deactivated_at::date))));
DO $m$
DECLARE wc text;
BEGIN
  SELECT with_check INTO wc FROM pg_policies
   WHERE tablename='agent_commission_agreements'
     AND policyname='agent_commission_agreements_insert_writer';
  IF wc IS NULL THEN RAISE EXCEPTION 'MUTATION NOT APPLIED: no such policy'; END IF;
  IF position('timezone' in lower(wc)) > 0
  THEN RAISE EXCEPTION 'MUTATION NOT APPLIED: the UTC pin is still in the policy'; END IF;
  IF position('IS NOT NULL' in wc) = 0
   OR position('suspended' in wc) = 0
   OR position('<=' in wc) = 0
  THEN RAISE EXCEPTION 'MUTATION NOT APPLIED: something else went missing too'; END IF;
END $m$;
SELECT 'MUTATION APPLIED: the date comparison resolves against the SESSION timezone, not UTC';
