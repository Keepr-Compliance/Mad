-- BACKLOG-3364: take migration 1 back OFF a test venue.
--
-- For the venue only -- never production. Used after the one-transaction
-- mutant (which commits statements one at a time on purpose), and to put the
-- NAS back if migration 1 changes or BACKLOG-3364 is abandoned.
--
-- Restores the two replaced policies to production's text as of 2026-09-15
-- (pg_policies, read-only), drops everything migration 1 adds, and removes its
-- history row. Refuses if any personal organization exists, so it can never
-- silently erase the marker on real rows.

BEGIN;

SET LOCAL lock_timeout = '5s';

DO $refuse$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'public.organizations'::regclass
             AND attname = 'personal_owner_user_id' AND NOT attisdropped) THEN
    IF EXISTS (SELECT 1 FROM public.organizations WHERE personal_owner_user_id IS NOT NULL) THEN
      RAISE EXCEPTION 'teardown refused: personal organizations exist on this venue';
    END IF;
  END IF;
END
$refuse$;

DROP TRIGGER IF EXISTS retire_personal_membership ON public.organization_members;
DROP TRIGGER IF EXISTS guard_personal_owner_user_id ON public.organizations;
DROP FUNCTION IF EXISTS public._retire_personal_membership();
DROP FUNCTION IF EXISTS public._guard_personal_owner_user_id();
DROP FUNCTION IF EXISTS public.ensure_personal_organization();
DROP FUNCTION IF EXISTS public._ensure_personal_organization_for(uuid);

DROP POLICY IF EXISTS "agents_can_create_submissions" ON public.transaction_submissions;
CREATE POLICY "agents_can_create_submissions" ON public.transaction_submissions
  FOR INSERT TO public
  WITH CHECK ((submitted_by = ( SELECT auth.uid() AS uid)) AND (organization_id IN ( SELECT organization_members.organization_id
     FROM public.organization_members
    WHERE (organization_members.user_id = ( SELECT auth.uid() AS uid)))));

DROP POLICY IF EXISTS "Members can upload submission attachments" ON storage.objects;
CREATE POLICY "Members can upload submission attachments" ON storage.objects
  FOR INSERT TO public
  WITH CHECK ((bucket_id = 'submission-attachments'::text) AND (split_part(name, '/'::text, 1) IN ( SELECT (organization_members.organization_id)::text AS organization_id
     FROM public.organization_members
    WHERE (organization_members.user_id = auth.uid()))));

DROP INDEX IF EXISTS public.organizations_personal_owner_user_id_key;
ALTER TABLE public.organizations DROP COLUMN IF EXISTS personal_owner_user_id;

DELETE FROM supabase_migrations.schema_migrations WHERE version = '20260915160637';

COMMIT;
