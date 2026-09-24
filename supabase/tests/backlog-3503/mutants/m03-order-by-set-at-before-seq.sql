CREATE OR REPLACE FUNCTION public.commission_agreement_in_force(
  p_organization_id uuid, p_agent_user_id uuid, p_on_date date DEFAULT current_date
) RETURNS SETOF public.agent_commission_agreements LANGUAGE sql STABLE SET search_path = public
AS $fn$ SELECT a.* FROM public.agent_commission_agreements a
   WHERE a.organization_id = p_organization_id AND a.agent_user_id = p_agent_user_id
     AND a.effective_from <= p_on_date
   ORDER BY a.effective_from DESC, a.set_at DESC, a.seq DESC LIMIT 1; $fn$;
DO $m$ BEGIN
  IF position('set_at DESC' in (SELECT prosrc FROM pg_proc WHERE oid='public.commission_agreement_in_force(uuid,uuid,date)'::regprocedure)) = 0
  THEN RAISE EXCEPTION 'MUTATION NOT APPLIED'; END IF; END $m$;
SELECT 'MUTATION APPLIED: ORDER BY effective_from DESC, set_at DESC, seq DESC (the accepted-spec ordering)';
