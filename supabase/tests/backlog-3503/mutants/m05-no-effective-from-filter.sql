CREATE OR REPLACE FUNCTION public.split_agreement_in_force(
  p_organization_id uuid, p_agent_user_id uuid, p_on_date date DEFAULT current_date
) RETURNS SETOF public.agent_split_agreements LANGUAGE sql STABLE SET search_path = public
AS $fn$ SELECT a.* FROM public.agent_split_agreements a
   WHERE a.organization_id = p_organization_id AND a.agent_user_id = p_agent_user_id
   ORDER BY a.effective_from DESC, a.seq DESC LIMIT 1; $fn$;
CREATE OR REPLACE FUNCTION public.franchise_fee_in_force(p_organization_id uuid, p_on_date date DEFAULT current_date)
RETURNS SETOF public.organization_franchise_fees LANGUAGE sql STABLE SET search_path = public
AS $fn$ SELECT f.* FROM public.organization_franchise_fees f
   WHERE f.organization_id = p_organization_id ORDER BY f.effective_from DESC, f.seq DESC LIMIT 1; $fn$;
DO $m$ BEGIN
  IF position('p_on_date' in (SELECT prosrc FROM pg_proc WHERE oid='public.split_agreement_in_force(uuid,uuid,date)'::regprocedure)) > 0
  THEN RAISE EXCEPTION 'MUTATION NOT APPLIED'; END IF; END $m$;
SELECT 'MUTATION APPLIED: the effective_from <= p_on_date filter removed from both helpers';
