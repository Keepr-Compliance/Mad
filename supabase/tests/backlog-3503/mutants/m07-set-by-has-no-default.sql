ALTER TABLE public.agent_split_agreements ALTER COLUMN set_by DROP DEFAULT;
DO $m$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='agent_split_agreements'
             AND column_name='set_by' AND column_default IS NOT NULL)
  THEN RAISE EXCEPTION 'MUTATION NOT APPLIED'; END IF; END $m$;
SELECT 'MUTATION APPLIED: set_by DEFAULT auth.uid() dropped';
