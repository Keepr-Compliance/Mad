-- BACKLOG-3853 PR-1: rollback of M1 (20261018230000_backlog_3853_brokerage_suspension_gates.sql).
--
-- Refuses while ANY org_deals row exists: a deal means billing-owned feature overrides
-- (unlimited_transactions, and while suspended broker_submission / broker_portal_access /
-- account_suspended) are in organization_plans, and a suspension would be silently lifted.
-- Restores: the three replaced function bodies (md5(pg_get_functiondef) de52ee2e / 1f6f8a17 /
-- 9e6fc264), the four policy texts as 3917 (20261014002359) wrote them, and removes the trigger,
-- the new functions, the new tables, the billing.* permission keys and their role grants, and the
-- account_suspended feature key. Run as one transaction. Also remove the ledger row
-- 20261018230000 by hand if the venue keeps one.

DO $pre$
DECLARE v_n integer;
BEGIN
  IF to_regclass('public.org_deals') IS NOT NULL THEN
    EXECUTE 'SELECT count(*) FROM public.org_deals' INTO v_n;
    IF v_n > 0 THEN
      RAISE EXCEPTION '3853 M1 rollback refused: % org_deals row(s) exist (billing owns feature overrides; a suspension would be lifted)', v_n;
    END IF;
  END IF;
END $pre$;

-- 1. Replaced functions back to their pre-M1 bodies (CREATE OR REPLACE keeps the grants).
CREATE OR REPLACE FUNCTION public.unlock_transaction(p_local_transaction_id text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_uid            uuid := auth.uid();
  v_existing       public.transaction_unlocks;
  v_unlock_id      uuid;
  v_grant_remaining   integer;
  v_purchase_remaining integer;
  v_funded_by      uuid;
  v_funding_source text;
  v_debit_id       uuid;
  v_price_cents    integer;
  v_tier_id        uuid;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(v_uid::text, 0));

  SELECT * INTO v_existing
  FROM public.transaction_unlocks
  WHERE user_id = v_uid AND local_transaction_id = p_local_transaction_id;

  IF FOUND THEN
    RETURN jsonb_build_object(
      'unlocked', false,
      'already', true,
      'ledger_entry_id', v_existing.ledger_entry_id,
      'funding_source', v_existing.funding_source,
      'counts_toward_tier', v_existing.counts_toward_tier,
      'balance_after', public.get_credit_balance(v_uid)
    );
  END IF;

  -- CR1: grant net-capacity includes ALL adjustment rows (negatives reduce it), clamped at 0.
  WITH src AS (
    SELECT
      COALESCE(SUM(l.amount) FILTER (WHERE l.entry_type = 'adjustment'), 0) AS adj_sum,
      COALESCE(SUM(l.amount) FILTER (WHERE l.entry_type = 'purchase'), 0)   AS pur_sum
    FROM public.credit_ledger l
    WHERE l.user_id = v_uid
  ),
  drawn AS (
    SELECT
      count(*) FILTER (WHERE f.entry_type = 'adjustment') AS adj_debits,
      count(*) FILTER (WHERE f.entry_type = 'purchase')   AS pur_debits
    FROM public.credit_ledger d
    JOIN public.credit_ledger f ON f.id = d.funded_by
    WHERE d.user_id = v_uid AND d.entry_type = 'debit'
  )
  SELECT GREATEST(src.adj_sum - drawn.adj_debits, 0),
         (src.pur_sum - drawn.pur_debits)
  INTO v_grant_remaining, v_purchase_remaining
  FROM src, drawn;

  IF v_grant_remaining > 0 THEN
    SELECT l.id INTO v_funded_by
    FROM public.credit_ledger l
    WHERE l.user_id = v_uid AND l.entry_type = 'adjustment' AND l.amount > 0
      AND l.amount > (
        SELECT count(*) FROM public.credit_ledger d
        WHERE d.user_id = v_uid AND d.entry_type = 'debit' AND d.funded_by = l.id
      )
    ORDER BY l.created_at ASC
    LIMIT 1;
    v_funding_source := 'grant';
  ELSIF v_purchase_remaining > 0 THEN
    SELECT l.id INTO v_funded_by
    FROM public.credit_ledger l
    WHERE l.user_id = v_uid AND l.entry_type = 'purchase'
      AND l.amount > (
        SELECT count(*) FROM public.credit_ledger d
        WHERE d.user_id = v_uid AND d.entry_type = 'debit' AND d.funded_by = l.id
      )
    ORDER BY l.created_at ASC
    LIMIT 1;
    v_funding_source := 'purchase';
  ELSE
    RAISE EXCEPTION 'Insufficient credits';
  END IF;

  IF v_funded_by IS NULL THEN
    RAISE EXCEPTION 'Insufficient credits';
  END IF;

  IF v_funding_source = 'purchase' THEN
    SELECT q.unit_price_cents, q.pricing_tier_id INTO v_price_cents, v_tier_id
    FROM public.get_next_unlock_quote(v_uid) q;
  END IF;

  INSERT INTO public.credit_ledger
    (user_id, entry_type, amount, unit_price_cents, pricing_tier_id, funded_by, funding_source, created_by)
  VALUES
    (v_uid, 'debit', -1, v_price_cents, v_tier_id, v_funded_by, v_funding_source, v_uid)
  RETURNING id INTO v_debit_id;

  INSERT INTO public.transaction_unlocks
    (user_id, local_transaction_id, ledger_entry_id, funding_source, counts_toward_tier)
  VALUES
    (v_uid, p_local_transaction_id, v_debit_id, v_funding_source, (v_funding_source = 'purchase'))
  RETURNING id INTO v_unlock_id;

  IF public.get_credit_balance(v_uid) < 0 THEN
    RAISE EXCEPTION 'Insufficient credits';
  END IF;

  RETURN jsonb_build_object(
    'unlocked', true,
    'already', false,
    'ledger_entry_id', v_debit_id,
    'funding_source', v_funding_source,
    'counts_toward_tier', (v_funding_source = 'purchase'),
    'balance_after', public.get_credit_balance(v_uid)
  );
