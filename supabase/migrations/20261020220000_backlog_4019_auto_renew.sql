-- BACKLOG-4019: brokerage deal auto-renew switch.
--
-- Turning auto-renew off sets the deal to 'canceling' (or, on a suspended deal, its
-- status_before_suspension) and bumps the version in ONE update, so the org_deals trigger queues
-- exactly one sync_org_subscription row; the sync sends cancel_at_period_end to Stripe. When the
-- subscription ends (webhook, or the payment-reconcile backstop) _billing_end_org_deal sets the
-- deal 'canceled'. A canceled brokerage's service ends IN THE DATABASE (founder Q1 = A): every
-- submission/review gate that refused a suspended brokerage now refuses a canceled one too, and
-- the entitlement turns Unlimited, broker_submission and broker_portal_access off. No suspended
-- banners (org_billing_suspended is unchanged). Checklists, members, invites, credit unlocks
-- and the per-export purchase stay open (they read org_billing_suspended).
--
-- Who may switch it (founder Q2): Keepr staff with billing.manage, the brokerage's active Admin,
-- and its billing contact (licensed or the billing-only login). One caller helper decides for
-- every writer and reader. Brokerage callers are refused while the deal is suspended.
-- A brokerage turning it off queues an account-manager alert (notify_account_manager,
-- reason auto_renew_off).
--
-- No new column. CREATE OR REPLACE / ALTER POLICY only; new objects are new.
-- Rollback (keepr-test): supabase/tests/backlog-4019/rollback.sql.

DO $pre$
DECLARE
  v_md5 text;
  v_q text;
  v_w text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM supabase_migrations.schema_migrations WHERE version = '20261020200000') THEN
    RAISE EXCEPTION 'BACKLOG-4019: migration 20261020200000 (BACKLOG-4007 People v2) must be applied first';
  END IF;

  -- Functions this file replaces: the live body, or this file's own (re-run).
  SELECT md5(pg_get_functiondef('public._billing_apply_org_entitlement(uuid)'::regprocedure)) INTO v_md5;
  IF v_md5 <> '5608d9e338ee7e6badc9786ca7ba7448'
     AND position('BACKLOG-4019' IN pg_get_functiondef('public._billing_apply_org_entitlement(uuid)'::regprocedure)) = 0 THEN
    RAISE EXCEPTION 'BACKLOG-4019: _billing_apply_org_entitlement changed (md5 %)', v_md5;
  END IF;
  SELECT md5(pg_get_functiondef('public.can_review_submission(uuid)'::regprocedure)) INTO v_md5;
  IF v_md5 <> 'd8f86fd1942035f8902f3761db93b08d'
     AND position('BACKLOG-4019' IN pg_get_functiondef('public.can_review_submission(uuid)'::regprocedure)) = 0 THEN
    RAISE EXCEPTION 'BACKLOG-4019: can_review_submission changed (md5 %)', v_md5;
  END IF;
  SELECT md5(pg_get_functiondef('public.finalize_submission(uuid,jsonb)'::regprocedure)) INTO v_md5;
  IF v_md5 <> '6b2896ac6370f58b0a4d382118b0ee52'
     AND position('BACKLOG-4019' IN pg_get_functiondef('public.finalize_submission(uuid,jsonb)'::regprocedure)) = 0 THEN
    RAISE EXCEPTION 'BACKLOG-4019: finalize_submission changed (md5 %)', v_md5;
  END IF;

  -- Policies this file alters: 3853's text, or already this file's (reads org_billing_service_off).
  SELECT md5(coalesce(qual, '')), md5(coalesce(with_check, '')) INTO v_q, v_w FROM pg_policies
   WHERE schemaname = 'public' AND tablename = 'transaction_submissions' AND policyname = 'transaction_submissions_update_public';
  IF NOT ((v_q = '030ef0a240885e49ed0fd333c8f774b7' AND v_w = '9f56c6cfcd502f3738a4bcf8ba23f998')
          OR EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND policyname = 'transaction_submissions_update_public'
                      AND qual LIKE '%org_billing_service_off%' AND with_check LIKE '%org_billing_service_off%')) THEN
    RAISE EXCEPTION 'BACKLOG-4019: policy transaction_submissions_update_public changed (% / %)', v_q, v_w;
  END IF;
  SELECT md5(coalesce(with_check, '')) INTO v_w FROM pg_policies
   WHERE schemaname = 'public' AND tablename = 'transaction_submissions' AND policyname = 'agents_can_create_submissions';
  IF NOT (v_w = 'f6ae9fb2d80c2e5cb756f53b42fc836f'
          OR EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND policyname = 'agents_can_create_submissions'
                      AND with_check LIKE '%org_billing_service_off%')) THEN
    RAISE EXCEPTION 'BACKLOG-4019: policy agents_can_create_submissions changed (%)', v_w;
  END IF;
  SELECT md5(coalesce(with_check, '')) INTO v_w FROM pg_policies
   WHERE schemaname = 'public' AND tablename = 'submission_comments' AND policyname = 'users_can_create_comments';
  IF NOT (v_w = '622e6086329c5b23d98aa6332a405d91'
          OR EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND policyname = 'users_can_create_comments'
                      AND with_check LIKE '%org_billing_service_off%')) THEN
    RAISE EXCEPTION 'BACKLOG-4019: policy users_can_create_comments changed (%)', v_w;
  END IF;
  SELECT md5(coalesce(with_check, '')) INTO v_w FROM pg_policies
   WHERE schemaname = 'storage' AND tablename = 'objects' AND policyname = 'Members can upload submission attachments';
  IF NOT (v_w = '000b9376c64e11ef9ef43a77f7d8d1c3'
          OR EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'storage' AND policyname = 'Members can upload submission attachments'
                      AND with_check LIKE '%org_billing_service_off%')) THEN
    RAISE EXCEPTION 'BACKLOG-4019: policy "Members can upload submission attachments" changed (%)', v_w;
  END IF;
