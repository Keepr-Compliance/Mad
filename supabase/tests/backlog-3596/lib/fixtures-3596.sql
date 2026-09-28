-- BACKLOG-3596 fixtures: helper functions only, no rows. Loaded by run.sh
-- BEFORE the 3596 migration (so the rollback control can snapshot the
-- catalogue first), inside the control's own transaction (always rolled
-- back). Builds on the BACKLOG-3473 / 3477 fixtures: pg_temp.check, act_as,
-- act_owner, act_anon, expect, id, n and hist are reused.
--
-- ALL IDENTIFIERS ARE INVENTED. Every row a control needs is made by
-- pg_temp.build_v1 / pg_temp.new_version through the REAL producers: the
-- snapshot RPC called as the agent, the tick RPC called as the broker, and
-- the owner (no JWT) only for what the desktop / portal do outside those
-- RPCs (inserting a version row and its uploads, moving the status).
--
-- The one deliberate edit to a produced row: pg_temp.build_v1 backdates each
-- reviewer_checked_at to a fixed literal. Every control is one transaction,
-- so now() is frozen; without the backdate a carry that re-stamps the tick
-- with now() would write the same value and pass.

-- Loaded before the migration, so SQL bodies naming its new columns cannot be
-- checked at CREATE time.
SET LOCAL check_function_bodies = off;

-- snap3596(): catalogue rows for the apply-twice and rollback controls.
CREATE FUNCTION pg_temp.snap3596() RETURNS TABLE (k text, v text)
LANGUAGE sql AS $$
  SELECT 'policy:' || tablename || '.' || policyname,
         cmd || '|' || roles::text || '|' || coalesce(qual, '') || '|' || coalesce(with_check, '')
    FROM pg_policies
   WHERE schemaname = 'public'
     AND tablename IN ('transaction_submissions', 'submission_checklists', 'submission_checklist_items',
                       'submission_checklist_links', 'submission_checklist_link_members')
  UNION ALL
  SELECT 'constraint:' || conrelid::regclass::text || '.' || conname, pg_get_constraintdef(oid)
    FROM pg_constraint
   WHERE conrelid IN ('public.submission_checklists'::regclass, 'public.submission_checklist_items'::regclass,
                      'public.transaction_submissions'::regclass)
  UNION ALL
  SELECT 'column:' || table_name || '.' || column_name, data_type || '|' || is_nullable || '|' || coalesce(column_default, '')
    FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name IN ('submission_checklists', 'submission_checklist_items', 'transaction_submissions')
  UNION ALL
  SELECT 'index:' || indexname, indexdef FROM pg_indexes
   WHERE schemaname = 'public' AND tablename IN ('submission_checklists', 'submission_checklist_items', 'transaction_submissions')
  UNION ALL
  SELECT 'function:' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')',
         md5(p.prosrc) || '|' || p.prosecdef || '|' || coalesce(p.proconfig::text, '') || '|' || coalesce(p.proacl::text, '')
    FROM pg_proc p
   WHERE p.pronamespace = 'public'::regnamespace
     AND p.proname IN ('can_review_submission', 'snapshot_submission_checklists',
                       'set_submission_checklist_reviewer_check', 'add_submission_checklist_at_review',
                       'guard_status_history_append_only', 'carry_submission_checklist_reviews',
                       'track_submission_status_changes')
  UNION ALL
  SELECT 'trigger:' || tgname, pg_get_triggerdef(oid)
    FROM pg_trigger WHERE tgrelid = 'public.transaction_submissions'::regclass AND NOT tgisinternal
  UNION ALL
  SELECT 'grant:' || table_name || '.' || grantee || '.' || privilege_type, 'table'
    FROM information_schema.role_table_grants
   WHERE table_schema = 'public' AND table_name IN ('submission_checklist_items', 'transaction_submissions')
     AND grantee IN ('anon', 'authenticated')
$$;

