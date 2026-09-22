-- The likeliest wrong version of this migration: the two
-- `REVOKE ALL ... FROM anon, authenticated` lines are simply not written.
-- Supabase's default ACL has already granted `arwdDxtm` on both new tables to
-- anon and authenticated, so this restores exactly the state the file would
-- leave behind. The column-list GRANT INSERT is additive on top of it.
GRANT ALL ON public.agent_commission_agreements TO anon, authenticated;
GRANT ALL ON public.organization_franchise_fees TO anon, authenticated;
DO $m$ BEGIN
  IF NOT (has_column_privilege('authenticated','public.agent_commission_agreements','set_by','INSERT')
      AND has_table_privilege('anon','public.agent_commission_agreements','SELECT')
      AND has_table_privilege('authenticated','public.organization_franchise_fees','DELETE'))
  THEN RAISE EXCEPTION 'MUTATION NOT APPLIED'; END IF; END $m$;
SELECT 'MUTATION APPLIED: REVOKE ALL omitted -- the default ACL grant stands on both tables';
