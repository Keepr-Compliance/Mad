-- BACKLOG-3607 rollback (DRAFT). Run as ONE transaction, before any 3596
-- rollback. Restores the catalogue exactly as the three 3596 files left it.
-- Rows keep nothing 3607-specific once the columns are dropped: a checklist
-- removed at review shows again, restored checklists stay as ordinary
-- checklists added at review.
DROP FUNCTION IF EXISTS public.restore_submission_checklist_at_review(uuid, uuid);
DROP FUNCTION IF EXISTS public.remove_submission_checklist_at_review(uuid);

DROP POLICY IF EXISTS submission_checklists_insert ON public.submission_checklists;
CREATE POLICY submission_checklists_insert ON public.submission_checklists
  FOR INSERT TO authenticated
  WITH CHECK (
    submission_checklists.added_at_review_by IS NULL
    AND submission_checklists.added_at_review_at IS NULL
    AND EXISTS (
      SELECT 1
        FROM public.transaction_submissions ts
       WHERE ts.id = submission_checklists.submission_id
         AND ts.submitted_by = (SELECT auth.uid())
         AND ts.status = 'uploading'
         AND COALESCE((public.check_feature_access(ts.organization_id, 'transaction_checklists') ->> 'allowed')::boolean, false)
    )
  );

DROP POLICY IF EXISTS submission_checklist_items_insert ON public.submission_checklist_items;
CREATE POLICY submission_checklist_items_insert ON public.submission_checklist_items
  FOR INSERT TO authenticated
  WITH CHECK (
    submission_checklist_items.reviewer_checked = false
    AND submission_checklist_items.reviewer_checked_by IS NULL
    AND submission_checklist_items.reviewer_checked_at IS NULL
    AND submission_checklist_items.cleared_reviewer_id IS NULL
    AND submission_checklist_items.cleared_at IS NULL
    AND EXISTS (
      SELECT 1
        FROM public.transaction_submissions ts
       WHERE ts.id = submission_checklist_items.submission_id
         AND ts.submitted_by = (SELECT auth.uid())
         AND ts.status = 'uploading'
    )
  );

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

