CREATE POLICY organization_franchise_fees_select_member ON public.organization_franchise_fees
  FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.organization_members m
                  WHERE m.organization_id = organization_franchise_fees.organization_id
                    AND m.user_id = (SELECT auth.uid())));
DO $m$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname='organization_franchise_fees_select_member')
  THEN RAISE EXCEPTION 'MUTATION NOT APPLIED'; END IF; END $m$;
SELECT 'MUTATION APPLIED: every member of the org can read the franchise fee (the deferred M1 decision, turned ON)';
