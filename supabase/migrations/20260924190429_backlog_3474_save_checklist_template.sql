-- BACKLOG-3474: save a checklist template and its whole item list in one call.
--
-- The broker portal's template editor has one "Save changes" that writes the
-- name, the description and every item (edits, additions, removals, order).
-- This function does all of it in one statement's transaction, so a failure
-- part-way leaves the template exactly as it was.
--
--   p_org_id              the caller's organization (the portal passes the one
--                         its server-side gate resolved)
--   p_template_id         NULL creates a template; otherwise the template to save
--   p_expected_updated_at the template's updated_at exactly as the page read it
--                         (text, compared at full precision); ignored on create
--   p_name, p_description template fields
--   p_items               JSON array, 1..200 objects, in display order:
--                         {id?, title, description?, is_required?, expected_document_type?}
--                         an element with an id updates that item of THIS
--                         template; an element without one inserts a new item;
--                         an existing item absent from the array is deleted.
--
-- Returns one row: the template id and its new updated_at, serialised the way
-- PostgREST serialises a timestamptz, for the page's next save.
--
-- Errors:
--   42501 not_authorized      caller may not edit this organization's templates
--   22023 invalid_items       p_items is not an array of 1..200 objects
--   P0001 stale_or_not_found  the template changed since it was read, or is not
--                             in p_org_id
--   P0001 item_mismatch       an item id is repeated, belongs to another
--                             template, or is given on create
--   23514 / 23502             a field breaks a table CHECK / NOT NULL
--
-- Rollback: DROP FUNCTION public.save_checklist_template(uuid, uuid, text, text, text, jsonb);

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
