-- RESTRICT instead of NO ACTION. Behaviourally identical to every assertion
-- C19 makes -- same SQLSTATE, same constraint name -- and different in the one
-- way the catalog can see: RESTRICT cannot be deferred, so a future
-- SET CONSTRAINTS ... DEFERRED would silently not apply to it. This is the
-- mutant that gives C19's catalog line its own red, separate from the named
-- assertions above it.
ALTER TABLE public.agent_split_agreements DROP CONSTRAINT agent_split_agreements_org_fkey;
ALTER TABLE public.agent_split_agreements
  ADD CONSTRAINT agent_split_agreements_org_fkey
  FOREIGN KEY (organization_id) REFERENCES public.organizations(id) ON DELETE RESTRICT;
DO $m$ BEGIN
  IF (SELECT confdeltype FROM pg_constraint WHERE conname = 'agent_split_agreements_org_fkey') <> 'r'
  THEN RAISE EXCEPTION 'MUTATION NOT APPLIED'; END IF; END $m$;
SELECT 'MUTATION APPLIED: organization foreign key written ON DELETE RESTRICT, not NO ACTION';
