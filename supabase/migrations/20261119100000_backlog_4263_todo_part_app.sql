-- ============================================================================
-- Migration: the AI app's provider on each todo part; the note's author on a submission's checklist items
-- (BACKLOG-4263 PR-11a)
--
-- cloud_deal_checklist_items:
--   columns done_app, note_app (text NULL; 'anthropic' | 'openai')
--   trigger cloud_deal_checklist_items_part_app, BEFORE INSERT OR UPDATE OF done_rev, done_by, note_rev, note_by,
--     function _cloud_todo_part_app() (search_path '', no API role). Per part (done, note): on INSERT, or when the
--     part's _rev changes, <part>_app is set to the provider of the mcp_connections row named by <part>_by
--     ('ai_app:<connection id>', same owner), else NULL. A ref that is not a uuid gives NULL. Other writes keep it.
--   _cloud_todo_item_json: the done and note parts carry 'app'.
-- submission_checklist_items:
--   columns attribution_v (smallint NULL, 1), note_by_kind (text NULL, 'agent' | 'ai_app'),
--   note_by_app (text NULL, 'anthropic' | 'openai'), with CHECKs.
--   snapshot_submission_checklists(uuid, jsonb): same signature, SECURITY INVOKER, same grants; reads the optional
--     item keys attribution_v (stored when it is the number 1) and note_by {kind, app}; a malformed value is
--     stored as NULL. Every other check and write is as before.
-- No existing row is rewritten.
-- Pre-check: _cloud_todo_item_json and snapshot_submission_checklists are at the bodies traced below, or already at
--   this file's bodies; exactly one snapshot_submission_checklists exists.
-- Rollback: supabase/tests/backlog-4263-pr11/rollback-20261119100000.sql
-- ============================================================================

DO $precheck4263w$
DECLARE v_md5 text; v_src text; v_n integer;
BEGIN
  SELECT md5(p.prosrc), p.prosrc INTO v_md5, v_src FROM pg_catalog.pg_proc p
   WHERE p.oid = to_regprocedure('public._cloud_todo_item_json(public.cloud_deal_checklist_items)');
  IF v_md5 IS DISTINCT FROM 'dadfcc2f94a1bac429089ef4aa7b0d5b' AND position('/*BODY:4263-11a-item*/' IN coalesce(v_src, '')) = 0 THEN
    RAISE EXCEPTION 'BACKLOG-4263 PR-11a: _cloud_todo_item_json is not at the traced body (md5 %)', coalesce(v_md5, 'missing');
  END IF;
  SELECT md5(p.prosrc), p.prosrc INTO v_md5, v_src FROM pg_catalog.pg_proc p
   WHERE p.oid = to_regprocedure('public.snapshot_submission_checklists(uuid,jsonb)');
  IF v_md5 IS DISTINCT FROM '18168cc44ba03fadbd0de896e59806ea' AND position('/*BODY:4263-11a-snapshot*/' IN coalesce(v_src, '')) = 0 THEN
    RAISE EXCEPTION 'BACKLOG-4263 PR-11a: snapshot_submission_checklists is not at the traced body (md5 %)', coalesce(v_md5, 'missing');
  END IF;
  SELECT count(*) INTO v_n FROM pg_catalog.pg_proc p
   WHERE p.pronamespace = 'public'::regnamespace AND p.proname = 'snapshot_submission_checklists';
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'BACKLOG-4263 PR-11a: % functions named snapshot_submission_checklists, expected 1', v_n;
  END IF;
END
$precheck4263w$;

-- ============================================================================ columns
ALTER TABLE public.cloud_deal_checklist_items
  ADD COLUMN IF NOT EXISTS done_app text NULL,
  ADD COLUMN IF NOT EXISTS note_app text NULL;
