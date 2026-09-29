-- BACKLOG-3596: broker-owned checklist ticks carried across versions.
--
-- What this file changes (one file, applied in one transaction; it opens none
-- of its own, and every statement is safe to run twice):
--
--   1. submission_checklist_items: local_item_id (the desktop's own item id,
--      stable across versions; the row itself stays per version),
--      cleared_reviewer_id / cleared_at (a reviewer tick that did not carry
--      because the item changed), a pair CHECK on the cleared columns, and one
--      local item id per submission.
--   2. The submitter's INSERT rule on items also refuses cleared values.
--   3. public.carry_submission_checklist_reviews(submission): copies the
--      reviewer's ticks from the parent version onto the new version.
--   4. public.snapshot_submission_checklists(submission, payload): reads each
--      item's local_item_id and calls the carry as its last statement, so the
--      copy and the carry are one transaction. Still SECURITY INVOKER.
--   5. public.set_submission_checklist_reviewer_check(item, checked): refuses
--      a version that already has a newer version (in any status).
--   6. transaction_submissions_update_public: the reviewer branch admits only
--      rows open for a decision (submitted, resubmitted, under_review). The
--      submitter branch and the WITH CHECK are unchanged.
--
-- Carry rules (3.), parent only:
--   The parent must be the same organization, deal (local_transaction_id)
--   and submitter, and its version must be this version - 1; otherwise 42501.
--   An item matches its parent item on local_item_id AND title AND the
--   header's template_id. For every matched parent item the reviewer ticked:
--     unchanged -> ticked on the new version with the parent's
--                  reviewer_checked_by and reviewer_checked_at, verbatim; no
--                  Status History entry.
--     changed   -> left unticked; cleared_reviewer_id / cleared_at set; one
--                  'checklist_review_cleared' entry (reason 'edited').
--   Changed = the note differs (blank and NULL are equal) OR the set of
--   (kind, desktop id) of the item's evidence differs. The desktop ids are
--   submission_attachments.local_attachment_id and
--   submission_messages.local_message_id, read from what each version's link
--   members actually point at. Cloud row ids are never compared.
--   A ticked parent item with a local_item_id and no match -> one
--   'checklist_review_cleared' entry (reason 'removed'). A parent item with
--   no local_item_id (written before this file) -> nothing.
--   Every entry names the calling submitter as changed_by; the entry's type
--   says the clearing was automatic. No other actor exists.
--
-- 'checklist_review_unavailable' (one entry per version, at most):
--   reason 'unmatched_client'  the new version has items but none carries a
--                              local_item_id (an older desktop), and the
--                              parent has at least one reviewer tick
--   reason 'no_previous_copy'  the parent has no checklist copy, and an
--                              earlier version of the same deal by the same
--                              submitter has a reviewer tick
--   Nothing is carried in either case.
--
-- Status History entry shapes written here (typed, append-only; the
-- append-only trigger from BACKLOG-3477 is not changed):
--   checklist_review_cleared      type, changed_at, changed_by, reason,
--                                 item_id (new version's item; NULL when
--                                 removed), cleared_from_item_id (parent
--                                 item), item_title, checklist_name,
--                                 cleared_reviewer_id,
--                                 cleared_reviewer_checked_at
--   checklist_review_unavailable  type, changed_at, changed_by, reason
--
-- Errors raised:
--   42501 not_authorized  (carry) no caller, caller is not the submitter, the
--                         version is not uploading, the feature is off, or the
--                         parent does not qualify
--   42501 superseded      (tick) the version already has a newer version,
--                         including one still being submitted
--
-- A version with no parent: the carry writes nothing and returns
-- {status: 'no_parent'}. A version with no checklist copy: nothing, and
-- {status: 'no_checklists'}.
--
-- Rollback: supabase/tests/backlog-3596/rollback.sql (tested by the harness).

-- ---------------------------------------------------------------------------
-- 1. Item columns
-- ---------------------------------------------------------------------------
ALTER TABLE public.submission_checklist_items
  ADD COLUMN IF NOT EXISTS local_item_id text NULL,
  ADD COLUMN IF NOT EXISTS cleared_reviewer_id uuid NULL,
  ADD COLUMN IF NOT EXISTS cleared_at timestamptz NULL;

DO $constraints$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'submission_checklist_items_cleared_pair_check'
                    AND conrelid = 'public.submission_checklist_items'::regclass) THEN
    ALTER TABLE public.submission_checklist_items
      ADD CONSTRAINT submission_checklist_items_cleared_pair_check
      CHECK ((cleared_reviewer_id IS NULL) = (cleared_at IS NULL));
  END IF;
END
$constraints$;

CREATE UNIQUE INDEX IF NOT EXISTS submission_checklist_items_submission_local_item_key
  ON public.submission_checklist_items (submission_id, local_item_id)
  WHERE local_item_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 2. The submitter's INSERT rule on items: never a reviewer or cleared value
