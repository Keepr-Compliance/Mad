-- BACKLOG-3759 rollback: restores the read rules' roles and anon EXECUTE.
-- can_edit_checklist_templates needs nothing (the migration did not change it).
BEGIN;
ALTER POLICY transaction_submissions_select_public ON public.transaction_submissions TO public;
ALTER POLICY message_access_via_submission ON public.submission_messages TO public;
ALTER POLICY attachment_access_via_submission ON public.submission_attachments TO public;
GRANT EXECUTE ON FUNCTION public.can_review_submission(uuid) TO anon;
COMMIT;