END;
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

-- 2. Policies back to the 3917 texts.
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

-- 3. Trigger and new functions.
DROP TRIGGER IF EXISTS _billing_guard_member_while_suspended ON public.organization_members;
DROP FUNCTION IF EXISTS public._billing_guard_member_while_suspended();
DROP FUNCTION IF EXISTS public.admin_suspend_org(uuid, text, text);
DROP FUNCTION IF EXISTS public.admin_reinstate_org(uuid, text);
DROP FUNCTION IF EXISTS public._billing_change_seats(uuid, integer, uuid);
DROP FUNCTION IF EXISTS public._billing_apply_org_subscription(uuid, text, jsonb, bigint);
DROP FUNCTION IF EXISTS public._billing_auto_reinstate(uuid, text);
DROP FUNCTION IF EXISTS public._billing_reinstate_org(uuid, text, uuid);
DROP FUNCTION IF EXISTS public._billing_suspend_org(uuid, text, text, uuid);
DROP FUNCTION IF EXISTS public._billing_save_deal(uuid, jsonb, uuid, text, integer);
DROP FUNCTION IF EXISTS public._billing_apply_org_entitlement(uuid);
DROP FUNCTION IF EXISTS public._billing_brokerage_live();
DROP FUNCTION IF EXISTS public.billing_purchase_blocked(uuid);
DROP FUNCTION IF EXISTS public.billing_deciding_org(uuid);
DROP FUNCTION IF EXISTS public.org_billing_suspended(uuid);

-- 4. Tables, permission keys, feature key.
DROP TABLE IF EXISTS public.org_deal_lines;
DROP TABLE IF EXISTS public.org_billing_stripe;
DROP TABLE IF EXISTS public.org_deals;
DROP TABLE IF EXISTS public.price_book_prices;
DROP TABLE IF EXISTS public.price_book_items;
DROP TABLE IF EXISTS public.billing_change_log;
DROP TABLE IF EXISTS public.billing_settings;
DELETE FROM public.admin_role_permissions
 WHERE permission_id IN (SELECT id FROM public.admin_permissions
                          WHERE key IN ('billing.view', 'billing.manage', 'billing.approve', 'billing.pricebook', 'billing.suspend'));
DELETE FROM public.admin_permissions
 WHERE key IN ('billing.view', 'billing.manage', 'billing.approve', 'billing.pricebook', 'billing.suspend');
DELETE FROM public.feature_definitions WHERE key = 'account_suspended';
