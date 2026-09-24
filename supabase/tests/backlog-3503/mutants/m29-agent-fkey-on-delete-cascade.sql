-- The founder's rule inverted: deleting a user silently takes their commission
-- history with them instead of refusing. Note what this does NOT change -- the
-- SQLSTATE a neighbouring table raises. With organization_members rows still
-- present, deleting the agent still fails 23503 (on the MEMBERSHIP key), so a
-- control asserting only the SQLSTATE stays green through this mutation. The
-- constraint name and the catalog's confdeltype are what see it.
ALTER TABLE public.agent_commission_agreements DROP CONSTRAINT agent_commission_agreements_agent_fkey;
ALTER TABLE public.agent_commission_agreements
  ADD CONSTRAINT agent_commission_agreements_agent_fkey
  FOREIGN KEY (agent_user_id) REFERENCES public.users(id) ON DELETE CASCADE;
DO $m$ BEGIN
  IF (SELECT confdeltype FROM pg_constraint WHERE conname = 'agent_commission_agreements_agent_fkey') <> 'c'
  THEN RAISE EXCEPTION 'MUTATION NOT APPLIED'; END IF; END $m$;
SELECT 'MUTATION APPLIED: agent foreign key rewritten ON DELETE CASCADE';