END
$pre$;

-- =====================================================================================
-- 1. The service-off predicate (SR change 1a). org_billing_suspended stays as it is: the
--    suspended banners, middleware redirects, checklists, unlock_transaction and
--    billing_purchase_blocked read it, and a canceled brokerage shows none of those.
-- =====================================================================================
CREATE OR REPLACE FUNCTION public.org_billing_service_off(p_org uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO ''
AS $function$
  -- BACKLOG-4019: suspended OR canceled. Submission and review gates read this.
  SELECT EXISTS (
    SELECT 1 FROM public.org_deals d
     WHERE d.organization_id = p_org AND d.status IN ('suspended', 'canceled')
  );
$function$;
REVOKE ALL ON FUNCTION public.org_billing_service_off(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.org_billing_service_off(uuid) TO authenticated, service_role;

-- =====================================================================================
-- 2. Gates (SR change 1b). Same signatures, the predicate swapped.
-- =====================================================================================
CREATE OR REPLACE FUNCTION public.can_review_submission(p_org_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  -- BACKLOG-4019: no review while the brokerage's service is off (suspended or canceled).
  SELECT EXISTS (
    SELECT 1
      FROM public.organization_members om
     WHERE om.organization_id = p_org_id
       AND om.user_id = (SELECT auth.uid())
       AND om.role IN ('broker', 'admin', 'it_admin')
       AND public.member_status_grants_access(om.license_status)
       AND NOT public.org_billing_service_off(p_org_id)
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
  -- BACKLOG-4019: none once the brokerage's plan has ended (canceled).
  IF public.org_billing_service_off(v_sub.organization_id) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'plan_ended');
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

-- Policies: 3853's text (20261018230000 §8) with org_billing_suspended -> org_billing_service_off.
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
    AND (NOT public.org_billing_service_off(organization_id))
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
        AND (NOT public.org_billing_service_off(organization_id)))
  )
  WITH CHECK (
    ((submitted_by = (SELECT auth.uid() AS uid))
      AND ((status)::text = ANY ((ARRAY['resubmitted'::character varying, 'uploading'::character varying, 'submitted'::character varying])::text[]))
      AND (((status)::text = 'uploading'::text) OR (NOT public.org_billing_service_off(organization_id))))
    OR (((status)::text <> 'uploading'::text)
        AND (organization_id IN (
          SELECT reviewer_check.organization_id
            FROM public.organization_members reviewer_check
           WHERE ((reviewer_check.user_id = (SELECT auth.uid() AS uid))
             AND ((reviewer_check.role)::text = ANY ((ARRAY['broker'::character varying, 'admin'::character varying])::text[]))
             AND public.member_status_grants_access((reviewer_check.license_status)::text))))
        AND (NOT public.org_billing_service_off(organization_id)))
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
         AND (NOT public.org_billing_service_off(transaction_submissions.organization_id)))))
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
         AND (NOT public.org_billing_service_off(uploader.organization_id)))))
  );