ALTER TABLE public.cloud_deal_checklist_items DROP CONSTRAINT IF EXISTS cloud_deal_checklist_items_done_app_ck;
ALTER TABLE public.cloud_deal_checklist_items ADD CONSTRAINT cloud_deal_checklist_items_done_app_ck
  CHECK (done_app IS NULL OR done_app IN ('anthropic', 'openai'));
ALTER TABLE public.cloud_deal_checklist_items DROP CONSTRAINT IF EXISTS cloud_deal_checklist_items_note_app_ck;
ALTER TABLE public.cloud_deal_checklist_items ADD CONSTRAINT cloud_deal_checklist_items_note_app_ck
  CHECK (note_app IS NULL OR note_app IN ('anthropic', 'openai'));

ALTER TABLE public.submission_checklist_items
  ADD COLUMN IF NOT EXISTS attribution_v smallint NULL,
  ADD COLUMN IF NOT EXISTS note_by_kind  text NULL,
  ADD COLUMN IF NOT EXISTS note_by_app   text NULL;
ALTER TABLE public.submission_checklist_items DROP CONSTRAINT IF EXISTS submission_checklist_items_attribution_v_ck;
ALTER TABLE public.submission_checklist_items ADD CONSTRAINT submission_checklist_items_attribution_v_ck
  CHECK (attribution_v IS NULL OR attribution_v = 1);
ALTER TABLE public.submission_checklist_items DROP CONSTRAINT IF EXISTS submission_checklist_items_note_by_kind_ck;
ALTER TABLE public.submission_checklist_items ADD CONSTRAINT submission_checklist_items_note_by_kind_ck
  CHECK (note_by_kind IS NULL OR note_by_kind IN ('agent', 'ai_app'));
ALTER TABLE public.submission_checklist_items DROP CONSTRAINT IF EXISTS submission_checklist_items_note_by_app_ck;
ALTER TABLE public.submission_checklist_items ADD CONSTRAINT submission_checklist_items_note_by_app_ck
  CHECK (note_by_app IS NULL OR note_by_app IN ('anthropic', 'openai'));
ALTER TABLE public.submission_checklist_items DROP CONSTRAINT IF EXISTS submission_checklist_items_note_by_app_kind_ck;
ALTER TABLE public.submission_checklist_items ADD CONSTRAINT submission_checklist_items_note_by_app_kind_ck
  CHECK (note_by_app IS NULL OR (note_by_kind IS NOT NULL AND note_by_kind = 'ai_app'));
ALTER TABLE public.submission_checklist_items DROP CONSTRAINT IF EXISTS submission_checklist_items_note_by_note_ck;
ALTER TABLE public.submission_checklist_items ADD CONSTRAINT submission_checklist_items_note_by_note_ck
  CHECK (note_by_kind IS NULL OR NULLIF(btrim(note), '') IS NOT NULL);
ALTER TABLE public.submission_checklist_items DROP CONSTRAINT IF EXISTS submission_checklist_items_note_by_v_ck;
ALTER TABLE public.submission_checklist_items ADD CONSTRAINT submission_checklist_items_note_by_v_ck
  CHECK (note_by_kind IS NULL OR (attribution_v IS NOT NULL AND attribution_v = 1));

-- ============================================================================ the provider on the done and note parts
-- Recomputed for a part only on INSERT or when that part's _rev changes; the lookup runs only for an 'ai_app:' ref.
CREATE OR REPLACE FUNCTION public._cloud_todo_part_app() RETURNS trigger
LANGUAGE plpgsql VOLATILE SET search_path = '' AS $f$
DECLARE
  v_re   constant text := '^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$';
  v_ref  text;
  v_done boolean;
  v_note boolean;
