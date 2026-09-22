CREATE OR REPLACE FUNCTION public.can_write_commission_agreements(p_org_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $fn$ SELECT EXISTS (SELECT 1 FROM public.organization_members m
                        WHERE m.organization_id = p_org_id AND m.user_id = (SELECT auth.uid())
                          AND m.role IN ('agent','broker','admin')); $fn$;
DO $m$ BEGIN
  IF position('''agent''' in (SELECT prosrc FROM pg_proc WHERE oid='public.can_write_commission_agreements(uuid)'::regprocedure)) = 0
  THEN RAISE EXCEPTION 'MUTATION NOT APPLIED'; END IF; END $m$;
SELECT 'MUTATION APPLIED: agent added to the writer role list -- an agent can set their own split';
