-- ============================================================================
-- Migration: two-way todos, the old one-way item path removed (BACKLOG-4263 PR-4a)
--
-- The desktop sends checklist and item changes through cloud_todo_push (migration 20261118110000) and no
-- longer calls the one-way checklist and item functions. This file:
--   1. numbers every row the one-way upserts inserted after 20261118110000 (change_seq NULL), with the same
--      allocator and the same part metadata that file's backfill wrote; post-check: no unnumbered row;
--   2. marks purged (purged_at, a new number) every checklist and item the one-way cloud_tombstone removed:
--      their content was scrubbed (items: title '[removed]', links '[]'; checklists: template_name NULL), so
--      they are not restorable; restore answers not_restorable and the removed lists leave them out;
--   3. drops cloud_upsert_checklists and cloud_upsert_checklist_items;
--   4. replaces cloud_tombstone and cloud_list_install_rows without their checklist and checklist_item kinds
--      (those kinds now answer invalid_input).
-- Kept on cloud_deal_checklists / _items: content_hash, version, links, origin and source_updated_at (still
--   read or written by 20261118110000's functions and by the replaced cloud_tombstone), and
--   last_change_request_id (read by no function; present on every cloud table, so not dropped from two).
-- Grants: unchanged for the two replaced functions (authenticated only); no function here is callable by anon.
-- Pre-check: each function this file drops or replaces is at the body 20261118110000 wrote (md5 of prosrc),
--   at this file's body, or (for the two dropped) already absent. Requires 20261118110000.
-- Lock order: as 20261118110000 (the owner's feed head through the allocator, then rows in id order).
-- Re-runnable. Rollback: supabase/tests/backlog-4263-pr4a/rollback-20261118120000.sql
-- ============================================================================

DO $precheck4263a$
DECLARE r record; v_md5 text; v_src text;
BEGIN
  IF to_regprocedure('public._cloud_todo_take_seq(uuid,integer)') IS NULL OR to_regprocedure('public.cloud_todo_push(uuid,uuid,text,jsonb)') IS NULL THEN
    RAISE EXCEPTION 'BACKLOG-4263 PR-4a: migration 20261118110000 is not applied';
  END IF;
  FOR r IN SELECT * FROM (VALUES
      ('public.cloud_list_install_rows(uuid,uuid,text,uuid,integer)', 'e557b64992885fa2b3decff2f5b24781', true),
      ('public.cloud_tombstone(uuid,uuid,text,uuid[])', 'ac6e76a613b5aa10a0b95743c902c84c', true),
      ('public.cloud_upsert_checklist_items(uuid,uuid,uuid,jsonb)', '1bfb259e707b388a76610c26c26ce47e', false),
      ('public.cloud_upsert_checklists(uuid,uuid,uuid,jsonb)', '7ed9daf67e8b16258ab0b61dd26dfb4e', false)
    ) x(sig, md5, replaced) LOOP
    SELECT md5(p.prosrc), p.prosrc INTO v_md5, v_src FROM pg_catalog.pg_proc p WHERE p.oid = to_regprocedure(r.sig);
    IF v_md5 IS NULL AND NOT r.replaced THEN CONTINUE; END IF;
    IF v_md5 IS DISTINCT FROM r.md5 AND position('/*BODY:4263-4a*/' IN coalesce(v_src, '')) = 0 THEN
      RAISE EXCEPTION 'BACKLOG-4263 PR-4a: % is not at the traced body (md5 %)', r.sig, coalesce(v_md5, 'missing');
    END IF;
  END LOOP;
END
$precheck4263a$;

-- ============================================================================ 1. numbers and part metadata
DO $backfill4263a$
DECLARE o uuid; n integer; s bigint[];
BEGIN
  FOR o IN SELECT x.owner_user_id FROM (
             SELECT owner_user_id FROM public.cloud_deals WHERE change_seq IS NULL
             UNION SELECT owner_user_id FROM public.cloud_deal_checklists WHERE change_seq IS NULL
             UNION SELECT owner_user_id FROM public.cloud_deal_checklist_items WHERE change_seq IS NULL) x
            ORDER BY 1 LOOP
    SELECT count(*) INTO n FROM public.cloud_deals WHERE owner_user_id = o AND change_seq IS NULL;
    IF n > 0 THEN
      s := public._cloud_todo_take_seq(o, n);
      UPDATE public.cloud_deals d SET change_seq = s[r.rn]
        FROM (SELECT x.id, row_number() OVER (ORDER BY x.id) AS rn FROM public.cloud_deals x
               WHERE x.owner_user_id = o AND x.change_seq IS NULL) r
       WHERE d.id = r.id;
    END IF;
    SELECT count(*) INTO n FROM public.cloud_deal_checklists WHERE owner_user_id = o AND change_seq IS NULL;
    IF n > 0 THEN
      s := public._cloud_todo_take_seq(o, n);
      UPDATE public.cloud_deal_checklists c SET change_seq = s[r.rn]
        FROM (SELECT x.id, row_number() OVER (ORDER BY x.id) AS rn FROM public.cloud_deal_checklists x
               WHERE x.owner_user_id = o AND x.change_seq IS NULL) r
       WHERE c.id = r.id;
    END IF;
    SELECT count(*) INTO n FROM public.cloud_deal_checklist_items WHERE owner_user_id = o AND change_seq IS NULL;
    IF n > 0 THEN
      s := public._cloud_todo_take_seq(o, n);
      UPDATE public.cloud_deal_checklist_items t SET change_seq = s[r.rn]
        FROM (SELECT x.id, row_number() OVER (ORDER BY x.id) AS rn FROM public.cloud_deal_checklist_items x
               WHERE x.owner_user_id = o AND x.change_seq IS NULL) r
       WHERE t.id = r.id;
    END IF;
  END LOOP;
  UPDATE public.cloud_deal_checklists c
     SET created_by_kind = 'desktop', created_by_ref = d.source_install_id::text,
         order_eff_at = coalesce(c.source_updated_at, c.updated_at), order_by = 'desktop:' || d.source_install_id::text,
         removed_eff_at = c.removed_at, removed_by = CASE WHEN c.removed_at IS NOT NULL THEN 'desktop:' || d.source_install_id::text END,
         removed_kind = CASE WHEN c.removed_at IS NOT NULL THEN 'checklist' END
    FROM public.cloud_deals d
   WHERE d.id = c.cloud_deal_id AND c.created_by_kind IS NULL;
  UPDATE public.cloud_deal_checklist_items t
     SET created_by_kind = 'desktop', created_by_ref = d.source_install_id::text,
         done_eff_at = coalesce(t.source_updated_at, t.updated_at), done_by = 'desktop:' || d.source_install_id::text,
         title_eff_at = coalesce(t.source_updated_at, t.updated_at), title_by = 'desktop:' || d.source_install_id::text,
         note_eff_at = coalesce(t.source_updated_at, t.updated_at), note_by = 'desktop:' || d.source_install_id::text,
         due_eff_at = coalesce(t.source_updated_at, t.updated_at), due_by = 'desktop:' || d.source_install_id::text,
         order_eff_at = coalesce(t.source_updated_at, t.updated_at), order_by = 'desktop:' || d.source_install_id::text,
         removed_eff_at = t.removed_at, removed_by = CASE WHEN t.removed_at IS NOT NULL THEN 'desktop:' || d.source_install_id::text END,
         removed_kind = CASE WHEN t.removed_at IS NOT NULL THEN 'item' END
    FROM public.cloud_deals d
   WHERE d.id = t.cloud_deal_id AND t.created_by_kind IS NULL;
  IF ((SELECT count(*) FROM public.cloud_deals WHERE change_seq IS NULL)
         + (SELECT count(*) FROM public.cloud_deal_checklists WHERE change_seq IS NULL)
         + (SELECT count(*) FROM public.cloud_deal_checklist_items WHERE change_seq IS NULL)) <> 0 THEN
    RAISE EXCEPTION 'BACKLOG-4263 PR-4a: unnumbered rows remain';
  END IF;
END
$backfill4263a$;

-- ============================================================================ 2. rows the one-way tombstone scrubbed
-- Their signature: removed, not purged, and scrubbed the way only the one-way cloud_tombstone scrubbed
-- (items: links '[]', written by no other function except the purge, which also sets purged_at; checklists:
-- template_name NULL, which neither the desktop create nor the AI-app My items create writes).
DO $scrubbed4263a$
DECLARE v_id uuid; v_owner uuid;
BEGIN
  FOR v_id, v_owner IN SELECT t.id, t.owner_user_id FROM public.cloud_deal_checklist_items t
                        WHERE t.removed_at IS NOT NULL AND t.purged_at IS NULL AND t.links = '[]'::jsonb      /*SCRUB:items*/
                        ORDER BY t.owner_user_id, t.id LOOP
    UPDATE public.cloud_deal_checklist_items SET purged_at = now(), change_seq = (public._cloud_todo_take_seq(v_owner, 1))[1]
     WHERE id = v_id;
  END LOOP;
  FOR v_id, v_owner IN SELECT c.id, c.owner_user_id FROM public.cloud_deal_checklists c
                        WHERE c.removed_at IS NOT NULL AND c.purged_at IS NULL AND c.template_name IS NULL     /*SCRUB:checklists*/
                        ORDER BY c.owner_user_id, c.id LOOP
    UPDATE public.cloud_deal_checklists SET purged_at = now(), change_seq = (public._cloud_todo_take_seq(v_owner, 1))[1]
     WHERE id = v_id;
  END LOOP;
END
$scrubbed4263a$;

-- ============================================================================ 3. the one-way checklist and item upserts
DROP FUNCTION IF EXISTS public.cloud_upsert_checklists(uuid, uuid, uuid, jsonb);
DROP FUNCTION IF EXISTS public.cloud_upsert_checklist_items(uuid, uuid, uuid, jsonb);

-- ============================================================================ 4. replaced without the checklist kinds
CREATE OR REPLACE FUNCTION public.cloud_tombstone(p_expected_user_id uuid, p_source_install_id uuid, p_kind text, p_cloud_ids uuid[]) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = '' AS $f$
/*BODY:4263-4a*/
DECLARE v_uid uuid := auth.uid(); v_tab text; v_id uuid; out jsonb := '[]'::jsonb;
        v_row_id uuid; v_row_deal uuid; v_row_removed timestamptz; v_row_version bigint; v_blob uuid; v_deals uuid[];
        v_fence uuid[] := '{}'; v_now timestamptz;
BEGIN
  IF v_uid IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'not_authorized'); END IF;
  IF p_expected_user_id IS DISTINCT FROM v_uid THEN RETURN jsonb_build_object('ok', false, 'error', 'wrong_account'); END IF;   /*WHO:tombstone*/
  -- checklists and items are todo changes (cloud_todo_push) since 20261118120000: no arm for them here
  v_tab := CASE p_kind WHEN 'party' THEN 'cloud_deal_parties' WHEN 'message' THEN 'cloud_deal_messages'
                       WHEN 'file' THEN 'cloud_deal_files' END;
  IF v_tab IS NULL OR p_source_install_id IS NULL OR p_cloud_ids IS NULL OR cardinality(p_cloud_ids) > 1000 THEN   /*CAP:tombstone*/
    RETURN jsonb_build_object('ok', false, 'error', 'invalid_input');
  END IF;
  PERFORM 1 FROM public.cloud_autosave_settings WHERE user_id = v_uid FOR SHARE;
  IF public._cloud_install_removed(v_uid, p_source_install_id) THEN                       /*GATE:install:tombstone*/
    RETURN jsonb_build_object('ok', false, 'error', 'install_removed');
  END IF;
  EXECUTE format(
    'SELECT array_agg(x.id) FROM (SELECT d.id FROM public.cloud_deals d
       WHERE d.owner_user_id = $1 AND d.source_install_id = $2
         AND d.id IN (SELECT t.cloud_deal_id FROM public.%I t WHERE t.id = ANY ($3) AND t.owner_user_id = $1)
       ORDER BY d.id FOR NO KEY UPDATE) x', v_tab)
    INTO v_deals USING v_uid, p_source_install_id, p_cloud_ids;                              /*TOMB:lockdeals*/
  v_now := clock_timestamp();                                                                /*CLOCK:tombstone*/
  FOREACH v_id IN ARRAY p_cloud_ids LOOP
    v_row_id := NULL;
    EXECUTE format(
      'SELECT t.id, t.cloud_deal_id, t.removed_at, t.version FROM public.%I t
         JOIN public.cloud_deals d ON d.id = t.cloud_deal_id
        WHERE t.id = $1 AND t.owner_user_id = $2 /*OWNER:tombstone*/
          AND d.source_install_id = $3 /*INSTALL:tombstone*/
        FOR UPDATE OF t', v_tab)
      INTO v_row_id, v_row_deal, v_row_removed, v_row_version USING v_id, v_uid, p_source_install_id;
    IF v_row_id IS NULL THEN
      out := out || jsonb_build_object('cloud_id', v_id, 'status', 'not_found');
      CONTINUE;
    END IF;
    IF v_row_removed IS NOT NULL THEN
      out := out || jsonb_build_object('cloud_id', v_id, 'status', 'unchanged', 'version', v_row_version);
      CONTINUE;
    END IF;
    IF p_kind = 'party' THEN
      UPDATE public.cloud_deal_parties SET removed_at = now(), version = version + 1, updated_at = now(),
             display_name = NULL, company = NULL, emails = NULL, phones = NULL, notes = NULL
       WHERE id = v_row_id RETURNING version INTO v_row_version;
    ELSIF p_kind = 'message' THEN
      UPDATE public.cloud_deal_messages SET removed_at = now(), version = version + 1, updated_at = now(),
             subject = NULL, body_text = NULL, body_truncated = false, participants = NULL          /*TOMB:scrub*/
       WHERE id = v_row_id RETURNING version INTO v_row_version;
    ELSE
      SELECT f.blob_id INTO v_blob FROM public.cloud_deal_files f WHERE f.id = v_row_id;
      UPDATE public.cloud_deal_files f SET removed_at = now(), version = version + 1, updated_at = now(),
             filename = NULL, blob_id = NULL
       WHERE f.id = v_row_id RETURNING f.version INTO v_row_version;
      v_fence := v_fence || v_blob;
    END IF;
    UPDATE public.cloud_deals SET last_synced_at = greatest(last_synced_at, v_now) WHERE id = v_row_deal;
    out := out || jsonb_build_object('cloud_id', v_id, 'status', 'removed', 'version', v_row_version);
  END LOOP;
  PERFORM public._cloud_fence_unreferenced(v_uid, v_fence);                                  /*TOMB:fence*/
  RETURN jsonb_build_object('ok', true, 'results', out);
END $f$;
REVOKE ALL ON FUNCTION public.cloud_tombstone(uuid, uuid, text, uuid[]) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.cloud_tombstone(uuid, uuid, text, uuid[]) TO authenticated;

CREATE OR REPLACE FUNCTION public.cloud_list_install_rows(
  p_expected_user_id uuid, p_source_install_id uuid, p_kind text, p_after uuid, p_limit integer
) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $f$
/*BODY:4263-4a*/
DECLARE v_uid uuid := auth.uid(); v_limit integer; v_tab text; v_local text; v_deal text; v_removed text;
        v_rows jsonb; v_n integer; v_last uuid;
BEGIN
  IF v_uid IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'not_authorized'); END IF;
  IF p_expected_user_id IS DISTINCT FROM v_uid THEN RETURN jsonb_build_object('ok', false, 'error', 'wrong_account'); END IF;   /*WHO:list_rows*/
  IF p_source_install_id IS NULL OR p_kind IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'invalid_input'); END IF;
  SELECT k.tab, k.local_col, k.deal_col, k.removed_expr INTO v_tab, v_local, v_deal, v_removed
    FROM (VALUES
      ('deal',           'cloud_deals',                'local_transaction_id', 't.id',            't.removed_at IS NOT NULL'),
      ('party',          'cloud_deal_parties',         'local_party_id',       't.cloud_deal_id', 't.removed_at IS NOT NULL OR d.removed_at IS NOT NULL')
    ) k(kind, tab, local_col, deal_col, removed_expr)                                          -- no checklist kinds since 20261118120000                                           /*LIVE:list_rows*/
   WHERE k.kind = p_kind;
  IF v_tab IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'invalid_input'); END IF;
  v_limit := least(greatest(coalesce(p_limit, 1000), 1), 1000);                               /*CAP:list_rows*/
  EXECUTE format(
    'SELECT coalesce(jsonb_agg(jsonb_build_object(''cloud_id'', x.id, ''cloud_deal_id'', x.deal_id, ''local_id'', x.local_id,
                                                   ''content_hash'', x.content_hash, ''removed'', x.removed) ORDER BY x.id), ''[]''::jsonb),
            count(*)::integer, (array_agg(x.id ORDER BY x.id DESC))[1]
       FROM (SELECT t.id, %s AS deal_id, t.%I AS local_id, t.content_hash, (%s) AS removed
               FROM public.%I t JOIN public.cloud_deals d ON d.id = %s
              WHERE t.owner_user_id = $1 AND d.owner_user_id = $1 /*OWNER:list_rows*/
                AND d.source_install_id = $2 /*INSTALL:list_rows*/
                AND ($3 IS NULL OR t.id > $3)
              ORDER BY t.id LIMIT $4) x',
    v_deal, v_local, v_removed, v_tab, v_deal)
    INTO v_rows, v_n, v_last USING v_uid, p_source_install_id, p_after, v_limit;
  RETURN jsonb_build_object('ok', true, 'rows', v_rows,
                            'next_after', CASE WHEN v_n = v_limit THEN v_last END);
END $f$;
REVOKE ALL ON FUNCTION public.cloud_list_install_rows(uuid, uuid, text, uuid, integer) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.cloud_list_install_rows(uuid, uuid, text, uuid, integer) TO authenticated;
