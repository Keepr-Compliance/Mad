-- REBASED onto the shipped helper body (SR impl review, pm_comments b60c8ffb).
-- The first version replaced a PRE-RULING body, so TWO of its three reds (c23,
-- c24) were about the license_status term it silently dropped rather than about
-- it_admin. Rebased it reds c04 alone -- the right signature for a role-list
-- mistake, and the one that shows the rebase does not leave this mutant vacuous.
CREATE OR REPLACE FUNCTION public.can_write_split_agreements(p_org_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $fn$ SELECT EXISTS (SELECT 1 FROM public.organization_members m
                        WHERE m.organization_id = p_org_id AND m.user_id = (SELECT auth.uid())
                          AND m.role IN ('broker','admin','it_admin')
                          AND m.license_status = 'active'); $fn$;
DO $m$
DECLARE src text;
BEGIN
  SELECT prosrc INTO src FROM pg_proc WHERE oid='public.can_write_split_agreements(uuid)'::regprocedure;
  IF position('it_admin' in src) = 0 THEN RAISE EXCEPTION 'MUTATION NOT APPLIED'; END IF;
  IF position('license_status' in src) = 0
  THEN RAISE EXCEPTION 'MUTATION NOT APPLIED: the status term went with it'; END IF;
  IF position('m.organization_id = p_org_id' in src) = 0
  THEN RAISE EXCEPTION 'MUTATION NOT APPLIED: the org term went with it'; END IF;
END $m$;
SELECT 'MUTATION APPLIED: it_admin added to the writer role list (3473s list, copied by mistake)';
