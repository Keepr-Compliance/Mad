-- BACKLOG-3547: the transaction_submissions INSERT rule now requires a
-- pre-review status and empty reviewer fields.
--
-- Every existing condition of agents_can_create_submissions is kept verbatim
-- (copied from pg_policies, 2026-09-27) and ANDed with:
--   * status IN ('uploading', 'submitted')
--       'uploading' - what the desktop inserts today (submissionService.ts
--                     sets it before the insert; the first release doing so
--                     is v2.2.0). Resubmits insert 'uploading' too and move
--                     to 'resubmitted' by a later UPDATE.
--       'submitted' - deliberately admitted. It is the column default, so any
--                     insert that omits status is checked as 'submitted';
--                     desktop v2.0/v2.1 insert it directly; and the UPDATE
--                     policy already lets a submitter move their own
--                     'uploading' row to 'submitted'. Removing it would break
--                     those callers and gain nothing.
--       A NULL status is refused (the WITH CHECK is not true for NULL).
--   * reviewed_by, reviewed_at, review_notes all NULL.
--
-- Not constrained here, on purpose:
--   * status_history - already forced empty on a non-service insert by the
--     status_history_append_only trigger (BACKLOG-3477).
--   * commission_offered_rate, commission_actual_rate, commission_gross_amount,
--     commission_adjustment_reason, split_agreement_id - arrive with a separate
--     migration and are set by the desktop at submit time.
--   * review_deadline - a deadline, not a review outcome.
--
-- The service role is unaffected: service_role_full_access_submissions is a
-- FOR ALL policy, and policies are ORed.
--
-- Idempotent: DROP POLICY IF EXISTS + CREATE POLICY.

DROP POLICY IF EXISTS agents_can_create_submissions ON public.transaction_submissions;

CREATE POLICY agents_can_create_submissions ON public.transaction_submissions
  FOR INSERT
  WITH CHECK (
    (submitted_by = ( SELECT auth.uid() AS uid))
    AND (organization_id IN ( SELECT om.organization_id
           FROM (organization_members om
             JOIN organizations o ON ((o.id = om.organization_id)))
          WHERE ((om.user_id = ( SELECT auth.uid() AS uid)) AND (o.personal_owner_user_id IS NULL))))
    AND ((status)::text = ANY (ARRAY['uploading'::text, 'submitted'::text]))
    AND (reviewed_by IS NULL)
    AND (reviewed_at IS NULL)
    AND (review_notes IS NULL)
  );
