-- BACKLOG-4019 rollback (keepr-test only). Restores the three replaced functions and the four
-- policies to their pre-4019 text (functions: live bodies read 2026-10-21, md5
-- _billing_apply_org_entitlement 5608d9e3, can_review_submission d8f86fd1, finalize_submission
-- 6b2896ac; policies: 20261018230000 section 8), drops the new functions, and removes the ledger row.
-- No column was added, so none is dropped. Refuses while any deal is canceling or canceled (or
-- suspended with status_before_suspension 'canceling'): reset those deals first.
BEGIN;
DO $chk$
BEGIN
  IF EXISTS (SELECT 1 FROM public.org_deals WHERE status IN ('canceling', 'canceled') OR status_before_suspension = 'canceling') THEN
    RAISE EXCEPTION 'BACKLOG-4019 rollback: deals are canceling or canceled; reset them first';
  END IF;
END
$chk$;

CREATE OR REPLACE FUNCTION public._billing_apply_org_entitlement(p_org uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_deal public.org_deals%ROWTYPE;
  v_prior jsonb;
  v_fo jsonb;
  v_key text;
  v_cur jsonb;
  v_want jsonb;
  v_src constant text := 'brokerage_billing';
BEGIN
  SELECT * INTO v_deal FROM public.org_deals WHERE organization_id = p_org FOR UPDATE;
  IF NOT FOUND THEN
    RETURN;
  END IF;
  SELECT coalesce(op.feature_overrides, '{}'::jsonb) INTO v_fo
    FROM public.organization_plans op WHERE op.organization_id = p_org FOR UPDATE;
  IF NOT FOUND THEN
    RETURN;
  END IF;
  v_prior := coalesce(v_deal.entitlement_prior, '{}'::jsonb);

  FOREACH v_key IN ARRAY ARRAY['unlimited_transactions', 'broker_submission', 'broker_portal_access', 'account_suspended'] LOOP
    v_cur := v_fo -> v_key;
    IF v_cur IS NOT NULL AND coalesce(v_cur ->> 'source', '') <> v_src AND NOT (v_prior ? v_key) THEN
      v_prior := v_prior || jsonb_build_object(v_key, v_cur);
    END IF;

    v_want := CASE
      WHEN v_deal.status = 'suspended' AND v_key = 'account_suspended'
        THEN jsonb_build_object('enabled', true, 'source', v_src)
      WHEN v_deal.status = 'suspended'
        THEN jsonb_build_object('enabled', false, 'source', v_src)
      WHEN v_deal.status IN ('active', 'canceling') AND v_key = 'unlimited_transactions'
        THEN jsonb_build_object('enabled', true, 'source', v_src)
      ELSE NULL
    END;

    IF v_want IS NOT NULL THEN
      v_fo := v_fo || jsonb_build_object(v_key, v_want);
    ELSIF v_prior ? v_key THEN
      v_fo := v_fo || jsonb_build_object(v_key, v_prior -> v_key);
      v_prior := v_prior - v_key;
    ELSE
      v_fo := v_fo - v_key;
    END IF;
  END LOOP;

  UPDATE public.organization_plans SET feature_overrides = v_fo, updated_at = now()
   WHERE organization_id = p_org AND feature_overrides IS DISTINCT FROM v_fo;
  UPDATE public.org_deals SET entitlement_prior = v_prior
   WHERE organization_id = p_org AND entitlement_prior IS DISTINCT FROM v_prior;
END
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
       AND NOT public.org_billing_suspended(p_org_id)
  );
$function$;