CREATE OR REPLACE FUNCTION public.carry_submission_checklist_reviews(
  p_submission_id uuid
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
  v_parent    record;
  v_entries   jsonb := '[]'::jsonb;
  v_history   jsonb;
  v_items     integer;
  v_with_ids  integer;
  v_parent_headers integer;
  v_carried   integer := 0;
  v_cleared   integer := 0;
  v_removed   integer := 0;
  v_unavailable text;
  r           record;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'not_authorized' USING ERRCODE = '42501';
  END IF;
  IF p_submission_id IS NULL THEN
    RAISE EXCEPTION 'invalid_argument' USING ERRCODE = '22023';
  END IF;

  SELECT ts.id, ts.organization_id, ts.submitted_by, ts.local_transaction_id,
         ts.version, ts.status, ts.parent_submission_id,
         COALESCE(ts.status_history, '[]'::jsonb) AS history
    INTO v_sub
    FROM public.transaction_submissions ts
   WHERE ts.id = p_submission_id
     FOR UPDATE;

  IF NOT FOUND OR v_sub.submitted_by IS DISTINCT FROM v_uid OR v_sub.status IS DISTINCT FROM 'uploading' THEN
    RAISE EXCEPTION 'not_authorized' USING ERRCODE = '42501';
  END IF;
  IF NOT COALESCE((public.check_feature_access(v_sub.organization_id, 'transaction_checklists') ->> 'allowed')::boolean, false) THEN
    RAISE EXCEPTION 'not_authorized' USING ERRCODE = '42501';
  END IF;

  IF v_sub.parent_submission_id IS NULL THEN
    RETURN jsonb_build_object('status', 'no_parent');
  END IF;

  SELECT p.id, p.organization_id, p.submitted_by, p.local_transaction_id, p.version
    INTO v_parent
    FROM public.transaction_submissions p
   WHERE p.id = v_sub.parent_submission_id;

  IF NOT FOUND
     OR v_parent.organization_id IS DISTINCT FROM v_sub.organization_id
     OR v_parent.local_transaction_id IS DISTINCT FROM v_sub.local_transaction_id
     OR v_parent.submitted_by IS DISTINCT FROM v_sub.submitted_by
     OR v_sub.version IS NULL OR v_parent.version IS NULL
     OR v_parent.version <> v_sub.version - 1 THEN
    RAISE EXCEPTION 'not_authorized' USING ERRCODE = '42501';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.submission_checklists h WHERE h.submission_id = v_sub.id) THEN
    RETURN jsonb_build_object('status', 'no_checklists');
  END IF;

  -- A concurrent tick on the parent waits for this transaction.
  PERFORM 1 FROM public.submission_checklist_items pi
   WHERE pi.submission_id = v_parent.id
     FOR SHARE;

  SELECT count(*) INTO v_parent_headers
    FROM public.submission_checklists h WHERE h.submission_id = v_parent.id;
  SELECT count(*), count(i.local_item_id) INTO v_items, v_with_ids
    FROM public.submission_checklist_items i WHERE i.submission_id = v_sub.id;

  IF v_parent_headers = 0 THEN
    -- No previous copy. Read-only, existence-only walk up the chain; it
    -- never carries.
    IF EXISTS (
      WITH RECURSIVE chain(id, parent_id) AS (
        SELECT a.id, a.parent_submission_id
          FROM public.transaction_submissions a
         WHERE a.id = v_parent.id
        UNION
        SELECT a.id, a.parent_submission_id
          FROM public.transaction_submissions a
          JOIN chain c ON a.id = c.parent_id
         WHERE a.organization_id = v_sub.organization_id
           AND a.submitted_by = v_sub.submitted_by
           AND a.local_transaction_id = v_sub.local_transaction_id
      )
      SELECT 1
        FROM chain c
        JOIN public.submission_checklist_items ai ON ai.submission_id = c.id
       WHERE c.id <> v_parent.id
         AND ai.reviewer_checked
    ) THEN
      v_unavailable := 'no_previous_copy';
    END IF;
  ELSIF v_items > 0 AND v_with_ids = 0 THEN
    -- An older desktop: no item ids to match on.
    IF EXISTS (SELECT 1 FROM public.submission_checklist_items pi
                WHERE pi.submission_id = v_parent.id AND pi.reviewer_checked) THEN
      v_unavailable := 'unmatched_client';
    END IF;
  ELSE
    FOR r IN
      WITH pairs AS (
        SELECT pi.id AS parent_item_id, pi.title, ph.template_name,
               pi.reviewer_checked_by, pi.reviewer_checked_at, pi.note AS parent_note,
               ph.added_at_review_by AS added_by,
               ni.id AS new_item_id, ni.note AS new_note,
               ni.reviewer_checked AS new_checked, ni.cleared_reviewer_id AS new_cleared
          FROM public.submission_checklist_items pi
          JOIN public.submission_checklists ph ON ph.id = pi.submission_checklist_id
          LEFT JOIN (public.submission_checklist_items ni
                     JOIN public.submission_checklists nh ON nh.id = ni.submission_checklist_id)
            ON ni.submission_id = v_sub.id
           AND ni.local_item_id = COALESCE(pi.local_item_id, CASE WHEN ph.added_at_review_by IS NOT NULL THEN pi.id::text END)
           AND ni.title = pi.title
           AND nh.template_id IS NOT DISTINCT FROM ph.template_id
         WHERE pi.submission_id = v_parent.id
           AND pi.reviewer_checked
           AND (pi.local_item_id IS NOT NULL OR ph.added_at_review_by IS NOT NULL)
      ),
      evidence AS (
        SELECT DISTINCT l.submission_checklist_item_id AS item_id, lm.kind,
               COALESCE(a.local_attachment_id, m.local_message_id) AS local_id
          FROM public.submission_checklist_links l
          JOIN public.submission_checklist_link_members lm ON lm.link_id = l.id
          LEFT JOIN public.submission_attachments a ON a.id = lm.submission_attachment_id
          LEFT JOIN public.submission_messages m ON m.id = lm.submission_message_id
         WHERE l.submission_id IN (v_sub.id, v_parent.id)
           AND COALESCE(a.local_attachment_id, m.local_message_id) IS NOT NULL
      )
      SELECT p.*,
             (p.new_item_id IS NOT NULL AND (
                NULLIF(btrim(p.new_note), '') IS DISTINCT FROM NULLIF(btrim(p.parent_note), '')
                OR EXISTS (SELECT e.kind, e.local_id FROM evidence e WHERE e.item_id = p.new_item_id
                           EXCEPT
                           SELECT e.kind, e.local_id FROM evidence e WHERE e.item_id = p.parent_item_id)
                OR EXISTS (SELECT e.kind, e.local_id FROM evidence e WHERE e.item_id = p.parent_item_id
                           EXCEPT
                           SELECT e.kind, e.local_id FROM evidence e WHERE e.item_id = p.new_item_id)
             )) AS changed
        FROM pairs p
       ORDER BY p.template_name, p.title
    LOOP
      -- Written once per parent item: a second call adds nothing.
      CONTINUE WHEN EXISTS (
        SELECT 1 FROM jsonb_array_elements(v_sub.history) AS h(e)
         WHERE h.e ->> 'type' = 'checklist_review_cleared'
           AND h.e ->> 'cleared_from_item_id' = r.parent_item_id::text);

      IF r.new_item_id IS NULL THEN
        v_removed := v_removed + 1;
        v_entries := v_entries || jsonb_build_array(jsonb_build_object(
          'type', 'checklist_review_cleared',
          'changed_at', v_now,
          'changed_by', v_uid,
          'reason', CASE WHEN r.added_by IS NOT NULL THEN 'not_carried' ELSE 'removed' END,
          'item_id', NULL,
          'cleared_from_item_id', r.parent_item_id,
          'item_title', r.title,
          'checklist_name', r.template_name,
          'cleared_reviewer_id', r.reviewer_checked_by,
          'cleared_reviewer_checked_at', r.reviewer_checked_at));
      ELSIF r.new_checked OR r.new_cleared IS NOT NULL THEN
        CONTINUE;
      ELSIF NOT r.changed THEN
        UPDATE public.submission_checklist_items
           SET reviewer_checked    = true,
               reviewer_checked_by = r.reviewer_checked_by,
               reviewer_checked_at = r.reviewer_checked_at
         WHERE id = r.new_item_id;
        v_carried := v_carried + 1;
      ELSE
        UPDATE public.submission_checklist_items
           SET cleared_reviewer_id = r.reviewer_checked_by,
               cleared_at          = v_now
         WHERE id = r.new_item_id;
        v_cleared := v_cleared + 1;
        v_entries := v_entries || jsonb_build_array(jsonb_build_object(
          'type', 'checklist_review_cleared',
          'changed_at', v_now,
          'changed_by', v_uid,
          'reason', 'edited',
          'item_id', r.new_item_id,
          'cleared_from_item_id', r.parent_item_id,
          'item_title', r.title,
          'checklist_name', r.template_name,
          'cleared_reviewer_id', r.reviewer_checked_by,
          'cleared_reviewer_checked_at', r.reviewer_checked_at));
      END IF;
    END LOOP;
  END IF;

  IF v_unavailable IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_sub.history) AS h(e)
                      WHERE h.e ->> 'type' = 'checklist_review_unavailable') THEN
    v_entries := v_entries || jsonb_build_array(jsonb_build_object(
      'type', 'checklist_review_unavailable',
      'changed_at', v_now,
      'changed_by', v_uid,
      'reason', v_unavailable));
  ELSE
    v_unavailable := NULL;
  END IF;

  IF jsonb_array_length(v_entries) > 0 THEN
    -- One statement: the append reads the row's current history.
    UPDATE public.transaction_submissions
       SET status_history = COALESCE(status_history, '[]'::jsonb) || v_entries
     WHERE id = v_sub.id;
  END IF;

  RETURN jsonb_build_object(
    'status', 'done',
    'carried', v_carried,
    'cleared', v_cleared,
    'removed', v_removed,
    'unavailable', v_unavailable);
END
$$;

REVOKE EXECUTE ON FUNCTION public.carry_submission_checklist_reviews(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.carry_submission_checklist_reviews(uuid) TO authenticated;

ALTER TABLE public.submission_checklists DROP CONSTRAINT IF EXISTS submission_checklists_removed_pair_check;
ALTER TABLE public.submission_checklist_items DROP COLUMN IF EXISTS restored_from_item_id;
ALTER TABLE public.submission_checklists
  DROP COLUMN IF EXISTS restored_from_checklist_id,
  DROP COLUMN IF EXISTS removed_at_review_at,
  DROP COLUMN IF EXISTS removed_at_review_by;
