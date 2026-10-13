-- BACKLOG-3917: organization membership grants access only while its
-- license_status is on an allow-list.
--
-- 1. public.member_status_grants_access(text): true only for a status on the
--    allow-list. Today the list is ('active'). Every other value, NULL
--    included, returns false.
-- 2. The membership helpers below keep their signatures, SECURITY DEFINER
--    flag, search_path, volatility and grants (CREATE OR REPLACE keeps the
--    ACL), and now count a membership row only when the helper returns true:
--      is_org_admin(uuid, uuid)
--      can_review_submission(uuid)
--      get_user_org_ids(uuid)
--      can_edit_checklist_templates(uuid)
--      can_create_own_checklist_templates(uuid)
-- 3. Row-level policies that read organization_members directly apply the
--    same helper to the caller's own membership row:
--      organizations.admins_can_modify_org
--      transaction_submissions.transaction_submissions_update_public
--      transaction_submissions.agents_can_create_submissions
--      submission_comments.users_can_create_comments
--      submission_comments.comment_access_via_submission
--      users.users_select_public
--      storage.objects "Members can upload submission attachments"
--      organization_identity_providers (2 policies), scim_tokens,
--      scim_sync_log (these already required 'active'; they now call the helper)
-- Roles and commands of every policy are unchanged; only the expressions are
-- restated. No data changes. organizations_select_public is not changed.
--
-- Apply as one transaction. No BEGIN/COMMIT here.

-- ---------------------------------------------------------------------------
-- 1. The allow-list
-- ---------------------------------------------------------------------------
-- Intentionally callable by anon: row-level policies that apply TO public are evaluated as anon for signed-out requests and call this function
CREATE OR REPLACE FUNCTION public.member_status_grants_access(p_license_status text)
 RETURNS boolean
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO ''
AS $function$
  SELECT COALESCE(p_license_status IN ('active'), false);
$function$;