BEGIN
  /*BODY:4263-11a-part-app*/
  IF TG_OP = 'INSERT' THEN
    v_done := true;
    v_note := true;
  ELSE
    v_done := NEW.done_rev IS DISTINCT FROM OLD.done_rev;                                         /*APP:rev*/
    v_note := NEW.note_rev IS DISTINCT FROM OLD.note_rev;
  END IF;
  IF v_done THEN
    NEW.done_app := NULL;
    IF left(NEW.done_by, 7) = 'ai_app:' THEN                                                      /*APP:only_ai*/
      v_ref := substr(NEW.done_by, 8);
      IF v_ref ~ v_re THEN                                                                        /*APP:ref*/
        SELECT c.provider INTO NEW.done_app FROM public.mcp_connections c
         WHERE c.id = v_ref::uuid AND c.user_id = NEW.owner_user_id;
      END IF;
    END IF;
  END IF;
  IF v_note THEN
    NEW.note_app := NULL;
    IF left(NEW.note_by, 7) = 'ai_app:' THEN
      v_ref := substr(NEW.note_by, 8);
      IF v_ref ~ v_re THEN
        SELECT c.provider INTO NEW.note_app FROM public.mcp_connections c
         WHERE c.id = v_ref::uuid AND c.user_id = NEW.owner_user_id;
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END $f$;
REVOKE ALL ON FUNCTION public._cloud_todo_part_app() FROM PUBLIC, anon, authenticated, service_role;

DROP TRIGGER IF EXISTS cloud_deal_checklist_items_part_app ON public.cloud_deal_checklist_items;
CREATE TRIGGER cloud_deal_checklist_items_part_app
  BEFORE INSERT OR UPDATE OF done_rev, done_by, note_rev, note_by ON public.cloud_deal_checklist_items
  FOR EACH ROW EXECUTE FUNCTION public._cloud_todo_part_app();

-- ============================================================================ the pull and push answers carry 'app'
-- 20261118110000 body, plus 'app' on the done and note parts.
CREATE OR REPLACE FUNCTION public._cloud_todo_item_json(t public.cloud_deal_checklist_items) RETURNS jsonb
LANGUAGE sql STABLE SET search_path = '' AS $f$
  SELECT /*BODY:4263-11a-item*/ jsonb_build_object('entity', 'item', 'cloud_id', t.id, 'cloud_deal_id', t.cloud_deal_id,
           'cloud_checklist_id', t.cloud_checklist_id, 'local_id', t.local_item_id, 'change_seq', t.change_seq,
           'purged', t.purged_at IS NOT NULL)
      || CASE WHEN t.purged_at IS NOT NULL THEN '{}'::jsonb ELSE jsonb_build_object(            /*JSON:purged*/
           'description', t.description, 'is_required', t.is_required, 'expected_document_type', t.expected_document_type,
           'local_created_at', t.local_created_at, 'created_by', t.created_by_kind || ':' || coalesce(t.created_by_ref, ''),
           'created_at', t.created_at,
           'parts', jsonb_build_object(
             'done', jsonb_build_object('rev', t.done_rev, 'value', jsonb_build_object('is_checked', coalesce(t.is_checked, false), 'checked_at', t.checked_at),
                                        'at', t.done_eff_at, 'by', t.done_by, 'edit_seq', t.done_edit_seq, 'app', t.done_app),
             'title', jsonb_build_object('rev', t.title_rev, 'value', to_jsonb(t.title), 'at', t.title_eff_at, 'by', t.title_by, 'edit_seq', t.title_edit_seq),
             'note', jsonb_build_object('rev', t.note_rev, 'value', to_jsonb(t.note), 'at', t.note_eff_at, 'by', t.note_by, 'edit_seq', t.note_edit_seq,
                                        'app', t.note_app),
             'due', jsonb_build_object('rev', t.due_rev, 'value', to_jsonb(to_char(t.due_date, 'YYYY-MM-DD')), 'at', t.due_eff_at, 'by', t.due_by, 'edit_seq', t.due_edit_seq),
             'order', jsonb_build_object('rev', t.order_rev, 'value', to_jsonb(t.sort_order), 'at', t.order_eff_at, 'by', t.order_by, 'edit_seq', t.order_edit_seq),
             'removed', jsonb_build_object('rev', t.removed_rev, 'value', jsonb_build_object('removed_at', t.removed_at, 'kind', t.removed_kind),
                                           'at', t.removed_eff_at, 'by', t.removed_by, 'edit_seq', t.removed_edit_seq))) END
