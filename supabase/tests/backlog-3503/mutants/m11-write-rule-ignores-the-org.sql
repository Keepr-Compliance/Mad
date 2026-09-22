CREATE OR REPLACE FUNCTION public.can_write_commission_agreements(p_org_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $fn$ SELECT EXISTS (SELECT 1 FROM public.organization_members m
                        WHERE m.user_id = (SELECT auth.uid()) AND m.role IN ('broker','admin')); $fn$;
DO $m$ BEGIN
  IF position('m.organization_id' in (SELECT prosrc FROM pg_proc WHERE oid='public.can_write_commission_agreements(uuid)'::regprocedure)) > 0
  THEN RAISE EXCEPTION 'MUTATION NOT APPLIED'; END IF; END $m$;
SELECT 'MUTATION APPLIED: the write rule no longer checks WHICH org the caller is a broker of';