-- base_payload(): the desktop's snapshot payload for the fixture deal. Two
-- checklists; six items, each with its own local_item_id.
--   I1 note 'n1', attachment L-att-1         (broker ticks)
--   I2 no note, email L-msg-1                (broker ticks)
--   I3 note 'n3', attachment L-att-2 + email L-msg-2   (broker ticks)
--   I4 no links                              (never ticked)
--   I5 attachment L-att-3                    (broker ticks)
--   I6 note '' in checklist B (no template)  (admin ticks)
CREATE FUNCTION pg_temp.base_payload() RETURNS jsonb
LANGUAGE sql AS $$
  SELECT jsonb_build_array(
    jsonb_build_object(
      'template_id', current_setting('t3473.tpl_t1_a'),
      'template_name', 'Fixture starter A', 'sort_order', 0,
      'items', jsonb_build_array(
        jsonb_build_object('title', 'Item one', 'local_item_id', 'L-item-1', 'is_required', true, 'is_checked', true,
          'note', 'n1', 'sort_order', 10,
          'links', jsonb_build_array(jsonb_build_object('kind', 'attachment', 'label', 'Doc 1', 'local_ids', jsonb_build_array('L-att-1')))),
        jsonb_build_object('title', 'Item two', 'local_item_id', 'L-item-2', 'is_required', true, 'is_checked', false,
          'sort_order', 20,
          'links', jsonb_build_array(jsonb_build_object('kind', 'email', 'label', 'Thread 1', 'local_ids', jsonb_build_array('L-msg-1')))),
        jsonb_build_object('title', 'Item three', 'local_item_id', 'L-item-3', 'is_required', false,
          'note', 'n3', 'sort_order', 30,
          'links', jsonb_build_array(
            jsonb_build_object('kind', 'attachment', 'label', 'Doc 2', 'local_ids', jsonb_build_array('L-att-2')),
            jsonb_build_object('kind', 'email', 'label', 'Thread 2', 'local_ids', jsonb_build_array('L-msg-2')))),
        jsonb_build_object('title', 'Item four', 'local_item_id', 'L-item-4', 'sort_order', 40, 'links', '[]'::jsonb),
        jsonb_build_object('title', 'Item five', 'local_item_id', 'L-item-5', 'sort_order', 50,
          'links', jsonb_build_array(jsonb_build_object('kind', 'attachment', 'label', 'Doc 3', 'local_ids', jsonb_build_array('L-att-3')))))),
    jsonb_build_object(
      'template_name', 'Fixture custom B', 'sort_order', 1,
      'items', jsonb_build_array(
        jsonb_build_object('title', 'Item six', 'local_item_id', 'L-item-6', 'note', '', 'sort_order', 10, 'links', '[]'::jsonb))))
$$;

-- item_set(payload, local_item_id, key, value): the payload with one key of
-- one item replaced (value NULL removes the key).
CREATE FUNCTION pg_temp.item_set(p jsonb, p_local text, p_key text, p_val jsonb) RETURNS jsonb
LANGUAGE sql AS $$
  SELECT jsonb_agg(
           c || jsonb_build_object('items', (
             SELECT COALESCE(jsonb_agg(
                      CASE WHEN it ->> 'local_item_id' = p_local
                           THEN CASE WHEN p_val IS NULL THEN it - p_key ELSE it || jsonb_build_object(p_key, p_val) END
                           ELSE it END ORDER BY o), '[]'::jsonb)
               FROM jsonb_array_elements(c -> 'items') WITH ORDINALITY AS x(it, o)))
         ORDER BY co)
    FROM jsonb_array_elements(p) WITH ORDINALITY AS y(c, co)
$$;

-- item_drop(payload, local_item_id): the payload without that item.
CREATE FUNCTION pg_temp.item_drop(p jsonb, p_local text) RETURNS jsonb
LANGUAGE sql AS $$
  SELECT jsonb_agg(
           c || jsonb_build_object('items', (
             SELECT COALESCE(jsonb_agg(it ORDER BY o), '[]'::jsonb)
               FROM jsonb_array_elements(c -> 'items') WITH ORDINALITY AS x(it, o)
              WHERE it ->> 'local_item_id' IS DISTINCT FROM p_local))
         ORDER BY co)
    FROM jsonb_array_elements(p) WITH ORDINALITY AS y(c, co)
$$;

-- strip_ids(payload): an older desktop's payload (no local_item_id at all).
CREATE FUNCTION pg_temp.strip_ids(p jsonb) RETURNS jsonb
LANGUAGE sql AS $$
  SELECT jsonb_agg(
           c || jsonb_build_object('items', (
             SELECT COALESCE(jsonb_agg(it - 'local_item_id' ORDER BY o), '[]'::jsonb)
               FROM jsonb_array_elements(c -> 'items') WITH ORDINALITY AS x(it, o)))
         ORDER BY co)
    FROM jsonb_array_elements(p) WITH ORDINALITY AS y(c, co)
$$;

-- mk_sub(txn, version, parent, status[, uid[, org]]): one version row, as
-- the desktop inserts it (owner; history empty). Returns its id.
CREATE FUNCTION pg_temp.mk_sub(p_txn text, p_version integer, p_parent uuid, p_status text,
                               p_uid uuid DEFAULT NULL, p_org uuid DEFAULT NULL) RETURNS uuid