REVOKE ALL ON FUNCTION public.member_status_grants_access(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.member_status_grants_access(text) TO anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 2. Membership helpers
-- ---------------------------------------------------------------------------
-- Intentionally callable by anon: existing grant kept unchanged; organization_members policies that apply TO public call it
CREATE OR REPLACE FUNCTION public.is_org_admin(user_uuid uuid, org_uuid uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT EXISTS (
    SELECT 1 FROM organization_members
    WHERE user_id = user_uuid
    AND organization_id = org_uuid
    AND role IN ('admin', 'it_admin')
    AND public.member_status_grants_access(license_status)
  );
$function$;

CREATE OR REPLACE FUNCTION public.can_review_submission(p_org_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  SELECT EXISTS (
    SELECT 1
      FROM public.organization_members om
     WHERE om.organization_id = p_org_id
       AND om.user_id = (SELECT auth.uid())
       AND om.role IN ('broker', 'admin', 'it_admin')
       AND public.member_status_grants_access(om.license_status)
  );
$function$;

-- Intentionally callable by anon: existing grant kept unchanged; organization_members policies that apply TO public call it
CREATE OR REPLACE FUNCTION public.get_user_org_ids(user_uuid uuid)
 RETURNS SETOF uuid
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT organization_id FROM organization_members
   WHERE user_id = user_uuid
     AND public.member_status_grants_access(license_status);
$function$;

CREATE OR REPLACE FUNCTION public.can_edit_checklist_templates(p_org_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT EXISTS (
           SELECT 1
             FROM public.organization_members m
             JOIN public.organizations o ON o.id = m.organization_id
            WHERE m.organization_id = p_org_id
              AND m.user_id = (SELECT auth.uid())
              AND public.member_status_grants_access(m.license_status)
              AND (m.role IN ('broker', 'admin', 'it_admin')
                   OR o.personal_owner_user_id = m.user_id)
         )
     AND COALESCE((public.check_feature_access(p_org_id, 'transaction_checklists') ->> 'allowed')::boolean, false);
$function$;

CREATE OR REPLACE FUNCTION public.can_create_own_checklist_templates(p_org_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT EXISTS (
           SELECT 1
             FROM public.organization_members m
            WHERE m.organization_id = p_org_id
              AND m.user_id = (SELECT auth.uid())
              AND public.member_status_grants_access(m.license_status)
         )
     AND COALESCE((public.check_feature_access(p_org_id, 'transaction_checklists') ->> 'allowed')::boolean, false);
$function$;

-- ---------------------------------------------------------------------------
-- 3. Policies
-- ---------------------------------------------------------------------------
ALTER POLICY admins_can_modify_org ON public.organizations
  USING (id IN (
    SELECT org_admin.organization_id
      FROM public.organization_members org_admin
     WHERE org_admin.user_id = (SELECT auth.uid())
       AND org_admin.role IN ('admin', 'it_admin')
       AND public.member_status_grants_access(org_admin.license_status)));

ALTER POLICY transaction_submissions_update_public ON public.transaction_submissions
  USING (
    (submitted_by = (SELECT auth.uid()) AND status = 'uploading' AND abandoned_at IS NULL)
    OR (status IN ('submitted', 'resubmitted', 'under_review')
        AND organization_id IN (
          SELECT reviewer_using.organization_id
            FROM public.organization_members reviewer_using
           WHERE reviewer_using.user_id = (SELECT auth.uid())
             AND reviewer_using.role IN ('broker', 'admin')
             AND public.member_status_grants_access(reviewer_using.license_status))))
  WITH CHECK (
    (submitted_by = (SELECT auth.uid()) AND status IN ('resubmitted', 'uploading', 'submitted'))
    OR (status <> 'uploading'
        AND organization_id IN (
          SELECT reviewer_check.organization_id
            FROM public.organization_members reviewer_check
           WHERE reviewer_check.user_id = (SELECT auth.uid())
             AND reviewer_check.role IN ('broker', 'admin')
             AND public.member_status_grants_access(reviewer_check.license_status))));

ALTER POLICY agents_can_create_submissions ON public.transaction_submissions
  WITH CHECK (
    submitted_by = (SELECT auth.uid())
    AND organization_id IN (
      SELECT submitter.organization_id
        FROM public.organization_members submitter
        JOIN public.organizations o ON o.id = submitter.organization_id
       WHERE submitter.user_id = (SELECT auth.uid())
         AND o.personal_owner_user_id IS NULL
         AND public.member_status_grants_access(submitter.license_status))
    AND status IN ('uploading', 'submitted')
    AND reviewed_by IS NULL
    AND reviewed_at IS NULL
    AND review_notes IS NULL);

ALTER POLICY users_can_create_comments ON public.submission_comments
  WITH CHECK (
    user_id = (SELECT auth.uid())
    AND submission_id IN (
      SELECT transaction_submissions.id
        FROM public.transaction_submissions
       WHERE transaction_submissions.submitted_by = (SELECT auth.uid())
          OR transaction_submissions.organization_id IN (
               SELECT commenter.organization_id
                 FROM public.organization_members commenter
                WHERE commenter.user_id = (SELECT auth.uid())
                  AND commenter.role IN ('broker', 'admin')
                  AND public.member_status_grants_access(commenter.license_status))));

ALTER POLICY comment_access_via_submission ON public.submission_comments
  USING (
    submission_id IN (
      SELECT transaction_submissions.id
        FROM public.transaction_submissions
       WHERE transaction_submissions.submitted_by = (SELECT auth.uid())
          OR transaction_submissions.organization_id IN (
               SELECT comment_reader.organization_id
                 FROM public.organization_members comment_reader
                WHERE comment_reader.user_id = (SELECT auth.uid())
                  AND comment_reader.role IN ('broker', 'admin')
                  AND public.member_status_grants_access(comment_reader.license_status)))
    AND (is_internal = false
         OR submission_id IN (
              SELECT ts.id
                FROM public.transaction_submissions ts
                JOIN public.organization_members internal_reader ON ts.organization_id = internal_reader.organization_id
               WHERE internal_reader.user_id = (SELECT auth.uid())
                 AND internal_reader.role IN ('broker', 'admin')
                 AND public.member_status_grants_access(internal_reader.license_status))));

ALTER POLICY users_select_public ON public.users
  USING (
    public.has_internal_role((SELECT auth.uid()))
    OR id IN (
      SELECT om.user_id
        FROM public.organization_members om
       WHERE om.organization_id IN (
               SELECT colleague_org.organization_id
                 FROM public.organization_members colleague_org
                WHERE colleague_org.user_id = (SELECT auth.uid())
                  AND public.member_status_grants_access(colleague_org.license_status))
         AND om.user_id IS NOT NULL)
    OR (SELECT auth.uid()) = id);

ALTER POLICY "Members can upload submission attachments" ON storage.objects
  WITH CHECK (
    bucket_id = 'submission-attachments'
    AND split_part(name, '/', 1) IN (
      SELECT uploader.organization_id::text
        FROM public.organization_members uploader
        JOIN public.organizations o ON o.id = uploader.organization_id
       WHERE uploader.user_id = auth.uid()
         AND o.personal_owner_user_id IS NULL
         AND public.member_status_grants_access(uploader.license_status)));

ALTER POLICY "IT admins can manage identity providers" ON public.organization_identity_providers
  USING (EXISTS (
    SELECT 1
      FROM public.organization_members idp_manager
     WHERE idp_manager.organization_id = organization_identity_providers.organization_id
       AND idp_manager.user_id = (SELECT auth.uid())
       AND idp_manager.role = 'it_admin'
       AND public.member_status_grants_access(idp_manager.license_status)));

ALTER POLICY "Org admins can view identity providers" ON public.organization_identity_providers
  USING (EXISTS (
    SELECT 1
      FROM public.organization_members idp_viewer
     WHERE idp_viewer.organization_id = organization_identity_providers.organization_id
       AND idp_viewer.user_id = (SELECT auth.uid())
       AND idp_viewer.role IN ('admin', 'it_admin')
       AND public.member_status_grants_access(idp_viewer.license_status)));

ALTER POLICY "IT admins can manage SCIM tokens" ON public.scim_tokens
  USING (EXISTS (
    SELECT 1
      FROM public.organization_members token_manager
     WHERE token_manager.organization_id = scim_tokens.organization_id
       AND token_manager.user_id = (SELECT auth.uid())
       AND token_manager.role = 'it_admin'
       AND public.member_status_grants_access(token_manager.license_status)));

ALTER POLICY "Admins can view SCIM sync logs" ON public.scim_sync_log
  USING (EXISTS (
    SELECT 1
      FROM public.organization_members log_viewer
     WHERE log_viewer.organization_id = scim_sync_log.organization_id
       AND log_viewer.user_id = (SELECT auth.uid())
       AND log_viewer.role IN ('admin', 'it_admin')
       AND public.member_status_grants_access(log_viewer.license_status)));
