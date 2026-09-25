ALTER TABLE public.agent_split_agreements DROP CONSTRAINT agent_split_agreements_split_sum_check;
ALTER TABLE public.agent_split_agreements DROP CONSTRAINT agent_split_agreements_office_fee_cadence_check;
ALTER TABLE public.agent_split_agreements DROP CONSTRAINT agent_split_agreements_office_fee_amount_check;
ALTER TABLE public.organization_franchise_fees  DROP CONSTRAINT organization_franchise_fees_amount_check;
DO $m$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname='agent_split_agreements_split_sum_check')
  THEN RAISE EXCEPTION 'MUTATION NOT APPLIED'; END IF; END $m$;
SELECT 'MUTATION APPLIED: split-sum, cadence and both non-negative CHECKs dropped';