-- ---------------------------------------------------------------------------
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

-- ---------------------------------------------------------------------------
-- 3. Carry the reviewer's ticks from the parent version.
--    Every reviewer value written comes from the parent's rows. Nothing is
--    read from the desktop's payload except what the snapshot already wrote
--    into this version's rows.
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
               ni.id AS new_item_id, ni.note AS new_note,
               ni.reviewer_checked AS new_checked, ni.cleared_reviewer_id AS new_cleared
          FROM public.submission_checklist_items pi
          JOIN public.submission_checklists ph ON ph.id = pi.submission_checklist_id
          LEFT JOIN (public.submission_checklist_items ni
                     JOIN public.submission_checklists nh ON nh.id = ni.submission_checklist_id)
            ON ni.submission_id = v_sub.id
           AND ni.local_item_id = pi.local_item_id
           AND ni.title = pi.title
           AND nh.template_id IS NOT DISTINCT FROM ph.template_id
         WHERE pi.submission_id = v_parent.id
           AND pi.reviewer_checked
           AND pi.local_item_id IS NOT NULL
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
          'reason', 'removed',
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
-- 4. The desktop's snapshot (BACKLOG-3477 section 6), plus local_item_id per
--    item and the carry as the last statement.
--
--   p_checklists: JSON array of
--     {template_id?, template_name, sort_order?,
--      items: [{title, local_item_id?, description?, is_required?,
--               expected_document_type?, is_checked?, note?, sort_order?,
--               links: [{kind: 'attachment'|'email', label, sort_order?,
--                        local_ids: [text, ...]}]}]}
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.snapshot_submission_checklists(
  p_submission_id uuid,
  p_checklists jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  c            jsonb;
  it           jsonb;
  lk           jsonb;
  v_header_id  uuid;
  v_item_id    uuid;
  v_link_id    uuid;
  v_kind       text;
  v_local_ids  text[];
  v_targets    uuid[];
  v_asked      integer;
  v_link_dropped integer;
  v_carry      jsonb;
  n_checklists integer := 0;
  n_items      integer := 0;
  n_links      integer := 0;
  n_members    integer := 0;
  n_dropped_members integer := 0;
  n_dropped_links   integer := 0;
BEGIN
  IF p_submission_id IS NULL OR p_checklists IS NULL OR jsonb_typeof(p_checklists) <> 'array' THEN
    RAISE EXCEPTION 'invalid_payload' USING ERRCODE = '22023';
  END IF;

  FOR c IN SELECT e.value FROM jsonb_array_elements(p_checklists) AS e(value) LOOP
    IF jsonb_typeof(c) <> 'object'
       OR (c ? 'items' AND jsonb_typeof(c -> 'items') <> 'array') THEN
      RAISE EXCEPTION 'invalid_payload' USING ERRCODE = '22023';
    END IF;

    INSERT INTO public.submission_checklists (submission_id, template_id, template_name, sort_order)
    VALUES (p_submission_id,
            NULLIF(c ->> 'template_id', '')::uuid,
            c ->> 'template_name',
            COALESCE((c ->> 'sort_order')::integer, 0))
    RETURNING id INTO v_header_id;
    n_checklists := n_checklists + 1;

    FOR it IN SELECT e.value FROM jsonb_array_elements(COALESCE(c -> 'items', '[]'::jsonb)) AS e(value) LOOP
      IF jsonb_typeof(it) <> 'object'
         OR (it ? 'links' AND jsonb_typeof(it -> 'links') <> 'array') THEN
        RAISE EXCEPTION 'invalid_payload' USING ERRCODE = '22023';
      END IF;

      INSERT INTO public.submission_checklist_items
        (submission_id, submission_checklist_id, title, local_item_id, description, is_required,
         expected_document_type, is_checked, note, sort_order)
      VALUES (p_submission_id, v_header_id,
              it ->> 'title',
              NULLIF(it ->> 'local_item_id', ''),
              it ->> 'description',
              COALESCE((it ->> 'is_required')::boolean, false),
              it ->> 'expected_document_type',
              COALESCE((it ->> 'is_checked')::boolean, false),
              it ->> 'note',
              COALESCE((it ->> 'sort_order')::integer, 0))
      RETURNING id INTO v_item_id;
      n_items := n_items + 1;

      FOR lk IN SELECT e.value FROM jsonb_array_elements(COALESCE(it -> 'links', '[]'::jsonb)) AS e(value) LOOP
        v_kind := lk ->> 'kind';
        IF jsonb_typeof(lk) <> 'object'
           OR v_kind IS NULL OR v_kind NOT IN ('attachment', 'email')
           OR (lk ? 'local_ids' AND jsonb_typeof(lk -> 'local_ids') <> 'array') THEN
          RAISE EXCEPTION 'invalid_payload' USING ERRCODE = '22023';
        END IF;

        SELECT COALESCE(array_agg(DISTINCT x.value), '{}')
          INTO v_local_ids
          FROM jsonb_array_elements_text(COALESCE(lk -> 'local_ids', '[]'::jsonb)) AS x(value);
        v_asked := COALESCE(cardinality(v_local_ids), 0);

        IF v_kind = 'attachment' THEN
          SELECT COALESCE(array_agg(a.id), '{}'), v_asked - count(DISTINCT a.local_attachment_id)::integer
            INTO v_targets, v_link_dropped
            FROM public.submission_attachments a
           WHERE a.submission_id = p_submission_id
             AND a.local_attachment_id = ANY (v_local_ids);
        ELSE
          SELECT COALESCE(array_agg(m.id), '{}'), v_asked - count(DISTINCT m.local_message_id)::integer
            INTO v_targets, v_link_dropped
            FROM public.submission_messages m
           WHERE m.submission_id = p_submission_id
             AND m.channel = 'email'
             AND m.local_message_id = ANY (v_local_ids);
        END IF;
        n_dropped_members := n_dropped_members + v_link_dropped;

        IF COALESCE(cardinality(v_targets), 0) = 0 THEN
          n_dropped_links := n_dropped_links + 1;
          CONTINUE;
        END IF;

        INSERT INTO public.submission_checklist_links
          (submission_id, submission_checklist_item_id, kind, label, sort_order)
        VALUES (p_submission_id, v_item_id, v_kind, lk ->> 'label',
                COALESCE((lk ->> 'sort_order')::integer, 0))
        RETURNING id INTO v_link_id;
        n_links := n_links + 1;

        IF v_kind = 'attachment' THEN
          INSERT INTO public.submission_checklist_link_members
            (submission_id, link_id, kind, submission_attachment_id)
          SELECT p_submission_id, v_link_id, 'attachment', t.id
            FROM unnest(v_targets) AS t(id)
          ON CONFLICT (link_id, submission_attachment_id) DO NOTHING;
        ELSE
          INSERT INTO public.submission_checklist_link_members
            (submission_id, link_id, kind, submission_message_id)
          SELECT p_submission_id, v_link_id, 'email', t.id
            FROM unnest(v_targets) AS t(id)
          ON CONFLICT (link_id, submission_message_id) DO NOTHING;
        END IF;
        n_members := n_members + cardinality(v_targets);
      END LOOP;
    END LOOP;
  END LOOP;

  -- Last: every item and link member of this version exists by now.
  v_carry := public.carry_submission_checklist_reviews(p_submission_id);

  RETURN jsonb_build_object(
    'checklists', n_checklists,
    'items', n_items,
    'links', n_links,
    'members', n_members,
    'dropped_members', n_dropped_members,
    'dropped_links', n_dropped_links,
    'carry', v_carry);
END
$$;

REVOKE EXECUTE ON FUNCTION public.snapshot_submission_checklists(uuid, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.snapshot_submission_checklists(uuid, jsonb) TO authenticated;

-- ---------------------------------------------------------------------------
-- 5. The reviewer tick (BACKLOG-3477 section 7), plus: a version that already
--    has a newer version is closed to ticks. Checked after the authorization
--    checks, so an outsider still reads not_authorized.
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
-- 6. transaction_submissions UPDATE rule (BACKLOG-3592). Copied from
--    pg_policies (2026-09-28); the only change is the status list on the
--    reviewer branch's USING. A reviewer's decision on a version that is not
--    open (needs_changes, approved, rejected, uploading) now matches no row.
--    The submitter branch, the WITH CHECK and the role list are unchanged.
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS transaction_submissions_update_public ON public.transaction_submissions;
CREATE POLICY transaction_submissions_update_public ON public.transaction_submissions
  FOR UPDATE TO public
  USING (
    ((submitted_by = ( SELECT auth.uid() AS uid)) AND ((status)::text = ANY (ARRAY['needs_changes'::text, 'uploading'::text])))
    OR (((status)::text = ANY (ARRAY['submitted'::text, 'resubmitted'::text, 'under_review'::text]))
        AND (organization_id IN ( SELECT organization_members.organization_id
           FROM organization_members
          WHERE ((organization_members.user_id = ( SELECT auth.uid() AS uid)) AND ((organization_members.role)::text = ANY (ARRAY[('broker'::character varying)::text, ('admin'::character varying)::text]))))))
  )
  WITH CHECK (
    ((submitted_by = ( SELECT auth.uid() AS uid)) AND ((status)::text = ANY (ARRAY['needs_changes'::text, 'resubmitted'::text, 'uploading'::text, 'submitted'::text])))
    OR (organization_id IN ( SELECT organization_members.organization_id
       FROM organization_members
      WHERE ((organization_members.user_id = ( SELECT auth.uid() AS uid)) AND ((organization_members.role)::text = ANY (ARRAY[('broker'::character varying)::text, ('admin'::character varying)::text])))))
  );
