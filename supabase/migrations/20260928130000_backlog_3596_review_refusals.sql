-- BACKLOG-3596 (follow-up): two server-side refusals.
--
-- Applied AFTER 20260928120000_backlog_3596_broker_checklist_ticks.sql,
-- under the same apply go, after portal PR #2739 is deployed. Apply as ONE
-- transaction (`psql -1 -f <file>`, or the whole file in one SQL editor run).
-- It opens none of its own, and every statement is safe to run twice.
--
--   1. public.add_submission_checklist_at_review(submission, template): the
--      BACKLOG-3477 body verbatim, plus: refuses (42501 'superseded') when the
--      version already has a newer version, in any status (uploading
--      included). Checked after the authorization, feature and status checks,
--      so an outsider still reads not_authorized.
--
--      Reachability: shipped code cannot produce this state. The desktop only
--      creates a new version when the latest one is needs_changes, and this
--      function already refuses needs_changes. The one remaining path is a
--      hand-crafted request: an agent moving its own needs_changes row back
--      to an open status after the newer version exists (the submitter branch
--      of transaction_submissions_update_public admits it). A checklist added
--      there would never reach the agent: the desktop pulls added checklists
--      only from the version it tracks, which is already the newer one.
--
--   2. public.set_submission_checklist_reviewer_check(item, checked): the
--      20260928120000 body verbatim, plus: refuses (42501
--      'not_open_for_review') a NEW tick or untick on a needs_changes version,
--      after the existing superseded refusal. Existing ticks are not touched
--      and still carry to the next version.
--
-- Errors raised (new):
--   42501 superseded           (add) the version already has a newer version
--   42501 not_open_for_review  (tick) the version is needs_changes and has no
--                              newer version
--
-- Rollback: supabase/tests/backlog-3596/rollback-refusals.sql (tested by the
-- harness), run BEFORE supabase/tests/backlog-3596/rollback.sql.

-- ---------------------------------------------------------------------------
-- 1. Add a checklist at review (BACKLOG-3477 section 8), plus the superseded
--    refusal.
-- ---------------------------------------------------------------------------
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
  -- BACKLOG-3596: a newer version exists, in any status (uploading
  -- included). A checklist added here never reaches the agent.
  IF EXISTS (SELECT 1 FROM public.transaction_submissions c
              WHERE c.parent_submission_id = p_submission_id) THEN
    RAISE EXCEPTION 'superseded' USING ERRCODE = '42501';
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

-- ---------------------------------------------------------------------------
-- 2. The reviewer tick (20260928120000 section 5), plus the needs_changes
--    refusal of new ticks.
-- ---------------------------------------------------------------------------
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
  -- BACKLOG-3596: changes were requested, so this version is closed to NEW
  -- ticks and unticks. A policy choice, matching the notice the broker sees
  -- on a needs_changes version: "You can check items and add a checklist on
  -- the next submission." Ticks made before changes were requested stay on
  -- this version and carry to the next one (the carry reads this version's
  -- rows directly; it never calls this function). Placed after the
  -- superseded check, so a version with a newer version reads 'superseded'.
  IF v_row.status = 'needs_changes' THEN
    RAISE EXCEPTION 'not_open_for_review' USING ERRCODE = '42501';
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
