-- BACKLOG-3607 (DRAFT, plan rev 2 pre-runs only; not the PR 1 file yet):
-- checklists removed and added at review, and between versions, recorded.
--
-- Applied AFTER the three 3596 files. Apply as ONE transaction. Safe to run
-- twice.
--
--   1. Columns: submission_checklists.removed_at_review_by/_at (both or
--      neither), submission_checklists.restored_from_checklist_id,
--      submission_checklist_items.restored_from_item_id.
--   2. The submitter's INSERT rules refuse all four (SR C-1).
--   3. set_submission_checklist_reviewer_check: + 'checklist_removed'.
--   4. add_submission_checklist_at_review: a template removed at review on
--      this version is un-removed ('readded').
--   5. carry_submission_checklist_reviews: + version diff (added / removed /
--      replaced), broker-removed checklists skipped, restored items compared
--      against their source, quiet empty snapshot for an org without the
--      feature.
--   6. remove_submission_checklist_at_review(checklist).
--   7. restore_submission_checklist_at_review(submission, source checklist).

-- ---------------------------------------------------------------------------
-- 1. Columns
-- ---------------------------------------------------------------------------
ALTER TABLE public.submission_checklists
  ADD COLUMN IF NOT EXISTS removed_at_review_by uuid NULL,
  ADD COLUMN IF NOT EXISTS removed_at_review_at timestamptz NULL,
  ADD COLUMN IF NOT EXISTS restored_from_checklist_id uuid NULL
    REFERENCES public.submission_checklists (id) ON DELETE SET NULL;
ALTER TABLE public.submission_checklist_items
  ADD COLUMN IF NOT EXISTS restored_from_item_id uuid NULL
    REFERENCES public.submission_checklist_items (id) ON DELETE SET NULL;

DO $constraints$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'submission_checklists_removed_pair_check'
                    AND conrelid = 'public.submission_checklists'::regclass) THEN
    ALTER TABLE public.submission_checklists
      ADD CONSTRAINT submission_checklists_removed_pair_check
      CHECK ((removed_at_review_by IS NULL) = (removed_at_review_at IS NULL));
  END IF;
END
$constraints$;

-- ---------------------------------------------------------------------------
-- 2. The submitter's INSERT rules: never a review-only value (SR C-1)
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS submission_checklists_insert ON public.submission_checklists;
CREATE POLICY submission_checklists_insert ON public.submission_checklists
  FOR INSERT TO authenticated
  WITH CHECK (
    submission_checklists.added_at_review_by IS NULL
    AND submission_checklists.added_at_review_at IS NULL
    AND submission_checklists.removed_at_review_by IS NULL
    AND submission_checklists.removed_at_review_at IS NULL
    AND submission_checklists.restored_from_checklist_id IS NULL
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
    AND submission_checklist_items.restored_from_item_id IS NULL
    AND EXISTS (
      SELECT 1
        FROM public.transaction_submissions ts
       WHERE ts.id = submission_checklist_items.submission_id
         AND ts.submitted_by = (SELECT auth.uid())
         AND ts.status = 'uploading'
    )
  );

-- ---------------------------------------------------------------------------
-- 3. The reviewer tick (20260928170000 section 1) + the checklist_removed refusal.
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
         h.template_name, h.added_at_review_by, h.removed_at_review_by,
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
  -- BACKLOG-3607: the broker removed this checklist at review.
  IF v_row.removed_at_review_by IS NOT NULL THEN
    RAISE EXCEPTION 'checklist_removed' USING ERRCODE = '42501';
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

