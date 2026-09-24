-- The single most common real migration mistake: the policies are written and
-- the row-level security switch is never thrown, so every policy is inert.
-- Reproduces SR plan review probe B (agreements table only).
ALTER TABLE public.agent_commission_agreements DISABLE ROW LEVEL SECURITY;
DO $m$ BEGIN
  IF (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.agent_commission_agreements'::regclass)
  THEN RAISE EXCEPTION 'MUTATION NOT APPLIED'; END IF; END $m$;
SELECT 'MUTATION APPLIED: ENABLE ROW LEVEL SECURITY missing on agent_commission_agreements';
