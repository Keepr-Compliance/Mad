ALTER FUNCTION public.split_agreement_in_force(uuid,uuid,date) SECURITY DEFINER;
DO $m$ BEGIN
  IF NOT (SELECT prosecdef FROM pg_proc WHERE oid='public.split_agreement_in_force(uuid,uuid,date)'::regprocedure)
  THEN RAISE EXCEPTION 'MUTATION NOT APPLIED'; END IF; END $m$;
SELECT 'MUTATION APPLIED: the read helper marked SECURITY DEFINER';
