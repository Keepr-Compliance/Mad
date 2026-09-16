-- BACKLOG-3364 venue seed: production's submission-attachments bucket and its
-- four storage.objects policies, as they stand BEFORE migration 1.
--
-- Transcribed from production (read-only, pg_policies / storage.buckets,
-- 2026-09-15). The venue's schema baseline carries no storage rows or storage
-- policies, so without this seed migration 1's DROP / CREATE on the upload
-- policy would run against nothing and the storage controls would test nothing.
--
-- This is venue STATE, not a test fixture: it stands for what production already
-- has, and it stays on the venue. Idempotent: an existing bucket or policy is
-- left alone, so re-running it on a venue where migration 1 has replaced the
-- upload policy does not put the old upload policy back.
--
-- After seeding, lib/gate-catalog.sql's `pol:storage.objects:submission-attachments-unchanged`
-- and `policy:s3` rows must equal production's (lib/gate-expected.txt).
--
-- Run as the stack's `postgres` role (it holds BYPASSRLS, and
-- supautils.policy_grants lists storage.objects for it, as on production).

BEGIN;

INSERT INTO storage.buckets (id, name, owner, public, avif_autodetection, file_size_limit, allowed_mime_types, owner_id)
VALUES ('submission-attachments', 'submission-attachments', NULL, false, false, NULL, NULL, NULL)
ON CONFLICT (id) DO NOTHING;

DO $seed$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'storage' AND tablename = 'objects'
                 AND policyname = 'Admins can delete submission attachments') THEN
    CREATE POLICY "Admins can delete submission attachments" ON storage.objects
      FOR DELETE TO public
      USING ((bucket_id = 'submission-attachments'::text) AND (split_part(name, '/'::text, 1) IN ( SELECT (organization_members.organization_id)::text AS organization_id
         FROM public.organization_members
        WHERE ((organization_members.user_id = auth.uid()) AND ((organization_members.role)::text = ANY ((ARRAY['admin'::character varying, 'it_admin'::character varying])::text[]))))));
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'storage' AND tablename = 'objects'
                 AND policyname = 'Members can update submission attachments') THEN
    CREATE POLICY "Members can update submission attachments" ON storage.objects
      FOR UPDATE TO public
      USING ((bucket_id = 'submission-attachments'::text) AND (split_part(name, '/'::text, 1) IN ( SELECT (organization_members.organization_id)::text AS organization_id
         FROM public.organization_members
        WHERE (organization_members.user_id = auth.uid()))));
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'storage' AND tablename = 'objects'
                 AND policyname = 'Members can upload submission attachments') THEN
    CREATE POLICY "Members can upload submission attachments" ON storage.objects
      FOR INSERT TO public
      WITH CHECK ((bucket_id = 'submission-attachments'::text) AND (split_part(name, '/'::text, 1) IN ( SELECT (organization_members.organization_id)::text AS organization_id
         FROM public.organization_members
        WHERE (organization_members.user_id = auth.uid()))));
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'storage' AND tablename = 'objects'
                 AND policyname = 'Members can view submission attachments') THEN
    CREATE POLICY "Members can view submission attachments" ON storage.objects
      FOR SELECT TO public
      USING ((bucket_id = 'submission-attachments'::text) AND (split_part(name, '/'::text, 1) IN ( SELECT (organization_members.organization_id)::text AS organization_id
         FROM public.organization_members
        WHERE (organization_members.user_id = auth.uid()))));
  END IF;
END
$seed$;

COMMIT;
