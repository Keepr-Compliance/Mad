-- "An active member" instead of "an active member of THIS organization". An
-- agent who moved brokerages is still active somewhere, so the rule answers yes
-- and their old office's rows keep opening. Invisible to any control whose
-- removed agent belongs to no other organization -- which is why u_agent_gone is
-- also an active member of org B.
CREATE OR REPLACE FUNCTION public.is_active_split_member(p_org_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $fn$
  SELECT EXISTS (SELECT 1 FROM public.organization_members m
                  WHERE m.user_id = (SELECT auth.uid())
                    AND m.license_status = 'active');
$fn$;
DO $m$ BEGIN
  IF position('p_org_id' in (SELECT prosrc FROM pg_proc
       WHERE oid='public.is_active_split_member(uuid)'::regprocedure)) > 0
  THEN RAISE EXCEPTION 'MUTATION NOT APPLIED'; END IF; END $m$;
SELECT 'MUTATION APPLIED: the active-membership rule no longer checks the organization';
