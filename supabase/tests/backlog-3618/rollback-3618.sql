-- BACKLOG-3618 rollback. Run as ONE transaction (`psql -1 -f`), AFTER the
-- portal and desktop changes that call the new functions are reverted.
-- Restores 20260921101757 section 5a/5b policies, 20260924190429
-- save_checklist_template, 20260929120000 add_submission_checklist_at_review
-- and 20260928120000 snapshot_submission_checklists, all verbatim.
--
-- FIRST: every template with an owner is deleted (its items cascade).
-- Dropping the column alone would leave those rows as brokerage templates.
-- Submitted copies (submission_checklists) do not reference templates and
-- are untouched.

DELETE FROM public.checklist_templates WHERE owner_user_id IS NOT NULL;

DROP POLICY IF EXISTS checklist_templates_insert_writer ON public.checklist_templates;
DROP POLICY IF EXISTS checklist_templates_update_writer ON public.checklist_templates;
DROP POLICY IF EXISTS checklist_template_items_insert_writer ON public.checklist_template_items;
DROP POLICY IF EXISTS checklist_template_items_update_writer ON public.checklist_template_items;
DROP POLICY IF EXISTS checklist_template_items_delete_writer ON public.checklist_template_items;
DROP POLICY IF EXISTS checklist_templates_select_member ON public.checklist_templates;
CREATE POLICY checklist_templates_select_member ON public.checklist_templates
  FOR SELECT TO authenticated
  USING (checklist_templates.organization_id IN (SELECT public.get_user_org_ids((SELECT auth.uid()))));
DROP POLICY IF EXISTS checklist_templates_insert_editor ON public.checklist_templates;
CREATE POLICY checklist_templates_insert_editor ON public.checklist_templates
  FOR INSERT TO authenticated
  WITH CHECK (public.can_edit_checklist_templates(checklist_templates.organization_id));
DROP POLICY IF EXISTS checklist_templates_update_editor ON public.checklist_templates;
CREATE POLICY checklist_templates_update_editor ON public.checklist_templates
  FOR UPDATE TO authenticated
  USING (public.can_edit_checklist_templates(checklist_templates.organization_id))
  WITH CHECK (public.can_edit_checklist_templates(checklist_templates.organization_id));
DROP POLICY IF EXISTS checklist_template_items_select_member ON public.checklist_template_items;
CREATE POLICY checklist_template_items_select_member ON public.checklist_template_items
  FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1
      FROM public.checklist_templates t
     WHERE t.id = checklist_template_items.template_id
       AND t.organization_id IN (SELECT public.get_user_org_ids((SELECT auth.uid())))
  ));
DROP POLICY IF EXISTS checklist_template_items_insert_editor ON public.checklist_template_items;
CREATE POLICY checklist_template_items_insert_editor ON public.checklist_template_items
  FOR INSERT TO authenticated
  WITH CHECK (EXISTS (
    SELECT 1
      FROM public.checklist_templates t
     WHERE t.id = checklist_template_items.template_id
       AND public.can_edit_checklist_templates(t.organization_id)
  ));
DROP POLICY IF EXISTS checklist_template_items_update_editor ON public.checklist_template_items;
CREATE POLICY checklist_template_items_update_editor ON public.checklist_template_items
  FOR UPDATE TO authenticated
  USING (EXISTS (
    SELECT 1
      FROM public.checklist_templates t
     WHERE t.id = checklist_template_items.template_id
       AND public.can_edit_checklist_templates(t.organization_id)
  ))
  WITH CHECK (EXISTS (
    SELECT 1
      FROM public.checklist_templates t
     WHERE t.id = checklist_template_items.template_id
       AND public.can_edit_checklist_templates(t.organization_id)
  ));
DROP POLICY IF EXISTS checklist_template_items_delete_editor ON public.checklist_template_items;
CREATE POLICY checklist_template_items_delete_editor ON public.checklist_template_items
  FOR DELETE TO authenticated
  USING (EXISTS (
    SELECT 1
      FROM public.checklist_templates t
     WHERE t.id = checklist_template_items.template_id
       AND public.can_edit_checklist_templates(t.organization_id)
  ));

DROP FUNCTION IF EXISTS public.save_checklist_template(uuid, uuid, text, text, text, jsonb, boolean, boolean);
CREATE OR REPLACE FUNCTION public.save_checklist_template(
  p_org_id uuid,
  p_template_id uuid,
  p_expected_updated_at text,
  p_name text,
  p_description text,
  p_items jsonb
)
RETURNS TABLE (id uuid, updated_at text)
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
#variable_conflict use_column
DECLARE
  v_template_id uuid;
  v_updated_at  timestamptz;
  v_id_elems    integer;
  v_updated     integer;
