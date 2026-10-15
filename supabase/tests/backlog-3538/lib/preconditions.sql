-- BACKLOG-3538 preconditions (C-2). Runs after the 3679 migration and before the
-- 3538 file. A failure raises, psql stops, and the run reads ERROR (INVALID for
-- a mutant): without these, k12 and k13 could pass without the 3538 file doing anything.
DO $pre$ BEGIN
  IF to_regprocedure('public.claim_pending_invite()') IS NULL THEN
    RAISE EXCEPTION 'precondition: public.claim_pending_invite() absent on this venue'; END IF;
  IF to_regprocedure('public.handle_new_user_invitation_link()') IS NULL THEN
    RAISE EXCEPTION 'precondition: public.handle_new_user_invitation_link() absent on this venue'; END IF;
  IF NOT has_function_privilege('anon', 'public.claim_pending_invite()', 'EXECUTE') THEN
    RAISE EXCEPTION 'precondition: anon cannot already execute claim_pending_invite()'; END IF;
  IF EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'auth.users'::regclass AND tgname = 'on_auth_user_created_link_invitations') THEN
    RAISE EXCEPTION 'precondition: trigger on_auth_user_created_link_invitations present on auth.users'; END IF;
  IF to_regprocedure('public.guard_invite_acceptance()') IS NULL THEN
    RAISE EXCEPTION 'precondition: 3679 guard not installed'; END IF;
  IF (SELECT joined_at FROM public.organization_members WHERE id = pg_temp.id('m_member')) IS DISTINCT FROM '2021-05-05 00:00:00+00'
     OR (SELECT joined_at FROM public.organization_members WHERE id = pg_temp.id('m_claimed')) IS DISTINCT FROM '2021-05-05 00:00:00+00' THEN
    RAISE EXCEPTION 'precondition: k14 fixture dates not in place'; END IF;
END $pre$;
