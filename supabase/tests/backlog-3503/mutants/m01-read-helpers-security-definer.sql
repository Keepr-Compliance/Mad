ALTER FUNCTION public.commission_agreement_in_force(uuid,uuid,date) SECURITY DEFINER;
ALTER FUNCTION public.franchise_fee_in_force(uuid,date) SECURITY DEFINER;
DO $m$ BEGIN
  IF NOT ((SELECT prosecdef FROM pg_proc WHERE oid='public.commission_agreement_in_force(uuid,uuid,date)'::regprocedure)
      AND (SELECT prosecdef FROM pg_proc WHERE oid='public.franchise_fee_in_force(uuid,date)'::regprocedure))
  THEN RAISE EXCEPTION 'MUTATION NOT APPLIED'; END IF; END $m$;
SELECT 'MUTATION APPLIED: both read helpers marked SECURITY DEFINER';
