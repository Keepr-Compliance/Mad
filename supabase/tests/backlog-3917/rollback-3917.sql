-- BACKLOG-3917 rollback: restores the definitions that production had before
-- 20261014100000_backlog_3917_member_status_allow_list.sql (read from production
-- 2026-10-13) and removes public.member_status_grants_access(text).
-- CREATE OR REPLACE keeps each function's grants. Run as one transaction.
BEGIN;

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
  );
$function$;

CREATE OR REPLACE FUNCTION public.get_user_org_ids(user_uuid uuid)
 RETURNS SETOF uuid
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT organization_id FROM organization_members WHERE user_id = user_uuid;
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
         )
     AND COALESCE((public.check_feature_access(p_org_id, 'transaction_checklists') ->> 'allowed')::boolean, false);
$function$;

ALTER POLICY admins_can_modify_org ON public.organizations
  USING ((id IN ( SELECT organization_members.organization_id
   FROM organization_members
  WHERE ((organization_members.user_id = ( SELECT auth.uid() AS uid)) AND ((organization_members.role)::text = ANY (ARRAY[('admin'::character varying)::text, ('it_admin'::character varying)::text]))))));

ALTER POLICY transaction_submissions_update_public ON public.transaction_submissions
  USING ((((submitted_by = ( SELECT auth.uid() AS uid)) AND ((status)::text = 'uploading'::text) AND (abandoned_at IS NULL)) OR (((status)::text = ANY (ARRAY['submitted'::text, 'resubmitted'::text, 'under_review'::text])) AND (organization_id IN ( SELECT organization_members.organization_id
   FROM organization_members
  WHERE ((organization_members.user_id = ( SELECT auth.uid() AS uid)) AND ((organization_members.role)::text = ANY (ARRAY[('broker'::character varying)::text, ('admin'::character varying)::text]))))))))
  WITH CHECK ((((submitted_by = ( SELECT auth.uid() AS uid)) AND ((status)::text = ANY (ARRAY['resubmitted'::text, 'uploading'::text, 'submitted'::text]))) OR (((status)::text <> 'uploading'::text) AND (organization_id IN ( SELECT organization_members.organization_id
   FROM organization_members
  WHERE ((organization_members.user_id = ( SELECT auth.uid() AS uid)) AND ((organization_members.role)::text = ANY (ARRAY[('broker'::character varying)::text, ('admin'::character varying)::text]))))))));

ALTER POLICY agents_can_create_submissions ON public.transaction_submissions
  WITH CHECK (((submitted_by = ( SELECT auth.uid() AS uid)) AND (organization_id IN ( SELECT om.organization_id
   FROM (organization_members om
     JOIN organizations o ON ((o.id = om.organization_id)))
  WHERE ((om.user_id = ( SELECT auth.uid() AS uid)) AND (o.personal_owner_user_id IS NULL)))) AND ((status)::text = ANY (ARRAY['uploading'::text, 'submitted'::text])) AND (reviewed_by IS NULL) AND (reviewed_at IS NULL) AND (review_notes IS NULL)));

ALTER POLICY users_can_create_comments ON public.submission_comments
  WITH CHECK (((user_id = ( SELECT auth.uid() AS uid)) AND (submission_id IN ( SELECT transaction_submissions.id
   FROM transaction_submissions
  WHERE ((transaction_submissions.submitted_by = ( SELECT auth.uid() AS uid)) OR (transaction_submissions.organization_id IN ( SELECT organization_members.organization_id
           FROM organization_members
          WHERE ((organization_members.user_id = ( SELECT auth.uid() AS uid)) AND ((organization_members.role)::text = ANY (ARRAY[('broker'::character varying)::text, ('admin'::character varying)::text]))))))))));

ALTER POLICY comment_access_via_submission ON public.submission_comments
  USING (((submission_id IN ( SELECT transaction_submissions.id
   FROM transaction_submissions
  WHERE ((transaction_submissions.submitted_by = ( SELECT auth.uid() AS uid)) OR (transaction_submissions.organization_id IN ( SELECT organization_members.organization_id
           FROM organization_members
          WHERE ((organization_members.user_id = ( SELECT auth.uid() AS uid)) AND ((organization_members.role)::text = ANY (ARRAY[('broker'::character varying)::text, ('admin'::character varying)::text])))))))) AND ((is_internal = false) OR (submission_id IN ( SELECT ts.id
   FROM (transaction_submissions ts
     JOIN organization_members om ON ((ts.organization_id = om.organization_id)))
  WHERE ((om.user_id = ( SELECT auth.uid() AS uid)) AND ((om.role)::text = ANY (ARRAY[('broker'::character varying)::text, ('admin'::character varying)::text]))))))));

ALTER POLICY users_select_public ON public.users
  USING ((has_internal_role(( SELECT auth.uid() AS uid)) OR (id IN ( SELECT om.user_id
   FROM organization_members om
  WHERE ((om.organization_id IN ( SELECT organization_members.organization_id
           FROM organization_members
          WHERE (organization_members.user_id = ( SELECT auth.uid() AS uid)))) AND (om.user_id IS NOT NULL)))) OR (( SELECT auth.uid() AS uid) = id)));

ALTER POLICY "Members can upload submission attachments" ON storage.objects
  WITH CHECK (((bucket_id = 'submission-attachments'::text) AND (split_part(name, '/'::text, 1) IN ( SELECT (om.organization_id)::text AS organization_id
   FROM (organization_members om
     JOIN organizations o ON ((o.id = om.organization_id)))
  WHERE ((om.user_id = auth.uid()) AND (o.personal_owner_user_id IS NULL))))));

ALTER POLICY "IT admins can manage identity providers" ON public.organization_identity_providers
  USING ((EXISTS ( SELECT 1
   FROM organization_members om
  WHERE ((om.organization_id = organization_identity_providers.organization_id) AND (om.user_id = ( SELECT auth.uid() AS uid)) AND ((om.role)::text = 'it_admin'::text) AND ((om.license_status)::text = 'active'::text)))));

ALTER POLICY "Org admins can view identity providers" ON public.organization_identity_providers
  USING ((EXISTS ( SELECT 1
   FROM organization_members om
  WHERE ((om.organization_id = organization_identity_providers.organization_id) AND (om.user_id = ( SELECT auth.uid() AS uid)) AND ((om.role)::text = ANY (ARRAY[('admin'::character varying)::text, ('it_admin'::character varying)::text])) AND ((om.license_status)::text = 'active'::text)))));

ALTER POLICY "IT admins can manage SCIM tokens" ON public.scim_tokens
  USING ((EXISTS ( SELECT 1
   FROM organization_members om
  WHERE ((om.organization_id = scim_tokens.organization_id) AND (om.user_id = ( SELECT auth.uid() AS uid)) AND ((om.role)::text = 'it_admin'::text) AND ((om.license_status)::text = 'active'::text)))));

ALTER POLICY "Admins can view SCIM sync logs" ON public.scim_sync_log
  USING ((EXISTS ( SELECT 1
   FROM organization_members om
  WHERE ((om.organization_id = scim_sync_log.organization_id) AND (om.user_id = ( SELECT auth.uid() AS uid)) AND ((om.role)::text = ANY (ARRAY[('admin'::character varying)::text, ('it_admin'::character varying)::text])) AND ((om.license_status)::text = 'active'::text)))));

DROP FUNCTION public.member_status_grants_access(text);

COMMIT;
