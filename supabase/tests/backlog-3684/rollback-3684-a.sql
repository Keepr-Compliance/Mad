-- BACKLOG-3684 rollback of file A (20261016075118). Removes the three functions file A
-- added (new objects only). Refuses while file B is in force: run rollback-3684-b.sql first.

DO $pre$
BEGIN
  IF (SELECT qual FROM pg_policies WHERE schemaname = 'public' AND tablename = 'organization_members'
        AND policyname = 'users_can_view_own_invite') = 'false'
     OR (SELECT md5(prosrc) FROM pg_proc
          WHERE oid = 'public.auto_provision_it_admin(text,text,text)'::regprocedure)
        IS DISTINCT FROM '0ca68b8cee9820322274e1f1a4817b0a' THEN
    RAISE EXCEPTION '3684 rollback A refused: file B is in force; run rollback-3684-b.sql first';
  END IF;
END $pre$;

DROP FUNCTION IF EXISTS public.accept_invitation(text, text);
DROP FUNCTION IF EXISTS public.caller_has_pending_invite();
DROP FUNCTION IF EXISTS public._invite_bind_tenant(uuid, text);
