-- BACKLOG-3551: storage.objects policies for bucket 'submission-attachments'.
--
-- WHAT THIS DOES
--   * Replaces the bucket's SELECT policy. An object is readable (sign,
--     download, list) when path segment 2 is the id of a
--     public.transaction_submissions row the caller can see under that
--     table's own RLS, and path segment 1 equals that row's organization_id.
--     Object paths are <organization_id>/<submission_id>/<file>
--     (electron/services/supabaseStorageService.ts).
--   * Segment 2 is cast to uuid only inside a CASE that first matches the
--     8-4-4-4-12 hex shape; any other name yields NULL and matches no row.
--   * Removes the bucket's UPDATE and DELETE policies. No user-role UPDATE or
--     DELETE on this bucket is admitted after this migration; service_role
--     is unaffected.
--   * Leaves the INSERT policy ("Members can upload submission attachments")
--     unchanged.
--
-- DEPENDENCY (storage-api)
--   The desktop uploads objects BEFORE the transaction_submissions row exists
--   (upload with upsert:false). That upload passes this SELECT policy only
--   because storage-api's createObject is a bare INSERT with no RETURNING:
--   an INSERT ... RETURNING <columns> applies the SELECT policy to the new
--   row and would be refused (42501) while the submission row is absent.
--   Verified at storage-api 1.77.5 (production's version when this was
--   written): src/storage/uploader.ts canUpload -> database/pg.ts
--   createObject (bare INSERT), completion as superuser. Re-check this if the
--   storage-api version changes.
--
-- STATUS AT AUTHORING
--   NOT APPLIED to production. Production apply requires the founder's
--   explicit yes. The rollback script is kept outside the repository
--   (see BACKLOG-3551 in pm_comments).

BEGIN;

DROP POLICY IF EXISTS "Members can view submission attachments" ON storage.objects;
DROP POLICY IF EXISTS "Members can update submission attachments" ON storage.objects;
DROP POLICY IF EXISTS "Admins can delete submission attachments" ON storage.objects;
DROP POLICY IF EXISTS "Submission attachments follow their submission" ON storage.objects;

CREATE POLICY "Submission attachments follow their submission"
  ON storage.objects
  FOR SELECT
  USING (
    objects.bucket_id = 'submission-attachments'
    AND EXISTS (
      SELECT 1
      FROM public.transaction_submissions s
      WHERE s.id = CASE
                     WHEN split_part(objects.name, '/', 2)
                          ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
                     THEN split_part(objects.name, '/', 2)::uuid
                   END
        AND s.organization_id::text = split_part(objects.name, '/', 1)
    )
  );

COMMIT;