BEGIN
  IF NOT public.can_edit_checklist_templates(p_org_id) THEN
    RAISE EXCEPTION 'not_authorized' USING ERRCODE = '42501';
  END IF;

  IF p_items IS NULL
     OR jsonb_typeof(p_items) <> 'array'
     OR jsonb_array_length(p_items) NOT BETWEEN 1 AND 200
     OR EXISTS (SELECT 1 FROM jsonb_array_elements(p_items) AS e(value) WHERE jsonb_typeof(e.value) <> 'object') THEN
    RAISE EXCEPTION 'invalid_items' USING ERRCODE = '22023';
  END IF;

  SELECT count(*) INTO v_id_elems
    FROM jsonb_array_elements(p_items) AS e(value)
   WHERE e.value->>'id' IS NOT NULL;

  IF p_template_id IS NULL THEN
    IF v_id_elems > 0 THEN
      RAISE EXCEPTION 'item_mismatch';
    END IF;
    INSERT INTO public.checklist_templates AS t (organization_id, name, description, sort_order)
    VALUES (
      p_org_id,
      btrim(p_name),
      NULLIF(btrim(p_description), ''),
      COALESCE((SELECT max(x.sort_order) FROM public.checklist_templates AS x WHERE x.organization_id = p_org_id), 0) + 10
    )
    RETURNING t.id, t.updated_at INTO v_template_id, v_updated_at;
  ELSE
    -- Runs on EVERY save, item-only saves included: the row lock serialises
    -- concurrent saves and the updated_at trigger moves the token.
    UPDATE public.checklist_templates AS t
       SET name = btrim(p_name),
           description = NULLIF(btrim(p_description), '')
     WHERE t.id = p_template_id
       AND t.organization_id = p_org_id
       AND t.updated_at = p_expected_updated_at::timestamptz
    RETURNING t.id, t.updated_at INTO v_template_id, v_updated_at;
    IF v_template_id IS NULL THEN
      RAISE EXCEPTION 'stale_or_not_found';
    END IF;
  END IF;

  -- Items absent from the payload. Only non-null ids: a NULL in the array
  -- would make `<> ALL` NULL and delete nothing.
  DELETE FROM public.checklist_template_items AS i
   WHERE i.template_id = v_template_id
     AND i.id <> ALL (ARRAY(
           SELECT (e.value->>'id')::uuid
             FROM jsonb_array_elements(p_items) AS e(value)
            WHERE e.value->>'id' IS NOT NULL));

  UPDATE public.checklist_template_items AS i
     SET title = btrim(e.value->>'title'),
         description = NULLIF(btrim(e.value->>'description'), ''),
         is_required = COALESCE((e.value->>'is_required')::boolean, false),
         expected_document_type = NULLIF(e.value->>'expected_document_type', ''),
         sort_order = (e.ordinality * 10)::integer
    FROM jsonb_array_elements(p_items) WITH ORDINALITY AS e(value, ordinality)
   WHERE e.value->>'id' IS NOT NULL
     AND i.id = (e.value->>'id')::uuid
     AND i.template_id = v_template_id;
  GET DIAGNOSTICS v_updated = ROW_COUNT;

  -- One row per id-bearing element: a repeated id updates one row, a foreign
  -- id updates none.
  IF v_updated <> v_id_elems THEN
    RAISE EXCEPTION 'item_mismatch';
  END IF;

  INSERT INTO public.checklist_template_items
    (template_id, title, description, is_required, expected_document_type, sort_order)
  SELECT v_template_id,
         btrim(e.value->>'title'),
         NULLIF(btrim(e.value->>'description'), ''),
         COALESCE((e.value->>'is_required')::boolean, false),
         NULLIF(e.value->>'expected_document_type', ''),
         (e.ordinality * 10)::integer
    FROM jsonb_array_elements(p_items) WITH ORDINALITY AS e(value, ordinality)
   WHERE e.value->>'id' IS NULL;

  RETURN QUERY SELECT v_template_id, to_json(v_updated_at) #>> '{}';
END
$$;

REVOKE EXECUTE ON FUNCTION public.save_checklist_template(uuid, uuid, text, text, text, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.save_checklist_template(uuid, uuid, text, text, text, jsonb) TO authenticated;

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

DROP FUNCTION IF EXISTS public.can_write_checklist_template(uuid, uuid);
DROP FUNCTION IF EXISTS public.can_create_own_checklist_templates(uuid);

ALTER TABLE public.checklist_templates DROP CONSTRAINT IF EXISTS checklist_templates_include_owner_check;
DROP INDEX IF EXISTS public.checklist_templates_owner_idx;
ALTER TABLE public.checklist_templates DROP COLUMN IF EXISTS include_in_submission;
ALTER TABLE public.checklist_templates DROP COLUMN IF EXISTS owner_user_id;