LANGUAGE plpgsql AS $$
DECLARE
  v uuid;
BEGIN
  INSERT INTO public.transaction_submissions
    (organization_id, submitted_by, local_transaction_id, property_address, status, version, parent_submission_id)
  VALUES (COALESCE(p_org, pg_temp.id('o_t1')), COALESCE(p_uid, pg_temp.id('u_t1_agent')), p_txn,
          '96 Fixture Way', p_status, p_version, p_parent)
  RETURNING id INTO v;
  RETURN v;
END
$$;

-- mk_uploads(sub, attachment local ids, email local ids): this version's
-- uploads. A local id listed twice becomes two uploads of one local file.
CREATE FUNCTION pg_temp.mk_uploads(p_sub uuid, p_att text[], p_msg text[]) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO public.submission_attachments (submission_id, filename, storage_path, document_type, local_attachment_id)
  SELECT p_sub, 'fixture-' || a || '.pdf', 'fixture-3596/' || p_sub || '/' || a || '-' || o, 'other', a
    FROM unnest(p_att) WITH ORDINALITY AS u(a, o);
  INSERT INTO public.submission_messages (submission_id, local_message_id, channel, subject)
  SELECT p_sub, m, 'email', 'Fixture thread'
    FROM unnest(p_msg) AS u(m);
END
$$;

-- snap_as(uid, sub, payload): the snapshot RPC as that user. Returns its result.
CREATE FUNCTION pg_temp.snap_as(p_uid uuid, p_sub uuid, p jsonb) RETURNS jsonb
LANGUAGE plpgsql AS $$
DECLARE
  res jsonb;
BEGIN
  PERFORM pg_temp.act_as(p_uid);
  res := public.snapshot_submission_checklists(p_sub, p);
  PERFORM pg_temp.act_owner();
  RETURN res;
END
$$;

-- tick_as(uid, item, checked): the tick RPC as that user.
CREATE FUNCTION pg_temp.tick_as(p_uid uuid, p_item uuid, p_checked boolean) RETURNS jsonb
LANGUAGE plpgsql AS $$
DECLARE
  res jsonb;
BEGIN
  PERFORM pg_temp.act_as(p_uid);
  res := public.set_submission_checklist_reviewer_check(p_item, p_checked);
  PERFORM pg_temp.act_owner();
  RETURN res;
END
$$;

-- item(sub, local_item_id): that version's item id.
CREATE FUNCTION pg_temp.item(p_sub uuid, p_local text) RETURNS uuid
LANGUAGE sql AS $$
  SELECT id FROM public.submission_checklist_items WHERE submission_id = p_sub AND local_item_id = p_local
$$;

-- item_by_title(sub, title): for rows written without a local_item_id.
CREATE FUNCTION pg_temp.item_by_title(p_sub uuid, p_title text) RETURNS uuid
LANGUAGE sql AS $$
  SELECT id FROM public.submission_checklist_items WHERE submission_id = p_sub AND title = p_title
$$;

