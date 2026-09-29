-- BACKLOG-3596 follow-up rollback. Restores the two functions
-- supabase/migrations/20260928130000_backlog_3596_review_refusals.sql
-- changed. Run as ONE transaction, and BEFORE rollback.sql (which restores
-- the tick to its BACKLOG-3477 body). Tested by the harness:
-- controls/c25-rollback-refusals.sql applies the file, then this one, and
-- compares the catalogue with the state before the file; c22 runs this file
-- and then rollback.sql.
--
-- Both bodies are copied verbatim (the CI text test compares them):
--   add_submission_checklist_at_review      from 20260925073000 (BACKLOG-3477)
--   set_submission_checklist_reviewer_check from 20260928120000 (BACKLOG-3596)

-- 2. The reviewer tick, as 20260928120000 wrote it
CREATE OR REPLACE FUNCTION public.set_submission_checklist_reviewer_check(
  p_item_id uuid,
  p_checked boolean
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_uid    uuid := auth.uid();
  v_now    timestamptz := now();
  v_row    record;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'not_authorized' USING ERRCODE = '42501';
  END IF;
  IF p_item_id IS NULL OR p_checked IS NULL THEN
    RAISE EXCEPTION 'invalid_argument' USING ERRCODE = '22023';
  END IF;

  SELECT i.id, i.title, i.reviewer_checked, i.submission_id,
         h.template_name, h.added_at_review_by,
         ts.organization_id, ts.status
    INTO v_row
    FROM public.submission_checklist_items i
    JOIN public.submission_checklists h ON h.id = i.submission_checklist_id
    JOIN public.transaction_submissions ts ON ts.id = i.submission_id
   WHERE i.id = p_item_id
     FOR UPDATE OF i;

  IF NOT FOUND OR NOT public.can_review_submission(v_row.organization_id) THEN
    RAISE EXCEPTION 'not_authorized' USING ERRCODE = '42501';
  END IF;
  IF NOT COALESCE((public.check_feature_access(v_row.organization_id, 'transaction_checklists') ->> 'allowed')::boolean, false) THEN
    RAISE EXCEPTION 'not_authorized' USING ERRCODE = '42501';
  END IF;
  IF v_row.status IS NULL
     OR v_row.status NOT IN ('submitted', 'resubmitted', 'under_review', 'needs_changes') THEN
    RAISE EXCEPTION 'not_open_for_review' USING ERRCODE = '42501';
  END IF;
  IF v_row.added_at_review_by IS NOT NULL THEN
    RAISE EXCEPTION 'added_at_review' USING ERRCODE = '42501';
  END IF;
  -- A newer version exists, in any status (uploading included): its copy
  -- has already read, or is about to read, this version's ticks.
  IF EXISTS (SELECT 1 FROM public.transaction_submissions c
              WHERE c.parent_submission_id = v_row.submission_id) THEN
    RAISE EXCEPTION 'superseded' USING ERRCODE = '42501';
  END IF;

  IF v_row.reviewer_checked = p_checked THEN
    RETURN jsonb_build_object('changed', false, 'reviewer_checked', p_checked);
  END IF;

  UPDATE public.submission_checklist_items
     SET reviewer_checked    = p_checked,
         reviewer_checked_by = CASE WHEN p_checked THEN v_uid END,
         reviewer_checked_at = CASE WHEN p_checked THEN v_now END
   WHERE id = p_item_id;

  -- One statement: the append reads the row's current history under the row
  -- lock, so concurrent ticks on one submission never lose an entry.
  UPDATE public.transaction_submissions
     SET status_history = COALESCE(status_history, '[]'::jsonb) || jsonb_build_array(jsonb_build_object(
           'type', 'checklist_review',
           'changed_at', v_now,
           'changed_by', v_uid,
           'field', 'reviewer_checked',
           'from', v_row.reviewer_checked,
           'to', p_checked,
           'item_id', v_row.id,
           'item_title', v_row.title,
           'checklist_name', v_row.template_name))
   WHERE id = v_row.submission_id;

  RETURN jsonb_build_object(
    'changed', true,
    'reviewer_checked', p_checked,
    'reviewer_checked_by', CASE WHEN p_checked THEN v_uid END,
    'reviewer_checked_at', CASE WHEN p_checked THEN v_now END);
END
$$;

REVOKE EXECUTE ON FUNCTION public.set_submission_checklist_reviewer_check(uuid, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_submission_checklist_reviewer_check(uuid, boolean) TO authenticated;

-- 1. Add a checklist at review, as BACKLOG-3477 wrote it
CREATE OR REPLACE FUNCTION public.add_submission_checklist_at_review(
  p_submission_id uuid,
  p_template_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_uid       uuid := auth.uid();
  v_now       timestamptz := now();
  v_sub       record;
  v_tpl       record;
  v_header_id uuid;
  v_items     integer;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'not_authorized' USING ERRCODE = '42501';
  END IF;
  IF p_submission_id IS NULL OR p_template_id IS NULL THEN
    RAISE EXCEPTION 'invalid_argument' USING ERRCODE = '22023';
  END IF;

  SELECT ts.id, ts.organization_id, ts.status
    INTO v_sub
    FROM public.transaction_submissions ts
   WHERE ts.id = p_submission_id
     FOR UPDATE;

  IF NOT FOUND OR NOT public.can_review_submission(v_sub.organization_id) THEN
    RAISE EXCEPTION 'not_authorized' USING ERRCODE = '42501';
  END IF;
  IF NOT COALESCE((public.check_feature_access(v_sub.organization_id, 'transaction_checklists') ->> 'allowed')::boolean, false) THEN
    RAISE EXCEPTION 'not_authorized' USING ERRCODE = '42501';
  END IF;
  IF v_sub.status IS NULL OR v_sub.status NOT IN ('submitted', 'resubmitted', 'under_review') THEN
    RAISE EXCEPTION 'not_open_for_review' USING ERRCODE = '42501';
  END IF;

  SELECT t.id, t.name
    INTO v_tpl
    FROM public.checklist_templates t
   WHERE t.id = p_template_id
     AND t.organization_id = v_sub.organization_id
     AND t.archived_at IS NULL;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('status', 'template_not_found');
  END IF;

  SELECT h.id INTO v_header_id
    FROM public.submission_checklists h
   WHERE h.submission_id = p_submission_id
     AND h.template_id = p_template_id;
  IF FOUND THEN
    RETURN jsonb_build_object('status', 'exists', 'checklist_id', v_header_id);
  END IF;

  INSERT INTO public.submission_checklists
    (submission_id, template_id, template_name, sort_order, added_at_review_by, added_at_review_at)
  VALUES (p_submission_id, v_tpl.id, v_tpl.name,
          COALESCE((SELECT max(h.sort_order) + 1 FROM public.submission_checklists h
                     WHERE h.submission_id = p_submission_id), 0),
          v_uid, v_now)
  RETURNING id INTO v_header_id;

  INSERT INTO public.submission_checklist_items
    (submission_id, submission_checklist_id, title, description, is_required,
     expected_document_type, is_checked, sort_order)
  SELECT p_submission_id, v_header_id, ti.title, ti.description, ti.is_required,
         ti.expected_document_type, false, ti.sort_order
    FROM public.checklist_template_items ti
   WHERE ti.template_id = v_tpl.id;
  GET DIAGNOSTICS v_items = ROW_COUNT;

  UPDATE public.transaction_submissions
     SET status_history = COALESCE(status_history, '[]'::jsonb) || jsonb_build_array(jsonb_build_object(
           'type', 'checklist_added',
           'changed_at', v_now,
           'changed_by', v_uid,
           'checklist_id', v_header_id,
           'checklist_name', v_tpl.name,
           'template_id', v_tpl.id))
   WHERE id = p_submission_id;

  RETURN jsonb_build_object('status', 'added', 'checklist_id', v_header_id, 'items', v_items);
END
$$;

REVOKE EXECUTE ON FUNCTION public.add_submission_checklist_at_review(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.add_submission_checklist_at_review(uuid, uuid) TO authenticated;
