-- The same omission across both ALTER TABLE lines -- which is the likelier
-- shape, since the two lines sit together and are deleted or forgotten together.
ALTER TABLE public.agent_split_agreements DISABLE ROW LEVEL SECURITY;
ALTER TABLE public.organization_franchise_fees  DISABLE ROW LEVEL SECURITY;
DO $m$ BEGIN
  IF (SELECT bool_or(relrowsecurity) FROM pg_class
       WHERE oid IN ('public.agent_split_agreements'::regclass,
                     'public.organization_franchise_fees'::regclass))
  THEN RAISE EXCEPTION 'MUTATION NOT APPLIED'; END IF; END $m$;
SELECT 'MUTATION APPLIED: ENABLE ROW LEVEL SECURITY missing on BOTH tables';