-- ---------------------------------------------------------------------------
-- 4. Add at review (20260928130000 section 1) + un-remove on this version.
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
  v_removed_by uuid;
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

  SELECT h.id, h.removed_at_review_by INTO v_header_id, v_removed_by
    FROM public.submission_checklists h
   WHERE h.submission_id = p_submission_id
     AND h.template_id = p_template_id
     FOR UPDATE;
  IF FOUND AND v_removed_by IS NULL THEN
    RETURN jsonb_build_object('status', 'exists', 'checklist_id', v_header_id);
  END IF;
  -- BACKLOG-3607: removed at review on this version -> put it back (Undo).
  -- The unique index allows one header per template, so it is un-removed,
  -- never inserted twice. Its rows were never touched by the removal.
  IF FOUND THEN
    UPDATE public.submission_checklists
       SET removed_at_review_by = NULL, removed_at_review_at = NULL
     WHERE id = v_header_id;
    UPDATE public.transaction_submissions
       SET status_history = COALESCE(status_history, '[]'::jsonb) || jsonb_build_array(jsonb_build_object(
             'type', 'checklist_added',
             'changed_at', v_now,
             'changed_by', v_uid,
             'source', 'review',
             'readded', true,
             'checklist_id', v_header_id,
             'checklist_name', v_tpl.name,
             'template_id', v_tpl.id))
     WHERE id = p_submission_id;
    RETURN jsonb_build_object('status', 'readded', 'checklist_id', v_header_id);
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
-- 5. The carry (20260928170000 section 2) + the version diff, the broker-removal
--    filter, the restored-item baseline, and the quiet empty snapshot.
-- ---------------------------------------------------------------------------
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
  v_has_headers boolean;
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
  v_has_headers := EXISTS (SELECT 1 FROM public.submission_checklists h WHERE h.submission_id = v_sub.id);
  IF NOT COALESCE((public.check_feature_access(v_sub.organization_id, 'transaction_checklists') ->> 'allowed')::boolean, false) THEN
    -- BACKLOG-3607: the desktop sends [] when the transaction has no
    -- checklists; for an org without the feature that is not a refusal.
    IF NOT v_has_headers THEN
      RETURN jsonb_build_object('status', 'not_in_plan');
    END IF;
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


  -- BACKLOG-3607: which checklists the agent added or removed since the
  -- previous version. Keyed on template_id (name for a checklist with no
  -- template), never on header row ids (new every version). The previous
  -- version's checklists removed at review by the broker are not the agent's
  -- to remove. Runs before the no_checklists return, so a version sent with
  -- no checklist at all is recorded too. Written once per key and type.
  SELECT count(*) INTO v_parent_headers
    FROM public.submission_checklists h WHERE h.submission_id = v_parent.id;
  FOR r IN
    WITH ph AS (
      SELECT h.id, h.template_id, h.template_name, h.added_at_review_by, h.removed_at_review_by,
             COALESCE(h.template_id::text, 'name:' || h.template_name) AS k
        FROM public.submission_checklists h WHERE h.submission_id = v_parent.id
    ),
    nh AS (
      SELECT h.id, h.template_id, h.template_name,
             COALESCE(h.template_id::text, 'name:' || h.template_name) AS k
        FROM public.submission_checklists h WHERE h.submission_id = v_sub.id
    ),
    pkeys AS (
      SELECT i.submission_checklist_id AS hid,
             COALESCE(i.local_item_id, CASE WHEN h.added_at_review_by IS NOT NULL THEN i.id::text END) AS key
        FROM public.submission_checklist_items i
        JOIN public.submission_checklists h ON h.id = i.submission_checklist_id
       WHERE i.submission_id = v_parent.id
    ),
    nkeys AS (
      SELECT i.submission_checklist_id AS hid, i.local_item_id AS key
        FROM public.submission_checklist_items i
       WHERE i.submission_id = v_sub.id AND i.local_item_id IS NOT NULL
    ),
    d AS (
      SELECT 'checklist_removed' AS t, 1 AS ord, p.k, p.template_id, p.template_name,
             (p.added_at_review_by IS NOT NULL) AS was_added, false AS after_removal, false AS replaced, p.id AS src_id
        FROM ph p
       WHERE p.removed_at_review_by IS NULL
         AND NOT EXISTS (SELECT 1 FROM nh n WHERE n.k = p.k)
      UNION ALL
      SELECT 'checklist_added', 2, n.k, n.template_id, n.template_name, false,
             EXISTS (SELECT 1 FROM ph p WHERE p.k = n.k AND p.removed_at_review_by IS NOT NULL), false, NULL::uuid
        FROM nh n
       WHERE NOT EXISTS (SELECT 1 FROM ph p WHERE p.k = n.k AND p.removed_at_review_by IS NULL)
      UNION ALL
      -- Same template, but none of its items is the same item: removed and
      -- added again. Needs item keys on BOTH sides (an older desktop sends
      -- none, SR C-2). Only for the agent's own checklists: an added-at-review
      -- one that the pull could not key ('exists') is reported per item
      -- ('not_carried').
      SELECT x.t, x.ord, p.k, p.template_id, p.template_name, false, false, true,
             CASE WHEN x.t = 'checklist_removed' THEN p.id END
        FROM ph p
        JOIN nh n ON n.k = p.k
        CROSS JOIN (VALUES ('checklist_removed', 1), ('checklist_added', 2)) AS x(t, ord)
       WHERE p.removed_at_review_by IS NULL
         AND p.added_at_review_by IS NULL
         AND EXISTS (SELECT 1 FROM pkeys a WHERE a.hid = p.id AND a.key IS NOT NULL)
         AND EXISTS (SELECT 1 FROM nkeys b WHERE b.hid = n.id)
         AND NOT EXISTS (SELECT 1 FROM pkeys a JOIN nkeys b ON b.key = a.key WHERE a.hid = p.id AND b.hid = n.id)
    )
    SELECT DISTINCT t, ord, k, template_id, template_name, was_added, after_removal, replaced, src_id
      FROM d
     ORDER BY ord, template_name, k
  LOOP
    CONTINUE WHEN EXISTS (
      SELECT 1 FROM jsonb_array_elements(v_sub.history) AS h(e)
       WHERE h.e ->> 'type' = r.t
         AND h.e ->> 'source' = 'version'
         AND h.e ->> 'checklist_key' = r.k);
    v_entries := v_entries || jsonb_build_array(jsonb_build_object(
      'type', r.t,
      'changed_at', v_now,
      'changed_by', v_uid,
      'source', 'version',
      'checklist_key', r.k,
      'template_id', r.template_id,
      'checklist_name', r.template_name,
      'from_version', v_parent.version)
      -- the removed header itself: the portal's "Add it back" passes it to
      -- restore_submission_checklist_at_review unchanged.
      || CASE WHEN r.src_id IS NOT NULL THEN jsonb_build_object('removed_checklist_id', r.src_id) ELSE '{}'::jsonb END
      || CASE WHEN r.was_added AND r.t = 'checklist_removed' THEN jsonb_build_object('added_at_review', true) ELSE '{}'::jsonb END
      || CASE WHEN r.after_removal THEN jsonb_build_object('after_broker_removal', true) ELSE '{}'::jsonb END
      || CASE WHEN r.replaced THEN jsonb_build_object('replaced', true) ELSE '{}'::jsonb END
      || CASE WHEN r.t = 'checklist_added' AND v_parent_headers = 0 THEN jsonb_build_object('parent_had_none', true) ELSE '{}'::jsonb END);
  END LOOP;

  IF NOT v_has_headers THEN
    IF jsonb_array_length(v_entries) > 0 THEN
      UPDATE public.transaction_submissions
         SET status_history = COALESCE(status_history, '[]'::jsonb) || v_entries
       WHERE id = v_sub.id;
    END IF;
    RETURN jsonb_build_object('status', 'no_checklists');
  END IF;

  -- A concurrent tick on the parent waits for this transaction.
  PERFORM 1 FROM public.submission_checklist_items pi
   WHERE pi.submission_id = v_parent.id
     FOR SHARE;

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
               pi.reviewer_checked_by, pi.reviewer_checked_at,
               CASE WHEN si.id IS NOT NULL THEN si.note ELSE pi.note END AS parent_note,
               COALESCE(si.id, pi.id) AS base_item_id,
               ph.added_at_review_by AS added_by,
               ni.id AS new_item_id, ni.note AS new_note,
               ni.reviewer_checked AS new_checked, ni.cleared_reviewer_id AS new_cleared
          FROM public.submission_checklist_items pi
          JOIN public.submission_checklists ph ON ph.id = pi.submission_checklist_id
          LEFT JOIN public.submission_checklist_items si ON si.id = pi.restored_from_item_id
          LEFT JOIN (public.submission_checklist_items ni
                     JOIN public.submission_checklists nh ON nh.id = ni.submission_checklist_id)
            ON ni.submission_id = v_sub.id
           AND ni.local_item_id = COALESCE(pi.local_item_id, CASE WHEN ph.added_at_review_by IS NOT NULL THEN pi.id::text END)
           AND ni.title = pi.title
           AND nh.template_id IS NOT DISTINCT FROM ph.template_id
         WHERE pi.submission_id = v_parent.id
           AND pi.reviewer_checked
           AND (pi.local_item_id IS NOT NULL OR ph.added_at_review_by IS NOT NULL)
           AND ph.removed_at_review_by IS NULL
      ),
      evidence AS (
        SELECT DISTINCT l.submission_checklist_item_id AS item_id, lm.kind,
               COALESCE(a.local_attachment_id, m.local_message_id) AS local_id
          FROM public.submission_checklist_links l
          JOIN public.submission_checklist_link_members lm ON lm.link_id = l.id
          LEFT JOIN public.submission_attachments a ON a.id = lm.submission_attachment_id
          LEFT JOIN public.submission_messages m ON m.id = lm.submission_message_id
         WHERE (l.submission_id IN (v_sub.id, v_parent.id)
                OR l.submission_checklist_item_id IN (
                     SELECT ri.restored_from_item_id FROM public.submission_checklist_items ri
                      WHERE ri.submission_id = v_parent.id AND ri.restored_from_item_id IS NOT NULL))
           AND COALESCE(a.local_attachment_id, m.local_message_id) IS NOT NULL
      )
      SELECT p.*,
             (p.new_item_id IS NOT NULL AND (
                NULLIF(btrim(p.new_note), '') IS DISTINCT FROM NULLIF(btrim(p.parent_note), '')
                OR EXISTS (SELECT e.kind, e.local_id FROM evidence e WHERE e.item_id = p.new_item_id
                           EXCEPT
                           SELECT e.kind, e.local_id FROM evidence e WHERE e.item_id = p.base_item_id)
                OR EXISTS (SELECT e.kind, e.local_id FROM evidence e WHERE e.item_id = p.base_item_id
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

-- ---------------------------------------------------------------------------
-- 6. Remove a checklist at review. Soft: the rows stay as the record of what
--    the agent sent; the marker hides the checklist, refuses ticks on it,
--    keeps it out of the carry, and tells the desktop (pull) to remove it.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.remove_submission_checklist_at_review(
  p_checklist_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_uid   uuid := auth.uid();
  v_now   timestamptz := now();
  v_hdr   record;
  v_rm    record;
  v_links integer;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'not_authorized' USING ERRCODE = '42501';
  END IF;
  IF p_checklist_id IS NULL THEN
    RAISE EXCEPTION 'invalid_argument' USING ERRCODE = '22023';
  END IF;

  SELECT h.id, h.submission_id INTO v_hdr
    FROM public.submission_checklists h
   WHERE h.id = p_checklist_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_authorized' USING ERRCODE = '42501';
  END IF;

  -- The row lock that serializes this with the next version's insert (its
  -- parent_submission_id FK takes KEY SHARE on this row). SR C-8: pinned.
  SELECT ts.id AS rm_sub_id, ts.organization_id, ts.status
    INTO v_rm
    FROM public.transaction_submissions ts
   WHERE ts.id = v_hdr.submission_id
     FOR UPDATE;

  IF NOT FOUND OR NOT public.can_review_submission(v_rm.organization_id) THEN
    RAISE EXCEPTION 'not_authorized' USING ERRCODE = '42501';
  END IF;
  IF NOT COALESCE((public.check_feature_access(v_rm.organization_id, 'transaction_checklists') ->> 'allowed')::boolean, false) THEN
    RAISE EXCEPTION 'not_authorized' USING ERRCODE = '42501';
  END IF;
  IF v_rm.status IS NULL OR v_rm.status NOT IN ('submitted', 'resubmitted', 'under_review') THEN
    RAISE EXCEPTION 'not_open_for_review' USING ERRCODE = '42501';
  END IF;
  IF EXISTS (SELECT 1 FROM public.transaction_submissions c
              WHERE c.parent_submission_id = v_rm.rm_sub_id) THEN
    RAISE EXCEPTION 'superseded' USING ERRCODE = '42501';
  END IF;

  SELECT h.id, h.template_id, h.template_name, h.removed_at_review_by
    INTO v_hdr
    FROM public.submission_checklists h
   WHERE h.id = p_checklist_id
     FOR UPDATE;
  IF v_hdr.removed_at_review_by IS NOT NULL THEN
    RETURN jsonb_build_object('status', 'already_removed', 'checklist_id', v_hdr.id);
  END IF;

  -- Documents, not upload rows: one local file uploaded twice is one
  -- document (the carry's evidence identity).
  SELECT count(DISTINCT (lm.kind, COALESCE(a.local_attachment_id, m.local_message_id))) INTO v_links
    FROM public.submission_checklist_items i
    JOIN public.submission_checklist_links l ON l.submission_checklist_item_id = i.id
    JOIN public.submission_checklist_link_members lm ON lm.link_id = l.id
    LEFT JOIN public.submission_attachments a ON a.id = lm.submission_attachment_id
    LEFT JOIN public.submission_messages m ON m.id = lm.submission_message_id
   WHERE i.submission_checklist_id = v_hdr.id;

  UPDATE public.submission_checklists
     SET removed_at_review_by = v_uid,
         removed_at_review_at = v_now
   WHERE id = v_hdr.id;

  UPDATE public.transaction_submissions
     SET status_history = COALESCE(status_history, '[]'::jsonb) || jsonb_build_array(jsonb_build_object(
           'type', 'checklist_removed',
           'changed_at', v_now,
           'changed_by', v_uid,
           'source', 'review',
           'checklist_id', v_hdr.id,
           'checklist_key', COALESCE(v_hdr.template_id::text, 'name:' || v_hdr.template_name),
           'template_id', v_hdr.template_id,
           'checklist_name', v_hdr.template_name,
           'linked_documents', v_links))
   WHERE id = v_rm.rm_sub_id;

  RETURN jsonb_build_object('status', 'removed', 'checklist_id', v_hdr.id, 'linked_documents', v_links);
END
$$;

REVOKE EXECUTE ON FUNCTION public.remove_submission_checklist_at_review(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.remove_submission_checklist_at_review(uuid) TO authenticated;

-- ---------------------------------------------------------------------------
-- 7. Add back a checklist the agent removed (founder 6563bab2): the removed
--    checklist's items, with the broker's old ticks, onto the version under
--    review, as a checklist added at review. Source = the direct parent's
--    header; allowed only when this version's history records the agent's
--    removal. Never reads the template (an archived one still restores).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.restore_submission_checklist_at_review(
  p_submission_id uuid,
  p_source_checklist_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_uid    uuid := auth.uid();
  v_now    timestamptz := now();
  v_rs     record;
  v_par    record;
  v_src    record;
  v_key    text;
  v_here   record;
  v_new_id uuid;
  v_items  integer;
  v_ticks  integer;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'not_authorized' USING ERRCODE = '42501';
  END IF;
  IF p_submission_id IS NULL OR p_source_checklist_id IS NULL THEN
    RAISE EXCEPTION 'invalid_argument' USING ERRCODE = '22023';
  END IF;

  SELECT ts.id AS rs_id, ts.organization_id, ts.status, ts.submitted_by, ts.local_transaction_id,
         ts.version, ts.parent_submission_id, COALESCE(ts.status_history, '[]'::jsonb) AS history
    INTO v_rs
    FROM public.transaction_submissions ts
   WHERE ts.id = p_submission_id
     FOR UPDATE;

  IF NOT FOUND OR NOT public.can_review_submission(v_rs.organization_id) THEN
    RAISE EXCEPTION 'not_authorized' USING ERRCODE = '42501';
  END IF;
  IF NOT COALESCE((public.check_feature_access(v_rs.organization_id, 'transaction_checklists') ->> 'allowed')::boolean, false) THEN
    RAISE EXCEPTION 'not_authorized' USING ERRCODE = '42501';
  END IF;
  IF v_rs.status IS NULL OR v_rs.status NOT IN ('submitted', 'resubmitted', 'under_review') THEN
    RAISE EXCEPTION 'not_open_for_review' USING ERRCODE = '42501';
  END IF;
  IF EXISTS (SELECT 1 FROM public.transaction_submissions c
              WHERE c.parent_submission_id = v_rs.rs_id) THEN
    RAISE EXCEPTION 'superseded' USING ERRCODE = '42501';
  END IF;

  -- The source: a header of the DIRECT parent, qualified as the carry
  -- qualifies a parent (same org, deal, submitter, version = n - 1).
  SELECT p.id, p.version INTO v_par
    FROM public.transaction_submissions p
   WHERE p.id = v_rs.parent_submission_id
     AND p.organization_id = v_rs.organization_id
     AND p.local_transaction_id = v_rs.local_transaction_id
     AND p.submitted_by = v_rs.submitted_by
     AND v_rs.version IS NOT NULL AND p.version = v_rs.version - 1;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_authorized' USING ERRCODE = '42501';
  END IF;
  SELECT h.id, h.template_id, h.template_name, h.sort_order, h.removed_at_review_by
    INTO v_src
    FROM public.submission_checklists h
   WHERE h.id = p_source_checklist_id
     AND h.submission_id = v_par.id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_authorized' USING ERRCODE = '42501';
  END IF;

  v_key := COALESCE(v_src.template_id::text, 'name:' || v_src.template_name);
  IF v_src.removed_at_review_by IS NOT NULL
     OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_rs.history) AS h(e)
                     WHERE h.e ->> 'type' = 'checklist_removed'
                       AND h.e ->> 'source' = 'version'
                       AND h.e ->> 'checklist_key' = v_key) THEN
    RETURN jsonb_build_object('status', 'not_removed');
  END IF;

  SELECT h.id, h.removed_at_review_by INTO v_here
    FROM public.submission_checklists h
   WHERE h.submission_id = v_rs.rs_id
     AND COALESCE(h.template_id::text, 'name:' || h.template_name) = v_key
   ORDER BY h.removed_at_review_by NULLS FIRST
   LIMIT 1;
  IF FOUND AND v_here.removed_at_review_by IS NULL THEN
    RETURN jsonb_build_object('status', 'already_present', 'checklist_id', v_here.id);
  END IF;
  -- Removed at review on this version: the broker undoes that removal (add
  -- RPC, 'readded'); the one-header-per-template index forbids a second.
  IF FOUND THEN
    RETURN jsonb_build_object('status', 'removed_here', 'checklist_id', v_here.id);
  END IF;

  INSERT INTO public.submission_checklists
    (submission_id, template_id, template_name, sort_order, added_at_review_by, added_at_review_at,
     restored_from_checklist_id)
  VALUES (v_rs.rs_id, v_src.template_id, v_src.template_name, v_src.sort_order, v_uid, v_now, v_src.id)
  RETURNING id INTO v_new_id;

  -- Titles, required flags and order from the removed checklist; the
  -- broker's ticks with their ORIGINAL reviewer and time. Never the agent's
  -- own state (tick, note, links, local id): it is gone from the desktop.
  INSERT INTO public.submission_checklist_items
    (submission_id, submission_checklist_id, title, description, is_required,
     expected_document_type, is_checked, sort_order,
     reviewer_checked, reviewer_checked_by, reviewer_checked_at, restored_from_item_id)
  SELECT v_rs.rs_id, v_new_id, si.title, si.description, si.is_required,
         si.expected_document_type, false, si.sort_order,
         si.reviewer_checked, si.reviewer_checked_by, si.reviewer_checked_at, si.id
    FROM public.submission_checklist_items si
   WHERE si.submission_checklist_id = v_src.id;
  GET DIAGNOSTICS v_items = ROW_COUNT;
  SELECT count(*) INTO v_ticks
    FROM public.submission_checklist_items i
   WHERE i.submission_checklist_id = v_new_id AND i.reviewer_checked;

  UPDATE public.transaction_submissions
     SET status_history = COALESCE(status_history, '[]'::jsonb) || jsonb_build_array(jsonb_build_object(
           'type', 'checklist_added',
           'changed_at', v_now,
           'changed_by', v_uid,
           'source', 'review',
           'restored', true,
           'restored_from_version', v_par.version,
           'restored_from_checklist_id', v_src.id,
           'checklist_id', v_new_id,
           'checklist_key', v_key,
           'template_id', v_src.template_id,
           'checklist_name', v_src.template_name,
           'ticks_restored', v_ticks))
   WHERE id = v_rs.rs_id;

  RETURN jsonb_build_object('status', 'restored', 'checklist_id', v_new_id,
                            'items', v_items, 'ticks_restored', v_ticks);
END
$$;

REVOKE EXECUTE ON FUNCTION public.restore_submission_checklist_at_review(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.restore_submission_checklist_at_review(uuid, uuid) TO authenticated;
