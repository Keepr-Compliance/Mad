-- can_write_commission_agreements is one of the migration's two SECURITY DEFINER
-- objects -- is_active_commission_member is the other -- and this mutant touches
-- only the first. Without `SET search_path = public` its body resolves in
-- whatever search path the caller brings. Behaviourally invisible in this
-- harness; only the catalog sees it.
--
-- It ALTERs the existing function rather than replacing its body, so it carries
-- whatever body the shipped file has -- including the license_status term. That
-- is why it does not red C23/C24, and it is a reason to keep it an ALTER.
ALTER FUNCTION public.can_write_commission_agreements(uuid) RESET search_path;
DO $m$ BEGIN
  IF (SELECT proconfig FROM pg_proc WHERE oid = 'public.can_write_commission_agreements(uuid)'::regprocedure) IS NOT NULL
  THEN RAISE EXCEPTION 'MUTATION NOT APPLIED'; END IF; END $m$;
SELECT 'MUTATION APPLIED: SET search_path dropped from the SECURITY DEFINER write rule';