-- =====================================================================================
-- 3. Entitlement (founder Q1 = A): a canceled deal turns Unlimited, broker_submission and
--    broker_portal_access off. account_suspended is NOT set (no suspended banner).
-- =====================================================================================
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
      -- BACKLOG-4019: the plan has ended; the service is off, with no suspended state.
      WHEN v_deal.status = 'canceled' AND v_key IN ('unlimited_transactions', 'broker_submission', 'broker_portal_access')
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

REVOKE EXECUTE ON FUNCTION public._billing_apply_org_entitlement(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public._billing_apply_org_entitlement(uuid) TO service_role;

-- =====================================================================================
-- 4. Who may switch auto-renew (SR change 2): one helper for every writer and reader.
--    'staff' (billing.manage) | 'admin' (active Admin of this org) | 'billing_contact' (the live
--    billing contact's member, licensed active or the billing-only login) | NULL.
-- =====================================================================================
CREATE OR REPLACE FUNCTION public._org_auto_renew_caller(p_org uuid)
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO ''
AS $function$
  SELECT CASE
    WHEN auth.uid() IS NULL THEN NULL
    WHEN public.has_permission(auth.uid(), 'billing.manage') THEN 'staff'
    WHEN EXISTS (SELECT 1 FROM public.organization_members m
                  WHERE m.organization_id = p_org AND m.user_id = auth.uid()
                    AND m.role = 'admin' AND m.license_status = 'active') THEN 'admin'
    WHEN EXISTS (SELECT 1 FROM public.org_contacts c
                   JOIN public.organization_members m ON m.id = c.member_id
                  WHERE c.organization_id = p_org AND c.role = 'billing' AND c.removed_at IS NULL
                    AND m.organization_id = p_org AND m.user_id = auth.uid()
                    AND m.license_status IN ('active', 'unassigned')) THEN 'billing_contact'
    ELSE NULL
  END
$function$;
REVOKE ALL ON FUNCTION public._org_auto_renew_caller(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public._org_auto_renew_caller(uuid) TO service_role;

-- =====================================================================================
-- 5. The switch itself (service_role). p_caller is the helper's answer for the person.
-- =====================================================================================
CREATE OR REPLACE FUNCTION public._billing_set_auto_renew(
  p_org uuid, p_on boolean, p_note text, p_actor uuid, p_caller text, p_expected_version integer)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
  v_deal public.org_deals%ROWTYPE;
  v_eff text;
  v_sub_id text;
  v_sub_status text;
  v_ends timestamptz;
  v_version integer;
  v_who text;
  v_note text := nullif(btrim(coalesce(p_note, '')), '');
BEGIN
  IF p_on IS NULL OR p_caller IS NULL OR p_caller NOT IN ('staff', 'admin', 'billing_contact') THEN
    RETURN jsonb_build_object('success', false, 'error', 'invalid_request');
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('billing_org:' || p_org::text, 0));
  SELECT * INTO v_deal FROM public.org_deals WHERE organization_id = p_org FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'no_deal');
  END IF;
  IF p_expected_version IS DISTINCT FROM v_deal.version THEN
    RETURN jsonb_build_object('success', false, 'error', 'version_conflict', 'version', v_deal.version);
  END IF;
  IF v_deal.stripe_mode = 'live' AND NOT public._billing_brokerage_live() THEN
    RETURN jsonb_build_object('success', false, 'error', 'billing_not_live');
  END IF;
  -- SR change 3: a suspended brokerage changes nothing itself; staff may.
  IF v_deal.status = 'suspended' AND p_caller <> 'staff' THEN
    RETURN jsonb_build_object('success', false, 'error', 'deal_suspended');
  END IF;
  IF v_deal.status = 'draft' THEN
    RETURN jsonb_build_object('success', false, 'error', 'deal_not_started');
  END IF;
  IF v_deal.status = 'canceled' THEN
    RETURN jsonb_build_object('success', false, 'error', 'deal_canceled');
  END IF;

  v_eff := CASE WHEN v_deal.status = 'suspended' THEN v_deal.status_before_suspension ELSE v_deal.status END;
  SELECT s.stripe_subscription_id, s.status, s.current_period_end INTO v_sub_id, v_sub_status, v_ends
    FROM public.org_billing_stripe s
   WHERE s.organization_id = p_org AND s.stripe_mode = v_deal.stripe_mode;

  IF NOT p_on THEN
    IF v_eff = 'canceling' THEN
      RETURN jsonb_build_object('success', true, 'changed', false, 'version', v_deal.version, 'ends_on', v_ends);
    END IF;
    IF v_sub_id IS NULL THEN
      RETURN jsonb_build_object('success', false, 'error', 'no_subscription');
    END IF;
    IF v_sub_status = 'canceled' THEN
      RETURN jsonb_build_object('success', false, 'error', 'already_ended');
    END IF;
  ELSE
    IF v_eff = 'active' THEN
      RETURN jsonb_build_object('success', true, 'changed', false, 'version', v_deal.version, 'ends_on', NULL);
    END IF;
    -- Stripe cannot resume a canceled subscription (S5): restart is Edit deal.
    IF v_sub_status = 'canceled' THEN
      RETURN jsonb_build_object('success', false, 'error', 'already_ended');
    END IF;
  END IF;

  -- One UPDATE: the state and the version, so the trigger queues exactly one sync row.
  UPDATE public.org_deals SET
    status = CASE WHEN status = 'suspended' THEN status
                  WHEN p_on THEN 'active' ELSE 'canceling' END,
    status_before_suspension = CASE WHEN status = 'suspended'
                                    THEN CASE WHEN p_on THEN 'active' ELSE 'canceling' END
                                    ELSE status_before_suspension END,
    version = version + 1,
    updated_at = now(),
    updated_by = p_actor
  WHERE organization_id = p_org
  RETURNING version INTO v_version;

  INSERT INTO public.billing_change_log (organization_id, actor_id, action, detail)
  VALUES (p_org, p_actor, CASE WHEN p_on THEN 'auto_renew_on' ELSE 'auto_renew_off' END,
          jsonb_build_object('note', v_note, 'ends_on', CASE WHEN p_on THEN NULL ELSE v_ends END,
                             'version', v_version, 'by', p_caller));

  -- SR change 4: a brokerage turning it off itself alerts its Keepr account manager.
  IF NOT p_on AND p_caller <> 'staff' THEN
    SELECT coalesce(nullif(btrim(u.display_name), ''),
                    nullif(btrim(concat_ws(' ', u.first_name, u.last_name)), ''), u.email, 'A brokerage user')
      INTO v_who FROM public.users u WHERE u.id = p_actor;
    INSERT INTO public.billing_outbox (stripe_mode, kind, organization_id, dedupe_key, payload)
    VALUES (v_deal.stripe_mode, 'notify_account_manager', p_org,
            'notify_account_manager:' || v_deal.stripe_mode || ':' || p_org::text || ':auto_renew_off:v' || v_version::text,
            jsonb_build_object('reason', 'auto_renew_off', 'organization_id', p_org,
              'detail', 'Turned off by ' || coalesce(v_who, 'a brokerage user')
                        || CASE WHEN p_caller = 'admin' THEN ' (Admin)' ELSE ' (billing contact)' END
                        || '. The plan ends on '
                        || coalesce(to_char(v_ends AT TIME ZONE 'America/Los_Angeles', 'FMMon FMDD, YYYY'), 'the end of the billing period')
                        || '.'))
    ON CONFLICT (dedupe_key) DO NOTHING;
  END IF;

  RETURN jsonb_build_object('success', true, 'changed', true, 'version', v_version,
                            'ends_on', CASE WHEN p_on THEN NULL ELSE v_ends END);
END
$function$;
REVOKE ALL ON FUNCTION public._billing_set_auto_renew(uuid, boolean, text, uuid, text, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public._billing_set_auto_renew(uuid, boolean, text, uuid, text, integer) TO service_role;

-- The one public writer (admin portal and broker portal, both with the user's session).
CREATE OR REPLACE FUNCTION public.set_org_auto_renew(p_org uuid, p_on boolean, p_note text, p_expected_version integer)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_caller text;
  v_res jsonb;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '42501';
  END IF;
  v_caller := public._org_auto_renew_caller(p_org);
  IF v_caller IS NULL THEN
    RAISE EXCEPTION 'Not authorized' USING ERRCODE = '42501';
  END IF;
  IF v_caller = 'staff' AND nullif(btrim(coalesce(p_note, '')), '') IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'note_required');
  END IF;
  v_res := public._billing_set_auto_renew(p_org, p_on, p_note, v_uid, v_caller, p_expected_version);
  IF v_caller = 'staff' AND coalesce((v_res ->> 'changed')::boolean, false) THEN
    INSERT INTO public.admin_audit_logs (actor_id, action, target_type, target_id, metadata)
    VALUES (v_uid, CASE WHEN p_on THEN 'billing.auto_renew_on' ELSE 'billing.auto_renew_off' END,
            'organization', p_org::text,
            jsonb_build_object('version', v_res -> 'version', 'note', btrim(p_note), 'ends_on', v_res -> 'ends_on'));
  END IF;
  RETURN v_res;
END
$function$;
REVOKE ALL ON FUNCTION public.set_org_auto_renew(uuid, boolean, text, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_org_auto_renew(uuid, boolean, text, integer) TO authenticated, service_role;

-- =====================================================================================
-- 6. The end (webhook on a canceled subscription, and the payment-reconcile backstop).
--    Acts only when the deal is effectively canceling and the subscription is the stored one.
--    outcome: 'ended' | 'already_canceled' | 'not_canceling' | 'not_stored'.
-- =====================================================================================
CREATE OR REPLACE FUNCTION public._billing_end_org_deal(p_org uuid, p_mode text, p_subscription_id text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
  v_deal public.org_deals%ROWTYPE;
  v_stored text;
  v_ends timestamptz;
  v_eff text;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('billing_org:' || p_org::text, 0));
  SELECT * INTO v_deal FROM public.org_deals WHERE organization_id = p_org FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'no_deal');
  END IF;
  IF v_deal.stripe_mode IS DISTINCT FROM p_mode THEN
    RETURN jsonb_build_object('success', false, 'error', 'mode_mismatch');
  END IF;
  SELECT s.stripe_subscription_id, s.current_period_end INTO v_stored, v_ends
    FROM public.org_billing_stripe s WHERE s.organization_id = p_org AND s.stripe_mode = p_mode;
  IF v_stored IS NULL OR v_stored IS DISTINCT FROM p_subscription_id THEN
    RETURN jsonb_build_object('success', true, 'outcome', 'not_stored');
  END IF;
  IF v_deal.status = 'canceled' THEN
    RETURN jsonb_build_object('success', true, 'outcome', 'already_canceled');
  END IF;
  v_eff := CASE WHEN v_deal.status = 'suspended' THEN v_deal.status_before_suspension ELSE v_deal.status END;
  IF v_eff IS DISTINCT FROM 'canceling' THEN
    RETURN jsonb_build_object('success', true, 'outcome', 'not_canceling', 'status', v_deal.status,
                              'status_before_suspension', v_deal.status_before_suspension);
  END IF;

  -- The suspension shape CHECK requires the suspension fields cleared with the status.
  UPDATE public.org_deals SET
    status = 'canceled',
    status_before_suspension = NULL,
    suspended_reason = NULL,
    suspended_note = NULL,
    suspended_at = NULL,
    suspended_by = NULL,
    version = version + 1,
    updated_at = now(),
    updated_by = NULL
  WHERE organization_id = p_org;

  PERFORM public._billing_apply_org_entitlement(p_org);

  INSERT INTO public.billing_change_log (organization_id, actor_id, action, detail)
  VALUES (p_org, NULL, 'deal_ended', jsonb_build_object('subscription_id', p_subscription_id, 'ended_on', v_ends,
          'from_status', v_deal.status));
  RETURN jsonb_build_object('success', true, 'outcome', 'ended', 'ended_on', v_ends);
END
$function$;
REVOKE ALL ON FUNCTION public._billing_end_org_deal(uuid, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public._billing_end_org_deal(uuid, text, text) TO service_role;

-- =====================================================================================
-- 7. Broker portal read: the plan's end and whether this person may switch it.
--    Readers: an active Broker/Admin of the org, or anyone the helper admits (incl. the
--    billing-only login). state: 'none' | 'renewing' | 'ending' | 'ended'.
-- =====================================================================================
CREATE OR REPLACE FUNCTION public.broker_get_plan_end(p_org uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_caller text;
  v_deal public.org_deals%ROWTYPE;
  v_eff text;
  v_sub_id text;
  v_sub_status text;
  v_ends timestamptz;
  v_state text;
  v_can boolean;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '42501';
  END IF;
  v_caller := public._org_auto_renew_caller(p_org);
  IF v_caller IS NULL AND NOT EXISTS (
       SELECT 1 FROM public.organization_members m
        WHERE m.organization_id = p_org AND m.user_id = v_uid
          AND m.license_status = 'active' AND m.role IN ('broker', 'admin')) THEN
    RAISE EXCEPTION 'Not authorized' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO v_deal FROM public.org_deals WHERE organization_id = p_org;
  IF NOT FOUND OR v_deal.status = 'draft' THEN
    RETURN jsonb_build_object('state', 'none', 'ends_on', NULL, 'can_change', false, 'version', v_deal.version);
  END IF;
  SELECT s.stripe_subscription_id, s.status, s.current_period_end INTO v_sub_id, v_sub_status, v_ends
    FROM public.org_billing_stripe s WHERE s.organization_id = p_org AND s.stripe_mode = v_deal.stripe_mode;
  v_eff := CASE WHEN v_deal.status = 'suspended' THEN v_deal.status_before_suspension ELSE v_deal.status END;
  v_state := CASE WHEN v_deal.status = 'canceled' THEN 'ended'
                  WHEN v_eff = 'canceling' THEN 'ending'
                  ELSE 'renewing' END;
  -- The same refusals as _billing_set_auto_renew, so the page never offers a button it refuses.
  v_can := v_caller IS NOT NULL
           AND v_deal.status IN ('active', 'canceling')
           AND v_sub_id IS NOT NULL
           AND coalesce(v_sub_status, '') <> 'canceled';
  RETURN jsonb_build_object(
    'state', v_state,
    'ends_on', CASE WHEN v_state IN ('ending', 'ended') THEN v_ends ELSE NULL END,
    -- the current period's end, for the confirm dialog ("Your plan ends on <date>")
    'period_end', v_ends,
    'can_change', v_can,
    'version', v_deal.version);
END
$function$;
REVOKE ALL ON FUNCTION public.broker_get_plan_end(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.broker_get_plan_end(uuid) TO authenticated, service_role;