CREATE OR REPLACE FUNCTION public.finalize_submission(p_submission_id uuid, p_manifest jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_sub public.transaction_submissions%ROWTYPE;
  v_target text;
  v_msgs uuid[];
  v_att jsonb := coalesce(p_manifest->'attachments', '[]'::jsonb);
  v_att_ids int;
  v_prefix text;
  v_msg_missing int; v_msg_extra int;
  v_att_missing int; v_att_extra int; v_obj_missing int; v_outside int; v_link_bad int;
  v_cl_expected int := nullif(p_manifest->>'checklists', '')::int;
  v_cl_found int := 0;
BEGIN
  IF v_uid IS NULL THEN RETURN jsonb_build_object('ok', false, 'code', 'not_authenticated'); END IF;
  SELECT * INTO v_sub FROM public.transaction_submissions WHERE id = p_submission_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'code', 'not_found'); END IF;
  IF v_sub.submitted_by <> v_uid THEN RETURN jsonb_build_object('ok', false, 'code', 'not_owner'); END IF;
  v_target := CASE WHEN v_sub.parent_submission_id IS NOT NULL THEN 'resubmitted' ELSE 'submitted' END;
  IF v_sub.status = v_target THEN RETURN jsonb_build_object('ok', true, 'already_final', true, 'status', v_target); END IF;
  -- BACKLOG-3853: no submission while the brokerage is suspended.
  IF public.org_billing_suspended(v_sub.organization_id) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'account_suspended');
  END IF;
  IF v_sub.status <> 'uploading' THEN RETURN jsonb_build_object('ok', false, 'code', 'not_uploading'); END IF;
  IF v_sub.abandoned_at IS NOT NULL THEN
    RETURN jsonb_build_object('ok', false, 'code', 'abandoned');
  END IF;

  SELECT coalesce(array_agg(DISTINCT x::uuid), '{}') INTO v_msgs
    FROM jsonb_array_elements_text(coalesce(p_manifest->'message_ids', '[]'::jsonb)) x;
  SELECT count(*) INTO v_msg_missing FROM unnest(v_msgs) d
   WHERE NOT EXISTS (SELECT 1 FROM public.submission_messages m WHERE m.id = d AND m.submission_id = p_submission_id);
  SELECT count(*) INTO v_msg_extra FROM public.submission_messages m
   WHERE m.submission_id = p_submission_id AND NOT (m.id = ANY(v_msgs));

  v_prefix := v_sub.organization_id::text || '/' || p_submission_id::text || '/';
  WITH d AS (
    SELECT (e->>'id')::uuid id, e->>'storage_path' path, nullif(e->>'message_id', '')::uuid message_id
      FROM jsonb_array_elements(v_att) e)
  SELECT count(*) FILTER (WHERE a.id IS NULL OR a.storage_path IS DISTINCT FROM d.path),
         count(*) FILTER (WHERE a.id IS NOT NULL AND (a.message_id IS DISTINCT FROM d.message_id
                                OR (d.message_id IS NOT NULL AND NOT (d.message_id = ANY(v_msgs))))),
         count(*) FILTER (WHERE d.path IS NULL OR left(d.path, length(v_prefix)) <> v_prefix),
         count(*) FILTER (WHERE NOT EXISTS (SELECT 1 FROM storage.objects o
                                WHERE o.bucket_id = 'submission-attachments' AND o.name = d.path)),
         count(DISTINCT d.id)
    INTO v_att_missing, v_link_bad, v_outside, v_obj_missing, v_att_ids
    FROM d LEFT JOIN public.submission_attachments a ON a.id = d.id AND a.submission_id = p_submission_id;
  SELECT count(*) INTO v_att_extra FROM public.submission_attachments a
   WHERE a.submission_id = p_submission_id
     AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_att) e WHERE (e->>'id')::uuid = a.id);

  IF v_cl_expected IS NOT NULL THEN
    SELECT count(*) INTO v_cl_found FROM public.submission_checklists c WHERE c.submission_id = p_submission_id;
  END IF;

  IF v_msg_missing + v_msg_extra + v_att_missing + v_att_extra + v_obj_missing + v_outside + v_link_bad > 0
     OR (v_cl_expected IS NOT NULL AND v_cl_found <> v_cl_expected) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'incomplete',
      'messages_missing', v_msg_missing, 'messages_extra', v_msg_extra,
      'attachment_rows_missing', v_att_missing, 'attachment_rows_extra', v_att_extra,
      'objects_missing', v_obj_missing, 'paths_outside_submission', v_outside,
      'attachment_message_links_wrong', v_link_bad,
      'checklists_expected', v_cl_expected, 'checklists_found', v_cl_found);
  END IF;

  UPDATE public.transaction_submissions
     SET status = v_target,
         message_count = cardinality(v_msgs),
         attachment_count = v_att_ids,
         submission_metadata = coalesce(submission_metadata, '{}'::jsonb)
                               || jsonb_build_object('finalized_by', 'finalize_submission')
   WHERE id = p_submission_id;

  INSERT INTO public.submission_attempts AS a
    (submission_id, user_id, organization_id, is_resubmit, outcome, stage, ended_at)
  VALUES
    (p_submission_id, v_uid, v_sub.organization_id, v_sub.parent_submission_id IS NOT NULL, 'committed', 'finalize', now())
  ON CONFLICT (submission_id) DO UPDATE
     SET outcome = 'committed', stage = 'finalize', reason_code = NULL, updated_at = now(), ended_at = now()
   WHERE a.user_id = v_uid;

  RETURN jsonb_build_object('ok', true, 'already_final', false, 'status', v_target);
END
$function$;

