-- BACKLOG-3991 rollback: drop the three functions added by
-- supabase/migrations/20261019050000_backlog_3991_idp_names_and_member_name_edit.sql
-- and delete its ledger row, in one transaction. Nothing else changed and there is no
-- data to restore: the names written are identity-provider values or admin edits.
-- The portal callers treat a missing function as a swallowed error (sign-in continues;
-- the admin edit shows its generic failure).
DROP FUNCTION IF EXISTS public.sync_profile_names_from_idp(text, text, text);
DROP FUNCTION IF EXISTS public.set_member_name(uuid, text, text);
DROP FUNCTION IF EXISTS public.org_names_directory_managed(uuid);

DO $post$
BEGIN
  IF to_regprocedure('public.sync_profile_names_from_idp(text,text,text)') IS NOT NULL
     OR to_regprocedure('public.set_member_name(uuid,text,text)') IS NOT NULL
     OR to_regprocedure('public.org_names_directory_managed(uuid)') IS NOT NULL THEN
    RAISE EXCEPTION '3991 rollback post-check: a function is still present';
  END IF;
  IF to_regclass('supabase_migrations.schema_migrations') IS NOT NULL THEN
    DELETE FROM supabase_migrations.schema_migrations WHERE version = '20261019050000';
  END IF;
END $post$;
