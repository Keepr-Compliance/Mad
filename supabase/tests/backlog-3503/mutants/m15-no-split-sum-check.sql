ALTER TABLE public.agent_split_agreements DROP CONSTRAINT agent_split_agreements_split_sum_check;
DO $m$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname='agent_split_agreements_split_sum_check')
  THEN RAISE EXCEPTION 'MUTATION NOT APPLIED'; END IF; END $m$;
SELECT 'MUTATION APPLIED: the split-sum CHECK dropped';