-- tick_state(sub): 'local:by:at' for every reviewer-ticked item, sorted.
CREATE FUNCTION pg_temp.tick_state(p_sub uuid) RETURNS text
LANGUAGE sql AS $$
  SELECT COALESCE(string_agg(COALESCE(local_item_id, title) || ':' || reviewer_checked_by || ':'
                             || to_char(reviewer_checked_at AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI'), ',' ORDER BY COALESCE(local_item_id, title)), '')
    FROM public.submission_checklist_items WHERE submission_id = p_sub AND reviewer_checked
$$;

-- typed(sub, type): that version's Status History entries of one type.
CREATE FUNCTION pg_temp.typed(p_sub uuid, p_type text) RETURNS jsonb
LANGUAGE sql AS $$
  SELECT COALESCE(jsonb_agg(e ORDER BY o), '[]'::jsonb)
    FROM jsonb_array_elements(pg_temp.hist(p_sub)) WITH ORDINALITY AS x(e, o)
   WHERE e ->> 'type' = p_type
$$;

-- set_status(sub, status): the owner moves a version's status (the portal
-- decision / desktop finalize, outside the RPCs under test).
CREATE FUNCTION pg_temp.set_status(p_sub uuid, p_status text) RETURNS void
LANGUAGE sql AS $$
  UPDATE public.transaction_submissions SET status = p_status WHERE id = p_sub
$$;

-- V1_ATT / V1_MSG: version 1's uploads. L-att-1 is two uploads of one file.
CREATE FUNCTION pg_temp.v1_att() RETURNS text[] LANGUAGE sql AS $$ SELECT ARRAY['L-att-1', 'L-att-1', 'L-att-2', 'L-att-3'] $$;
CREATE FUNCTION pg_temp.v_msg() RETURNS text[] LANGUAGE sql AS $$ SELECT ARRAY['L-msg-1', 'L-msg-2'] $$;
-- version 2's default uploads: the same local files as ONE upload each (new
-- cloud rows), plus L-att-9, a file version 1 never had.
CREATE FUNCTION pg_temp.v2_att() RETURNS text[] LANGUAGE sql AS $$ SELECT ARRAY['L-att-1', 'L-att-2', 'L-att-3', 'L-att-9'] $$;

-- build_v1(txn[, payload[, tick]]): version 1 of a deal, reviewed.
--   uploading -> snapshot as the agent -> submitted -> broker ticks I1, I2,
--   I3, I5 and admin ticks I6 (tick RPC) -> each reviewer_checked_at
--   backdated to 2026-09-01 10:0N UTC (N = item number) -> needs_changes.
--   p_tick false: no ticks. Items are found by local id, or by title when the
--   payload carries none.
CREATE FUNCTION pg_temp.build_v1(p_txn text, p jsonb DEFAULT NULL, p_tick boolean DEFAULT true) RETURNS uuid
LANGUAGE plpgsql AS $$
DECLARE
  v1 uuid;
  r  record;
BEGIN
  v1 := pg_temp.mk_sub(p_txn, 1, NULL, 'uploading');
  PERFORM pg_temp.mk_uploads(v1, pg_temp.v1_att(), pg_temp.v_msg());
  PERFORM pg_temp.snap_as(pg_temp.id('u_t1_agent'), v1, COALESCE(p, pg_temp.base_payload()));
  PERFORM pg_temp.set_status(v1, 'submitted');
  IF p_tick THEN
    FOR r IN SELECT * FROM (VALUES ('Item one', 1, 'u_t1_broker'), ('Item two', 2, 'u_t1_broker'),
                                   ('Item three', 3, 'u_t1_broker'), ('Item five', 5, 'u_t1_broker'),
                                   ('Item six', 6, 'u_t1_admin')) v(title, n, who) LOOP
      PERFORM pg_temp.tick_as(pg_temp.id(r.who), pg_temp.item_by_title(v1, r.title), true);
      UPDATE public.submission_checklist_items
         SET reviewer_checked_at = ('2026-09-01 10:0' || r.n || ':00+00')::timestamptz
       WHERE id = pg_temp.item_by_title(v1, r.title);
    END LOOP;
  END IF;
  PERFORM pg_temp.set_status(v1, 'needs_changes');
  RETURN v1;
END
$$;

-- new_version(parent, version[, att[, uid]]): the next version row in
-- uploading, with its uploads, as the desktop creates it before the snapshot.
CREATE FUNCTION pg_temp.new_version(p_parent uuid, p_version integer, p_att text[] DEFAULT NULL,
                                    p_uid uuid DEFAULT NULL, p_txn text DEFAULT NULL) RETURNS uuid
LANGUAGE plpgsql AS $$
DECLARE
  v uuid;
BEGIN
  v := pg_temp.mk_sub(COALESCE(p_txn, (SELECT local_transaction_id FROM public.transaction_submissions WHERE id = p_parent)),
                      p_version, p_parent, 'uploading', p_uid);
  PERFORM pg_temp.mk_uploads(v, COALESCE(p_att, pg_temp.v2_att()), pg_temp.v_msg());
  RETURN v;
END
$$;

-- The expected tick state of a fully carried base deal (original reviewer
-- and time for every broker/admin tick).
CREATE FUNCTION pg_temp.base_ticks() RETURNS text
LANGUAGE sql AS $$
  SELECT 'L-item-1:' || pg_temp.id('u_t1_broker') || ':2026-09-01 10:01,'
      || 'L-item-2:' || pg_temp.id('u_t1_broker') || ':2026-09-01 10:02,'
      || 'L-item-3:' || pg_temp.id('u_t1_broker') || ':2026-09-01 10:03,'
      || 'L-item-5:' || pg_temp.id('u_t1_broker') || ':2026-09-01 10:05,'
      || 'L-item-6:' || pg_temp.id('u_t1_admin') || ':2026-09-01 10:06'
$$;

SET LOCAL check_function_bodies = on;

SELECT 'fixtures-3596 loaded' AS fixtures;