$f$;
REVOKE ALL ON FUNCTION public._cloud_todo_item_json(public.cloud_deal_checklist_items) FROM PUBLIC, anon, authenticated, service_role;

-- ============================================================================ the note's author on a submission
-- 20261031230000 body, plus attribution_v, note_by_kind and note_by_app on each item. Grants as before.
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
  v_asked_pairs jsonb;
  n_checklists integer := 0;
  n_items      integer := 0;
  n_links      integer := 0;
  n_members    integer := 0;
  n_dropped_members integer := 0;
  n_dropped_links   integer := 0;
  v_attr       smallint;
  v_nk         text;
  v_na         text;
BEGIN
  /*BODY:4263-11a-snapshot*/
  IF p_submission_id IS NULL OR p_checklists IS NULL OR jsonb_typeof(p_checklists) <> 'array' THEN
    RAISE EXCEPTION 'invalid_payload' USING ERRCODE = '22023';
  END IF;

  FOR c IN SELECT e.value FROM jsonb_array_elements(p_checklists) AS e(value) LOOP
    IF jsonb_typeof(c) <> 'object'
       OR (c ? 'items' AND jsonb_typeof(c -> 'items') <> 'array') THEN
      RAISE EXCEPTION 'invalid_payload' USING ERRCODE = '22023';
    END IF;

    -- BACKLOG-3618: the caller's own template, set not to be sent.
    IF EXISTS (SELECT 1 FROM public.checklist_templates t
                WHERE t.id = NULLIF(c ->> 'template_id', '')::uuid
                  AND t.owner_user_id = (SELECT auth.uid())
                  AND NOT t.include_in_submission) THEN
      CONTINUE;
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

      -- 4263: the note's author (attribution_v, note_by {kind, app}), read and checked before the INSERT.
      -- A value that is malformed, or that a CHECK on the row would refuse, is stored as NULL; nothing here raises.
      v_attr := CASE WHEN jsonb_typeof(it -> 'attribution_v') = 'number' AND (it -> 'attribution_v') = '1'::jsonb THEN 1 END;
      v_nk := NULL;
      v_na := NULL;
      IF v_attr = 1 AND jsonb_typeof(it -> 'note_by') = 'object'
         AND jsonb_typeof(it -> 'note_by' -> 'kind') = 'string'
         AND (it -> 'note_by' ->> 'kind') IN ('agent', 'ai_app')
         AND NULLIF(btrim(it ->> 'note'), '') IS NOT NULL THEN
        v_nk := it -> 'note_by' ->> 'kind';
        IF v_nk = 'ai_app' AND jsonb_typeof(it -> 'note_by' -> 'app') = 'string'
           AND (it -> 'note_by' ->> 'app') IN ('anthropic', 'openai') THEN
          v_na := it -> 'note_by' ->> 'app';
        END IF;
      END IF;

      INSERT INTO public.submission_checklist_items
        (submission_id, submission_checklist_id, title, local_item_id, description, is_required,
         expected_document_type, is_checked, note, sort_order, attribution_v, note_by_kind, note_by_app)
      VALUES (p_submission_id, v_header_id,
              it ->> 'title',
              NULLIF(it ->> 'local_item_id', ''),
              it ->> 'description',
              COALESCE((it ->> 'is_required')::boolean, false),
              it ->> 'expected_document_type',
              COALESCE((it ->> 'is_checked')::boolean, false),
              it ->> 'note',
              COALESCE((it ->> 'sort_order')::integer, 0),
              v_attr, v_nk, v_na)
      RETURNING id INTO v_item_id;
      n_items := n_items + 1;

      FOR lk IN SELECT e.value FROM jsonb_array_elements(COALESCE(it -> 'links', '[]'::jsonb)) AS e(value) LOOP
        v_kind := lk ->> 'kind';
        IF jsonb_typeof(lk) <> 'object'
           OR v_kind IS NULL OR v_kind NOT IN ('attachment', 'email', 'text')
           OR (lk ? 'local_ids' AND jsonb_typeof(lk -> 'local_ids') <> 'array')
           OR (lk ? 'external_ids' AND jsonb_typeof(lk -> 'external_ids') <> 'array') THEN
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
        ELSIF v_kind = 'email' THEN
          SELECT COALESCE(array_agg(m.id), '{}'), v_asked - count(DISTINCT m.local_message_id)::integer
            INTO v_targets, v_link_dropped
            FROM public.submission_messages m
           WHERE m.submission_id = p_submission_id
             AND m.channel = 'email'
             AND m.local_message_id = ANY (v_local_ids);
        ELSE
          -- BACKLOG-3968: a text. Its uploaded row is any message row that is
          -- not an email: channel 'sms' / 'imessage' / NULL, or a row whose
          -- channel reads 'email' but whose message_type is a text type (the
          -- desktop uploads a NULL-channel text as channel 'email' with
          -- message_type 'text'; an email row always carries message_type
          -- 'email' or none). Matched by local message id first; when no row
          -- has that id, by the external id sent at the same position in
          -- external_ids (the same text uploaded from another copy). Each asked
          -- local id counts once: found by either rule, or dropped.
          SELECT COALESCE(jsonb_agg(jsonb_build_object('local_id', p.local_id, 'external_id', p.external_id)), '[]'::jsonb)
            INTO v_asked_pairs
            FROM (SELECT DISTINCT ON (l.value) l.value AS local_id, NULLIF(e.value, '') AS external_id
                    FROM jsonb_array_elements_text(COALESCE(lk -> 'local_ids', '[]'::jsonb)) WITH ORDINALITY AS l(value, n)
                    LEFT JOIN jsonb_array_elements_text(COALESCE(lk -> 'external_ids', '[]'::jsonb)) WITH ORDINALITY AS e(value, n)
                      ON e.n = l.n
                   ORDER BY l.value, l.n) p;

          SELECT COALESCE(array_agg(DISTINCT t.message_id), '{}'), v_asked - count(DISTINCT t.local_id)::integer
            INTO v_targets, v_link_dropped
            FROM (
              SELECT a.local_id, m.id AS message_id
                FROM jsonb_to_recordset(v_asked_pairs) AS a(local_id text, external_id text)
                JOIN public.submission_messages m
                  ON m.submission_id = p_submission_id
                 AND (m.channel IS DISTINCT FROM 'email' OR COALESCE(m.message_type, 'email') <> 'email')
                 AND m.local_message_id = a.local_id
              UNION ALL
              SELECT a.local_id, m.id
                FROM jsonb_to_recordset(v_asked_pairs) AS a(local_id text, external_id text)
                JOIN public.submission_messages m
                  ON m.submission_id = p_submission_id
                 AND (m.channel IS DISTINCT FROM 'email' OR COALESCE(m.message_type, 'email') <> 'email')
                 AND a.external_id IS NOT NULL
                 AND m.external_id = a.external_id
               WHERE NOT EXISTS (
                       SELECT 1 FROM public.submission_messages m
                        WHERE m.submission_id = p_submission_id
                          AND (m.channel IS DISTINCT FROM 'email' OR COALESCE(m.message_type, 'email') <> 'email')
                          AND m.local_message_id = a.local_id)
            ) t;
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
          -- 'email' or 'text': both point at the uploaded message row.
          INSERT INTO public.submission_checklist_link_members
            (submission_id, link_id, kind, submission_message_id)
          SELECT p_submission_id, v_link_id, v_kind, t.id
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
GRANT EXECUTE ON FUNCTION public.snapshot_submission_checklists(uuid, jsonb) TO authenticated, service_role;
