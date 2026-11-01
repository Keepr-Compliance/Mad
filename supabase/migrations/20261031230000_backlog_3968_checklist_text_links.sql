-- BACKLOG-3968 (PR-5): checklist links to texts in the submission snapshot.
--
-- What changes:
--   1. submission_checklist_links.kind accepts 'text'.
--   2. submission_checklist_link_members accepts kind 'text' (a message row,
--      no attachment), and its INSERT policy checks the message row by kind:
--      an 'email' member names a channel 'email' row (unchanged), a 'text'
--      member names a row that is not an email (see the text arm below).
--   3. submission_messages.external_id (nullable, no writer yet): the text's
--      external id, for the fallback match below. Inert until the desktop
--      uploads it.
--   4. snapshot_submission_checklists(uuid, jsonb): the 20261001054306 body
--      with a third arm for kind 'text', and an optional external_ids array
--      on a text link. Unknown kinds still raise invalid_payload. Still
--      SECURITY INVOKER with search_path '': the table policies are the
--      caller check, as before.
--   5. remove_submission_checklist_at_review(uuid): the 20260929120000 body
--      with a text count (linked_texts) next to linked_documents and
--      linked_emails. SECURITY DEFINER caller checks unchanged.
--   6. submission_checklist_capabilities(): new, returns the link kinds this
--      project accepts. The desktop reads it before sending text links; on a
--      project without this migration the function does not exist, which the
--      desktop reads as "texts not accepted".
--
-- Re-running the file is a no-op: constraints are dropped and re-added with
-- the same definition, the column and index use IF NOT EXISTS, the policy is
-- dropped and re-created, functions use CREATE OR REPLACE.
--
-- EXECUTE: snapshot / remove keep authenticated and service_role (the live
-- ACL); capabilities is granted to authenticated and service_role.
-- Plan and review: pm_comments on BACKLOG-3966 / BACKLOG-3968.

-- ---------------------------------------------------------------------------
-- 1-2. Kind checks
-- ---------------------------------------------------------------------------
ALTER TABLE public.submission_checklist_links
  DROP CONSTRAINT IF EXISTS submission_checklist_links_kind_check;
ALTER TABLE public.submission_checklist_links
  ADD CONSTRAINT submission_checklist_links_kind_check CHECK (kind IN ('attachment', 'email', 'text'));

ALTER TABLE public.submission_checklist_link_members
  DROP CONSTRAINT IF EXISTS submission_checklist_link_members_target_check;
ALTER TABLE public.submission_checklist_link_members
  ADD CONSTRAINT submission_checklist_link_members_target_check CHECK (
    (kind = 'attachment' AND submission_attachment_id IS NOT NULL AND submission_message_id IS NULL)
    OR (kind IN ('email', 'text') AND submission_message_id IS NOT NULL AND submission_attachment_id IS NULL)
  );

DROP POLICY IF EXISTS submission_checklist_link_members_insert ON public.submission_checklist_link_members;
CREATE POLICY submission_checklist_link_members_insert ON public.submission_checklist_link_members
  FOR INSERT TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1
        FROM public.transaction_submissions ts
       WHERE ts.id = submission_checklist_link_members.submission_id
         AND ts.submitted_by = (SELECT auth.uid())
         AND ts.status = 'uploading'
    )
    AND (submission_checklist_link_members.submission_attachment_id IS NULL
         OR EXISTS (
           SELECT 1
             FROM public.submission_attachments a
            WHERE a.id = submission_checklist_link_members.submission_attachment_id
              AND a.submission_id = submission_checklist_link_members.submission_id
         ))
    AND (submission_checklist_link_members.submission_message_id IS NULL
         OR EXISTS (
           SELECT 1
             FROM public.submission_messages m
            WHERE m.id = submission_checklist_link_members.submission_message_id
              AND m.submission_id = submission_checklist_link_members.submission_id
              AND CASE submission_checklist_link_members.kind
                    WHEN 'email' THEN m.channel = 'email'
                    WHEN 'text'  THEN (m.channel IS DISTINCT FROM 'email' OR COALESCE(m.message_type, 'email') <> 'email')
                    ELSE false
                  END
         ))
  );

-- ---------------------------------------------------------------------------
-- 3. External id on uploaded messages (fallback match for texts)
-- ---------------------------------------------------------------------------
ALTER TABLE public.submission_messages ADD COLUMN IF NOT EXISTS external_id text NULL;
CREATE INDEX IF NOT EXISTS submission_messages_submission_external_idx
  ON public.submission_messages (submission_id, external_id)
  WHERE external_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 4. Snapshot at submit: 20261001054306 body, plus the text arm.
--    Payload per link: {kind: 'attachment'|'email'|'text', label, sort_order?,
--    local_ids: [..], external_ids?: [..] (text only, same order as local_ids)}
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
  v_asked_pairs jsonb;
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

-- ---------------------------------------------------------------------------
-- 5. Remove a checklist at review: 20260929120000 body, plus linked_texts.
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
  v_rm     record;
  v_docs   integer;
  v_emails integer;
  v_texts  integer;
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

  -- Documents and emails, not upload rows: one local file uploaded twice is
  -- one document. The carry's evidence identity, so a member with no local
  -- id is not counted (the carry skips it too).
  SELECT count(DISTINCT COALESCE(a.local_attachment_id, m.local_message_id)) FILTER (WHERE lm.kind = 'attachment'),
         count(DISTINCT COALESCE(a.local_attachment_id, m.local_message_id)) FILTER (WHERE lm.kind = 'email'),
         count(DISTINCT COALESCE(a.local_attachment_id, m.local_message_id)) FILTER (WHERE lm.kind = 'text')
    INTO v_docs, v_emails, v_texts
    FROM public.submission_checklist_items i
    JOIN public.submission_checklist_links l ON l.submission_checklist_item_id = i.id
    JOIN public.submission_checklist_link_members lm ON lm.link_id = l.id
    LEFT JOIN public.submission_attachments a ON a.id = lm.submission_attachment_id
    LEFT JOIN public.submission_messages m ON m.id = lm.submission_message_id
   WHERE i.submission_checklist_id = v_hdr.id
     AND COALESCE(a.local_attachment_id, m.local_message_id) IS NOT NULL;

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
           'linked_documents', v_docs,
           'linked_emails', v_emails,
           'linked_texts', v_texts))
   WHERE id = v_rm.rm_sub_id;

  RETURN jsonb_build_object('status', 'removed', 'checklist_id', v_hdr.id,
                            'linked_documents', v_docs, 'linked_emails', v_emails,
                            'linked_texts', v_texts);
END
$$;


REVOKE EXECUTE ON FUNCTION public.remove_submission_checklist_at_review(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.remove_submission_checklist_at_review(uuid) TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 6. Capabilities: which checklist link kinds this project accepts.
--    Constant reply, reads no table; signed-in callers only.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.submission_checklist_capabilities()
RETURNS jsonb
LANGUAGE sql
IMMUTABLE
SECURITY INVOKER
SET search_path = ''
AS $$
  SELECT jsonb_build_object(
    'link_kinds', jsonb_build_array('attachment', 'email', 'text'),
    'text_links', true,
    'text_external_ids', true);
$$;

REVOKE EXECUTE ON FUNCTION public.submission_checklist_capabilities() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.submission_checklist_capabilities() TO authenticated, service_role;
