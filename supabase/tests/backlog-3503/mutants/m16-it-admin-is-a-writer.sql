CREATE OR REPLACE FUNCTION public.can_write_commission_agreements(p_org_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $fn$ SELECT EXISTS (SELECT 1 FROM public.organization_members m
                        WHERE m.organization_id = p_org_id AND m.user_id = (SELECT auth.uid())
                          AND m.role IN ('broker','admin','it_admin')); $fn$;
DO $m$ BEGIN
  IF position('it_admin' in (SELECT prosrc FROM pg_proc WHERE oid='public.can_write_commission_agreements(uuid)'::regprocedure)) = 0
  THEN RAISE EXCEPTION 'MUTATION NOT APPLIED'; END IF; END $m$;
SELECT 'MUTATION APPLIED: it_admin added to the writer role list (3473s list, copied by mistake)';
