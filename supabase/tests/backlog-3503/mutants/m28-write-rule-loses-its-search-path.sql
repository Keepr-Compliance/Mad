-- can_write_commission_agreements is the only SECURITY DEFINER object in the
-- migration. Without `SET search_path = public` its body resolves in whatever
-- search path the caller brings. Behaviourally invisible in this harness --
-- only the catalog sees it.
ALTER FUNCTION public.can_write_commission_agreements(uuid) RESET search_path;
DO $m$ BEGIN
  IF (SELECT proconfig FROM pg_proc WHERE oid = 'public.can_write_commission_agreements(uuid)'::regprocedure) IS NOT NULL
  THEN RAISE EXCEPTION 'MUTATION NOT APPLIED'; END IF; END $m$;
SELECT 'MUTATION APPLIED: SET search_path dropped from the SECURITY DEFINER write rule';
