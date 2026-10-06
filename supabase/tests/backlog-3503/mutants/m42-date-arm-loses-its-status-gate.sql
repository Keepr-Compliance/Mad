-- The INSERT policy's date arm drops `m.license_status = 'suspended'`, so the
-- arm reads "any status at all, as long as deactivated_at is set and the date
-- fits".
--
-- It looks harmless, because only a suspension writes that column. It is not:
-- the trigger deliberately LEAVES the column alone on a move to 'expired', so a
-- member who was deactivated and then expired keeps their date. Without the
-- gate, that row is admitted. The same hole opens for any fifth value added to
-- organization_members_license_status_check later -- the exact fail-open this
-- file spells `= 'active'` rather than `NOT IN (...)` everywhere else to avoid.
--
-- C29 is the control: a subject at 'expired' carrying a deactivation date, with
-- an agreement dated inside the period. It must be refused.
DROP POLICY agent_split_agreements_insert_writer ON public.agent_split_agreements;
CREATE POLICY agent_split_agreements_insert_writer
  ON public.agent_split_agreements FOR INSERT TO authenticated
  WITH CHECK (public.can_write_split_agreements(agent_split_agreements.organization_id)
              AND EXISTS (SELECT 1 FROM public.organization_members m
                           WHERE m.organization_id = agent_split_agreements.organization_id
                             AND m.user_id = agent_split_agreements.agent_user_id
                             AND (m.license_status = 'active'
                                  OR (m.deactivated_at IS NOT NULL
                                      AND agent_split_agreements.effective_from
                                            <= (m.deactivated_at AT TIME ZONE 'UTC')::date))));
DO $m$
DECLARE wc text;
BEGIN
  SELECT with_check INTO wc FROM pg_policies
   WHERE tablename='agent_split_agreements'
     AND policyname='agent_split_agreements_insert_writer';
  IF wc IS NULL THEN RAISE EXCEPTION 'MUTATION NOT APPLIED: no such policy'; END IF;
  IF position('''suspended''::text' in wc) > 0
  THEN RAISE EXCEPTION 'MUTATION NOT APPLIED: the status gate is still on the date arm'; END IF;
  IF position('deactivated_at' in wc) = 0
   OR position('IS NOT NULL' in wc) = 0
   OR position('<=' in wc) = 0
   OR position('AT TIME ZONE' in wc) = 0
   OR position('''active''::text' in wc) = 0
  THEN RAISE EXCEPTION 'MUTATION NOT APPLIED: something else went missing too'; END IF;
END $m$;
SELECT 'MUTATION APPLIED: the date arm admits any status that carries a deactivation date';
