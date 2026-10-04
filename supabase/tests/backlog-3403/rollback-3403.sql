-- BACKLOG-3403 rollback: returns the catalogue to the state before
-- 20261004192647_backlog_3403_finalize_submission.sql (policy text transcribed
-- from production pg_policies on 2026-10-04). Run as ONE transaction.
-- Drops public.submission_attempts and every row in it.

DROP POLICY IF EXISTS "Submitters can delete attachments of their abandoned upload" ON storage.objects;

DROP POLICY IF EXISTS transaction_submissions_update_public ON public.transaction_submissions;
CREATE POLICY transaction_submissions_update_public ON public.transaction_submissions
  FOR UPDATE
  USING (
    ((submitted_by = (SELECT auth.uid() AS uid)) AND ((status)::text = 'uploading'::text))
    OR (((status)::text = ANY (ARRAY['submitted'::text, 'resubmitted'::text, 'under_review'::text]))
        AND (organization_id IN (SELECT organization_members.organization_id
                                   FROM public.organization_members
                                  WHERE ((organization_members.user_id = (SELECT auth.uid() AS uid))
                                    AND ((organization_members.role)::text = ANY (ARRAY[('broker'::character varying)::text, ('admin'::character varying)::text])))))))
  WITH CHECK (
    ((submitted_by = (SELECT auth.uid() AS uid)) AND ((status)::text = ANY (ARRAY['resubmitted'::text, 'uploading'::text, 'submitted'::text])))
    OR (organization_id IN (SELECT organization_members.organization_id
                              FROM public.organization_members
                             WHERE ((organization_members.user_id = (SELECT auth.uid() AS uid))
                               AND ((organization_members.role)::text = ANY (ARRAY[('broker'::character varying)::text, ('admin'::character varying)::text]))))));

DROP POLICY IF EXISTS agents_can_delete_own_attachments ON public.submission_attachments;
CREATE POLICY agents_can_delete_own_attachments ON public.submission_attachments
  FOR DELETE
  USING (submission_id IN (
    SELECT transaction_submissions.id
      FROM public.transaction_submissions
     WHERE ((transaction_submissions.submitted_by = (SELECT auth.uid() AS uid))
       AND ((transaction_submissions.status)::text = 'uploading'::text))));

DROP POLICY IF EXISTS agents_can_insert_attachments ON public.submission_attachments;
CREATE POLICY agents_can_insert_attachments ON public.submission_attachments
  FOR INSERT
  WITH CHECK (submission_id IN (
    SELECT transaction_submissions.id
      FROM public.transaction_submissions
     WHERE (transaction_submissions.submitted_by = (SELECT auth.uid() AS uid))));

DROP POLICY IF EXISTS agents_can_insert_messages ON public.submission_messages;
CREATE POLICY agents_can_insert_messages ON public.submission_messages
  FOR INSERT
  WITH CHECK (submission_id IN (
    SELECT transaction_submissions.id
      FROM public.transaction_submissions
     WHERE (transaction_submissions.submitted_by = (SELECT auth.uid() AS uid))));

DROP FUNCTION IF EXISTS public.finalize_submission(uuid, jsonb);
DROP FUNCTION IF EXISTS public.record_submission_attempt(uuid, uuid, text, text, text, integer, jsonb, boolean, text, text);
DROP TABLE IF EXISTS public.submission_attempts;

DROP INDEX IF EXISTS public.submission_attachments_submission_id_idx;
DROP INDEX IF EXISTS public.submission_messages_submission_id_idx;
