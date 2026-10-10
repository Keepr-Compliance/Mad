-- BACKLOG-3843 preconditions. Runs after the 3679 and 3538 migrations and before
-- the 3843 file. A failure raises; the run reads ERROR (INVALID for a mutant).
DO $pre$ BEGIN
  -- the starting guard is production's (md5 read from production 2026-10-10)
  IF md5(pg_get_functiondef('public.guard_invite_acceptance()'::regprocedure)) <> 'a3eb55b807448a50e1c5f4228ef4e3b5' THEN
    RAISE EXCEPTION 'precondition: guard_invite_acceptance is not the production definition'; END IF;
  IF (SELECT tgtype FROM pg_trigger WHERE tgrelid='public.organization_members'::regclass AND tgname='guard_invite_acceptance') <> 19 THEN
    RAISE EXCEPTION 'precondition: member guard is not BEFORE UPDATE only'; END IF;
  IF EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid='public.organizations'::regclass AND tgname='guard_organization_client_update') THEN
    RAISE EXCEPTION 'precondition: organization guard already present'; END IF;
  IF NOT public.has_internal_role(pg_temp.uf()) OR NOT public.is_org_admin(pg_temp.uf(), pg_temp.id('org1')) THEN
    RAISE EXCEPTION 'precondition: u_f is not internal staff + O1 admin'; END IF;
  IF NOT has_table_privilege('authenticated', 'public.organizations', 'UPDATE')
     OR NOT has_table_privilege('authenticated', 'public.organization_members', 'INSERT') THEN
    RAISE EXCEPTION 'precondition: authenticated lacks the table grants production has'; END IF;
END $pre$;
