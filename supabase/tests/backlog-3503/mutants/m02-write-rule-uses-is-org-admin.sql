CREATE OR REPLACE FUNCTION public.can_write_commission_agreements(p_org_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $fn$ SELECT public.is_org_admin((SELECT auth.uid()), p_org_id); $fn$;
DO $m$ BEGIN
  IF position('is_org_admin' in (SELECT prosrc FROM pg_proc WHERE oid='public.can_write_commission_agreements(uuid)'::regprocedure)) = 0
  THEN RAISE EXCEPTION 'MUTATION NOT APPLIED'; END IF; END $m$;
SELECT 'MUTATION APPLIED: the write rule delegates to is_org_admin() (admits it_admin, excludes broker)';