ALTER POLICY agents_can_create_submissions ON public.transaction_submissions
  WITH CHECK (
    (submitted_by = (SELECT auth.uid() AS uid))
    AND (organization_id IN (
      SELECT submitter.organization_id
        FROM (public.organization_members submitter
          JOIN public.organizations o ON ((o.id = submitter.organization_id)))
       WHERE ((submitter.user_id = (SELECT auth.uid() AS uid))
         AND (o.personal_owner_user_id IS NULL)
         AND public.member_status_grants_access((submitter.license_status)::text))))
    AND ((status)::text = ANY ((ARRAY['uploading'::character varying, 'submitted'::character varying])::text[]))
    AND (reviewed_by IS NULL) AND (reviewed_at IS NULL) AND (review_notes IS NULL)
    AND (NOT public.org_billing_suspended(organization_id))
  );

ALTER POLICY transaction_submissions_update_public ON public.transaction_submissions
  USING (
    ((submitted_by = (SELECT auth.uid() AS uid)) AND ((status)::text = 'uploading'::text) AND (abandoned_at IS NULL))
    OR (((status)::text = ANY ((ARRAY['submitted'::character varying, 'resubmitted'::character varying, 'under_review'::character varying])::text[]))
        AND (organization_id IN (
          SELECT reviewer_using.organization_id
            FROM public.organization_members reviewer_using
           WHERE ((reviewer_using.user_id = (SELECT auth.uid() AS uid))
             AND ((reviewer_using.role)::text = ANY ((ARRAY['broker'::character varying, 'admin'::character varying])::text[]))
             AND public.member_status_grants_access((reviewer_using.license_status)::text))))
        AND (NOT public.org_billing_suspended(organization_id)))
  )
  WITH CHECK (
    ((submitted_by = (SELECT auth.uid() AS uid))
      AND ((status)::text = ANY ((ARRAY['resubmitted'::character varying, 'uploading'::character varying, 'submitted'::character varying])::text[]))
      AND (((status)::text = 'uploading'::text) OR (NOT public.org_billing_suspended(organization_id))))
    OR (((status)::text <> 'uploading'::text)
        AND (organization_id IN (
          SELECT reviewer_check.organization_id
            FROM public.organization_members reviewer_check
           WHERE ((reviewer_check.user_id = (SELECT auth.uid() AS uid))
             AND ((reviewer_check.role)::text = ANY ((ARRAY['broker'::character varying, 'admin'::character varying])::text[]))
             AND public.member_status_grants_access((reviewer_check.license_status)::text))))
        AND (NOT public.org_billing_suspended(organization_id)))
  );

ALTER POLICY users_can_create_comments ON public.submission_comments
  WITH CHECK (
    (user_id = (SELECT auth.uid() AS uid))
    AND (submission_id IN (
      SELECT transaction_submissions.id
        FROM public.transaction_submissions
       WHERE (((transaction_submissions.submitted_by = (SELECT auth.uid() AS uid))
           OR (transaction_submissions.organization_id IN (
             SELECT commenter.organization_id
               FROM public.organization_members commenter
              WHERE ((commenter.user_id = (SELECT auth.uid() AS uid))
                AND ((commenter.role)::text = ANY ((ARRAY['broker'::character varying, 'admin'::character varying])::text[]))
                AND public.member_status_grants_access((commenter.license_status)::text)))))
         AND (NOT public.org_billing_suspended(transaction_submissions.organization_id)))))
  );

ALTER POLICY "Members can upload submission attachments" ON storage.objects
  WITH CHECK (
    (bucket_id = 'submission-attachments'::text)
    AND (split_part(name, '/'::text, 1) IN (
      SELECT (uploader.organization_id)::text AS organization_id
        FROM (public.organization_members uploader
          JOIN public.organizations o ON ((o.id = uploader.organization_id)))
       WHERE ((uploader.user_id = auth.uid())
         AND (o.personal_owner_user_id IS NULL)
         AND public.member_status_grants_access((uploader.license_status)::text)
         AND (NOT public.org_billing_suspended(uploader.organization_id)))))
  );

DROP FUNCTION public.broker_get_plan_end(uuid);
DROP FUNCTION public.set_org_auto_renew(uuid, boolean, text, integer);
DROP FUNCTION public._billing_set_auto_renew(uuid, boolean, text, uuid, text, integer);
DROP FUNCTION public._billing_end_org_deal(uuid, text, text);
DROP FUNCTION public._org_auto_renew_caller(uuid);
DROP FUNCTION public.org_billing_service_off(uuid);
DELETE FROM supabase_migrations.schema_migrations WHERE version = '20261020220000';
COMMIT;
