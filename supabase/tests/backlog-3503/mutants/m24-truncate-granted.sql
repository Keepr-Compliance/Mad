-- The one thing the eighteen behavioural controls of PLAN REVIEW could not see,
-- which is why C18 exists and why this mutant is its red. TRUNCATE is a
-- table-level operation; row-level security never evaluates it. `REVOKE ALL` is
-- what removes it (the `D` in the default ACL's `arwdDxtm`); any narrower
-- revoke, or a later migration that re-grants, leaves it behind.
GRANT TRUNCATE ON public.agent_split_agreements TO authenticated;
GRANT TRUNCATE ON public.organization_franchise_fees TO authenticated;
DO $m$ BEGIN
  IF NOT (has_table_privilege('authenticated','public.agent_split_agreements','TRUNCATE')
      AND has_table_privilege('authenticated','public.organization_franchise_fees','TRUNCATE'))
  THEN RAISE EXCEPTION 'MUTATION NOT APPLIED'; END IF; END $m$;
SELECT 'MUTATION APPLIED: TRUNCATE granted to authenticated on both tables';
