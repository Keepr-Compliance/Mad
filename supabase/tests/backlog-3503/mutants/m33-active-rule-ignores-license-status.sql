-- The narrower, likelier miss: the membership term is there but the
-- license_status filter is not. A REMOVED agent is shut out (their row is gone)
-- and a DEACTIVATED one is not -- which is the half of the ruling that is a soft
-- delete, and the half no count of policies would reveal.
CREATE OR REPLACE FUNCTION public.is_active_split_member(p_org_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $fn$
  SELECT EXISTS (SELECT 1 FROM public.organization_members m
                  WHERE m.organization_id = p_org_id
                    AND m.user_id = (SELECT auth.uid()));
$fn$;
DO $m$ BEGIN
  IF position('license_status' in (SELECT prosrc FROM pg_proc
       WHERE oid='public.is_active_split_member(uuid)'::regprocedure)) > 0
  THEN RAISE EXCEPTION 'MUTATION NOT APPLIED'; END IF; END $m$;
SELECT 'MUTATION APPLIED: the active-membership rule no longer checks license_status';
