-- ============================================================================
-- Migration: Keepr Cloud emails, texts and files up, server side (BACKLOG-4263 sync 2.49, P4 / S2)
--
-- No table, column, index or policy is added or changed. Five functions are replaced; each body is the body the
-- earlier migration wrote plus the inserted lines named below, nothing else (pre-check below; CI test
-- broker-portal/__tests__/migrations/messages-up-server-4263.test.ts re-derives every body from the earlier text).
--
-- The switch cloud_release_switches.messages_upload (20261123100000, default false) now gates the three paths that add
-- or change content. While it is false they answer {"ok": false, "error": "feature_off"} and write nothing:
--   cloud_upsert_messages, cloud_upsert_files (20261123100000 bodies) and
--   cloud_register_blob(p_expected_user_id, p_source_install_id, p_sha256, p_size_bytes, p_mime_type) (20261123100000).
--   The check sits right after each function's computer_not_active gate (so after the settings FOR SHARE lock).
-- Not gated by the switch, so removal and reading keep working while it is false: cloud_tombstone,
--   cloud_list_install_rows, cloud_confirm_blob, cloud_delete_deal, the purge, turn-off and the erase job.
-- cloud_upsert_messages also rejects each row whose link_origin is 'review_queue' (status 'rejected', reason
--   'review_queue_not_accepted'), before any row is written; other rows of the same call are handled as before.
-- cloud_tombstone (20261123100000 body): removing a message also removes, in the same call, that message's live file
--   rows of the same deal (as kind 'file' removes them: filename and blob cleared) and fences their blobs that no file
--   row still references. The answer keeps its shape (one result per id asked for).
-- cloud_list_install_rows (20261118120000 body): two more kinds, 'message' and 'file' (keys local_message_id and
--   local_attachment_id; a row counts as removed when it or its deal is removed). Rows of kind 'message' also carry
--   channel_kind ('email' or 'text'). Rows of kinds 'deal' and 'party' are unchanged.
-- Grants: each replaced function has EXECUTE revoked from PUBLIC, anon, authenticated and service_role on its full
--   signature, then granted to authenticated. Every one is SECURITY DEFINER and checks its caller
--   (p_expected_user_id = auth.uid()), as before.
-- Locks: none on any table. CREATE OR REPLACE takes the five functions' pg_proc rows until commit (only another
--   replace of the same function waits). lock_timeout 3s.
-- Pre-check: each of the five functions is at the body its earlier migration wrote, or already at this file's body;
--   otherwise nothing is applied. Requires 20261123100000 (messages_upload, the install-scoped blob signature).
-- Re-runnable: CREATE OR REPLACE only.
-- Rollback: supabase/tests/backlog-4263-sync2-s2/rollback-20261123130000.sql (run it before any rollback of
--   20261123100000).
-- ============================================================================
DO $pre4263s2$
DECLARE r record; v text;
BEGIN
  IF to_regclass('public.cloud_release_switches') IS NULL
     OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_attribute a
                     WHERE a.attrelid = to_regclass('public.cloud_release_switches') AND a.attname = 'messages_upload'
                       AND NOT a.attisdropped) THEN
    RAISE EXCEPTION 'BACKLOG-4263 S2: apply 20261123100000 first';
  END IF;
  FOR r IN SELECT * FROM (VALUES
      ('public.cloud_upsert_messages(uuid,uuid,uuid,jsonb)', 'a71abe9743d2f9b6557c261ec09959a9', 'bf47b37b6978a5fd28900f325ad7dccb'),
      ('public.cloud_upsert_files(uuid,uuid,uuid,jsonb)', '0551bc2e4d92628df919008d28bc7b65', '1c451a46774bd4795a62ca3f0b506d1d'),
      ('public.cloud_register_blob(uuid,uuid,text,bigint,text)', 'f0bdbd8910e03c204f39199427a1ee53', 'e93b0145e909eb893e4a8be7ab05e160'),
      ('public.cloud_tombstone(uuid,uuid,text,uuid[])', '8397326470b7c4eacb4862f46d01b6d2', '0377717bb08178e111b2bff2767ffd85'),
      ('public.cloud_list_install_rows(uuid,uuid,text,uuid,integer)', '27af78e9a1df25e99a9db81b77013d31', 'fc083af905f66bcd6dfc8c0e5aa20636'))
      x(sig, head, mine) LOOP
    SELECT md5(p.prosrc) INTO v FROM pg_catalog.pg_proc p WHERE p.oid = to_regprocedure(r.sig);
    IF v IS NULL OR v NOT IN (r.head, r.mine) THEN
      RAISE EXCEPTION 'BACKLOG-4263 S2: % is not at the expected body (md5 %)', r.sig, coalesce(v, 'missing');
    END IF;
  END LOOP;
END
$pre4263s2$;
SET LOCAL lock_timeout = '3s';

-- ============================================================================ replaced: content paths, removal, reconcile
CREATE OR REPLACE FUNCTION public.cloud_upsert_messages(p_expected_user_id uuid, p_source_install_id uuid, p_cloud_deal_id uuid, p_rows jsonb) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = '' AS $f$
/*BODY:4263*/
DECLARE v_uid uuid := auth.uid(); v_deal uuid; r jsonb; i integer := 0; out jsonb := '[]'::jsonb;
        cur record; v_status text; v_body text; v_trunc boolean; v_kind text; v_state text; v_bad text;
BEGIN
  IF v_uid IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'not_entitled'); END IF;
  IF p_expected_user_id IS DISTINCT FROM v_uid THEN RETURN jsonb_build_object('ok', false, 'error', 'wrong_account'); END IF;   /*WHO:messages*/
  PERFORM 1 FROM public.cloud_autosave_settings WHERE user_id = v_uid FOR SHARE;
  IF public.cloud_autosave_entitled() IS NOT TRUE THEN                                       /*ENTITLED:messages*/
    RETURN jsonb_build_object('ok', false, 'error', 'not_entitled');
  END IF;
  IF public._cloud_install_removed(v_uid, p_source_install_id) THEN                       /*GATE:install:messages*/
    RETURN jsonb_build_object('ok', false, 'error', 'install_removed');
  END IF;
  IF public._cloud_install_inactive(v_uid, p_source_install_id) THEN                         /*GATE:active:messages*/
    RETURN jsonb_build_object('ok', false, 'error', 'computer_not_active');
  END IF;
  IF coalesce((SELECT w.messages_upload FROM public.cloud_release_switches w WHERE w.id), false) IS NOT TRUE THEN      /*GATE:upload:messages*/
    RETURN jsonb_build_object('ok', false, 'error', 'feature_off');
  END IF;
  SELECT d.id INTO v_deal FROM public.cloud_deals d
   WHERE d.id = p_cloud_deal_id AND d.owner_user_id = v_uid                                  /*OWNER:messages*/
     AND d.source_install_id = p_source_install_id                                           /*INSTALL:messages*/
     AND d.removed_at IS NULL                                                             /*GATE:live:messages*/
   FOR NO KEY UPDATE;
  IF v_deal IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'not_found'); END IF;
  IF jsonb_typeof(p_rows) IS DISTINCT FROM 'array' THEN RETURN jsonb_build_object('ok', false, 'error', 'invalid_input'); END IF;
  IF jsonb_array_length(p_rows) > 500 THEN RETURN jsonb_build_object('ok', false, 'error', 'batch_too_large'); END IF;   /*CAP:rows:messages*/
  IF octet_length(p_rows::text) > 16777216 THEN RETURN jsonb_build_object('ok', false, 'error', 'batch_too_large'); END IF;   /*CAP:bytes:messages*/
  FOR r IN SELECT value FROM jsonb_array_elements(p_rows) LOOP
    IF jsonb_typeof(r) IS DISTINCT FROM 'object'
       OR jsonb_typeof(r -> 'local_id') IS DISTINCT FROM 'string' OR (length(r ->> 'local_id') BETWEEN 1 AND 200) IS NOT TRUE
       OR ((r ->> 'content_hash') ~ '^[0-9a-f]{64}$') IS NOT TRUE
       OR (r ->> 'channel_kind') IN ('email', 'text') IS NOT TRUE
       OR jsonb_typeof(r -> 'hidden_from_export') IS DISTINCT FROM 'boolean'
       OR (r ? 'base_version' AND jsonb_typeof(r -> 'base_version') <> 'null'
           AND (jsonb_typeof(r -> 'base_version') <> 'number' OR NOT pg_input_is_valid(r ->> 'base_version', 'bigint'))) THEN
      RETURN jsonb_build_object('ok', false, 'error', 'invalid_input', 'detail', jsonb_build_object('index', i));
    END IF;
    i := i + 1;
  END LOOP;
  FOR r IN SELECT value FROM jsonb_array_elements(p_rows) LOOP
    v_kind := r ->> 'channel_kind';
    v_bad := public._cloud_bad_field(r, ARRAY['sent_at', 'received_at', 'linked_at', 'source_updated_at'],
                                     ARRAY['link_confidence'], ARRAY[]::text[], ARRAY[]::text[]);
    IF v_bad IS NULL AND r ->> 'channel' IS NOT NULL AND (r ->> 'channel') NOT IN ('email', 'sms', 'imessage') THEN v_bad := 'channel'; END IF;
    IF v_bad IS NULL AND coalesce(r ->> 'link_origin', 'link') NOT IN ('link', 'review_queue') THEN v_bad := 'link_origin'; END IF;
    IF v_bad IS NOT NULL THEN                                                                /*MSG:values*/
      out := out || jsonb_build_object('local_id', r ->> 'local_id', 'status', 'rejected', 'reason', 'invalid_value', 'field', v_bad);
      CONTINUE;
    END IF;
    IF coalesce(r ->> 'link_origin', 'link') = 'review_queue' THEN                            /*MSG:noqueue*/
      out := out || jsonb_build_object('local_id', r ->> 'local_id', 'status', 'rejected', 'reason', 'review_queue_not_accepted');
      CONTINUE;
    END IF;
    IF v_kind = 'text' AND r ->> 'thread_key' IS NULL THEN
      out := out || jsonb_build_object('local_id', r ->> 'local_id', 'status', 'rejected', 'reason', 'thread_key_required');
      CONTINUE;
    END IF;
    v_body := r ->> 'body_text'; v_trunc := false;
    IF char_length(v_body) > 1000000 THEN v_body := left(v_body, 1000000); v_trunc := true; END IF;   /*MSG:truncate*/
    v_state := CASE WHEN coalesce(r ->> 'link_origin', 'link') = 'review_queue' THEN 'suggested'
                    WHEN r ->> 'match_reason' = 'address_missing' THEN 'needs_review'
                    ELSE 'linked' END;                                                            /*MSG:linkstate*/
    INSERT INTO public.cloud_deal_messages (owner_user_id, cloud_deal_id, channel_kind, local_message_id, thread_key, content_hash, version)
    VALUES (v_uid, v_deal, v_kind, r ->> 'local_id', r ->> 'thread_key', r ->> 'content_hash', 0)
    ON CONFLICT (cloud_deal_id, channel_kind, local_message_id) DO NOTHING;
    SELECT * INTO cur FROM public.cloud_deal_messages
     WHERE cloud_deal_id = v_deal AND channel_kind = v_kind AND local_message_id = r ->> 'local_id' FOR UPDATE;
    v_status := public._cloud_row_status(cur.version, cur.removed_at, cur.content_hash, r ->> 'content_hash', (r ->> 'base_version')::bigint);
    IF v_status = 'applied' THEN
      UPDATE public.cloud_deal_messages SET
        local_link_id = r ->> 'local_link_id', channel = r ->> 'channel', direction = r ->> 'direction',
        subject = r ->> 'subject', body_text = v_body, body_truncated = v_trunc,
        participants = CASE WHEN jsonb_typeof(r -> 'participants') = 'null' THEN NULL ELSE r -> 'participants' END,
        thread_key = r ->> 'thread_key',
        sent_at = (r ->> 'sent_at')::timestamptz, received_at = (r ->> 'received_at')::timestamptz,
        link_source = r ->> 'link_source', link_confidence = (r ->> 'link_confidence')::double precision,
        match_reason = r ->> 'match_reason', linked_at = (r ->> 'linked_at')::timestamptz,
        link_origin = coalesce(r ->> 'link_origin', 'link'), link_state = v_state,
        hidden_from_export = (r ->> 'hidden_from_export')::boolean,
        source_updated_at = (r ->> 'source_updated_at')::timestamptz,
        content_hash = r ->> 'content_hash', version = cur.version + 1, updated_at = now(), removed_at = NULL
       WHERE id = cur.id RETURNING * INTO cur;
    END IF;
    out := out || jsonb_build_object('local_id', r ->> 'local_id', 'cloud_id', cur.id, 'version', cur.version,
                                     'content_hash', cur.content_hash, 'status', v_status, 'body_truncated', cur.body_truncated);
  END LOOP;
  UPDATE public.cloud_deals SET last_synced_at = greatest(last_synced_at, clock_timestamp()) WHERE id = v_deal;   /*MSG:touch*/
  RETURN jsonb_build_object('ok', true, 'results', out);
END $f$;
REVOKE ALL ON FUNCTION public.cloud_upsert_messages(uuid, uuid, uuid, jsonb) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.cloud_upsert_messages(uuid, uuid, uuid, jsonb) TO authenticated;
CREATE OR REPLACE FUNCTION public.cloud_upsert_files(p_expected_user_id uuid, p_source_install_id uuid, p_cloud_deal_id uuid, p_rows jsonb) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = '' AS $f$
/*BODY:4263*/
DECLARE v_uid uuid := auth.uid(); v_deal uuid; r jsonb; i integer := 0; out jsonb := '[]'::jsonb;
        cur record; v_status text; v_bad text; v_msg uuid; v_blob uuid; v_old_blob uuid; v_old_blobs uuid[] := '{}';
BEGIN
  IF v_uid IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'not_entitled'); END IF;
  IF p_expected_user_id IS DISTINCT FROM v_uid THEN RETURN jsonb_build_object('ok', false, 'error', 'wrong_account'); END IF;   /*WHO:files*/
  PERFORM 1 FROM public.cloud_autosave_settings WHERE user_id = v_uid FOR SHARE;
  IF public.cloud_autosave_entitled() IS NOT TRUE THEN                                       /*ENTITLED:files*/
    RETURN jsonb_build_object('ok', false, 'error', 'not_entitled');
  END IF;
  IF public._cloud_install_removed(v_uid, p_source_install_id) THEN                       /*GATE:install:files*/
    RETURN jsonb_build_object('ok', false, 'error', 'install_removed');
  END IF;
  IF public._cloud_install_inactive(v_uid, p_source_install_id) THEN                         /*GATE:active:files*/
    RETURN jsonb_build_object('ok', false, 'error', 'computer_not_active');
  END IF;
  IF coalesce((SELECT w.messages_upload FROM public.cloud_release_switches w WHERE w.id), false) IS NOT TRUE THEN      /*GATE:upload:files*/
    RETURN jsonb_build_object('ok', false, 'error', 'feature_off');
  END IF;
  SELECT d.id INTO v_deal FROM public.cloud_deals d
   WHERE d.id = p_cloud_deal_id AND d.owner_user_id = v_uid                                  /*OWNER:files*/
     AND d.source_install_id = p_source_install_id                                           /*INSTALL:files*/
     AND d.removed_at IS NULL                                                             /*GATE:live:files*/
   FOR NO KEY UPDATE;
  IF v_deal IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'not_found'); END IF;
  IF jsonb_typeof(p_rows) IS DISTINCT FROM 'array' THEN RETURN jsonb_build_object('ok', false, 'error', 'invalid_input'); END IF;
  IF jsonb_array_length(p_rows) > 500 THEN RETURN jsonb_build_object('ok', false, 'error', 'batch_too_large'); END IF;   /*CAP:rows:files*/
  IF octet_length(p_rows::text) > 16777216 THEN RETURN jsonb_build_object('ok', false, 'error', 'batch_too_large'); END IF;   /*CAP:bytes:files*/
  FOR r IN SELECT value FROM jsonb_array_elements(p_rows) LOOP
    IF jsonb_typeof(r) IS DISTINCT FROM 'object'
       OR jsonb_typeof(r -> 'local_id') IS DISTINCT FROM 'string' OR (length(r ->> 'local_id') BETWEEN 1 AND 200) IS NOT TRUE
       OR ((r ->> 'content_hash') ~ '^[0-9a-f]{64}$') IS NOT TRUE
       OR (r ? 'base_version' AND jsonb_typeof(r -> 'base_version') <> 'null'
           AND (jsonb_typeof(r -> 'base_version') <> 'number' OR NOT pg_input_is_valid(r ->> 'base_version', 'bigint'))) THEN
      RETURN jsonb_build_object('ok', false, 'error', 'invalid_input', 'detail', jsonb_build_object('index', i));
    END IF;
    i := i + 1;
  END LOOP;
  -- every blob this call can attach or replace, locked once, in id order
  PERFORM 1 FROM public.cloud_blobs b
   WHERE b.owner_user_id = v_uid
     AND ((b.purge_requested_at IS NULL AND b.sha256 IN (SELECT e ->> 'blob_sha256' FROM jsonb_array_elements(p_rows) e))
          OR b.id IN (SELECT f.blob_id FROM public.cloud_deal_files f
                       WHERE f.cloud_deal_id = v_deal
                         AND f.local_attachment_id IN (SELECT e ->> 'local_id' FROM jsonb_array_elements(p_rows) e)))
   ORDER BY b.id FOR UPDATE;                                                                 /*FILE:lockblobs*/
  FOR r IN SELECT value FROM jsonb_array_elements(p_rows) LOOP
    v_bad := public._cloud_bad_field(r, ARRAY['source_updated_at'], ARRAY[]::text[], ARRAY[]::text[], ARRAY[]::text[]);
    IF v_bad IS NULL AND (jsonb_typeof(r -> 'filename') IS DISTINCT FROM 'string' OR length(r ->> 'filename') = 0) THEN v_bad := 'filename'; END IF;
    IF v_bad IS NULL AND r ? 'size_bytes' AND jsonb_typeof(r -> 'size_bytes') <> 'null'
       AND (jsonb_typeof(r -> 'size_bytes') <> 'number' OR NOT pg_input_is_valid(r ->> 'size_bytes', 'bigint')) THEN v_bad := 'size_bytes'; END IF;
    IF v_bad IS NULL AND r ->> 'not_saved_reason' IS NOT NULL
       AND (r ->> 'not_saved_reason') NOT IN ('too_large', 'no_local_file', 'quota_exceeded') THEN v_bad := 'not_saved_reason'; END IF;
    IF v_bad IS NULL AND r ->> 'message_local_id' IS NOT NULL
       AND (r ->> 'message_channel_kind') IN ('email', 'text') IS NOT TRUE THEN v_bad := 'message_channel_kind'; END IF;
    IF v_bad IS NULL AND r ->> 'blob_sha256' IS NOT NULL AND ((r ->> 'blob_sha256') ~ '^[0-9a-f]{64}$') IS NOT TRUE THEN v_bad := 'blob_sha256'; END IF;
    IF v_bad IS NOT NULL THEN
      out := out || jsonb_build_object('local_id', r ->> 'local_id', 'status', 'rejected', 'reason', 'invalid_value', 'field', v_bad);
      CONTINUE;
    END IF;
    v_msg := NULL; v_blob := NULL;
    IF r ->> 'message_local_id' IS NOT NULL THEN
      SELECT m.id INTO v_msg FROM public.cloud_deal_messages m
       WHERE m.cloud_deal_id = v_deal AND m.channel_kind = r ->> 'message_channel_kind'
         AND m.local_message_id = r ->> 'message_local_id'
         AND m.removed_at IS NULL;                                                            /*FILE:livemessage*/
      IF v_msg IS NULL THEN
        out := out || jsonb_build_object('local_id', r ->> 'local_id', 'status', 'rejected', 'reason', 'parent_missing');
        CONTINUE;
      END IF;
    END IF;
    IF r ->> 'blob_sha256' IS NOT NULL THEN
      SELECT b.id INTO v_blob FROM public.cloud_blobs b
       WHERE b.owner_user_id = v_uid                                                          /*OWNER:fileblob*/
         AND b.sha256 = r ->> 'blob_sha256'
         AND b.uploaded_at IS NOT NULL                                                        /*FILE:uploaded*/
         AND b.purge_requested_at IS NULL;                                                    /*FILE:unfenced*/
      IF v_blob IS NULL THEN
        out := out || jsonb_build_object('local_id', r ->> 'local_id', 'status', 'rejected', 'reason', 'blob_unavailable');
        CONTINUE;
      END IF;
    END IF;
    INSERT INTO public.cloud_deal_files (owner_user_id, cloud_deal_id, local_attachment_id, filename, content_hash, version)
    VALUES (v_uid, v_deal, r ->> 'local_id', r ->> 'filename', r ->> 'content_hash', 0)
    ON CONFLICT (cloud_deal_id, local_attachment_id) DO NOTHING;
    SELECT * INTO cur FROM public.cloud_deal_files WHERE cloud_deal_id = v_deal AND local_attachment_id = r ->> 'local_id' FOR UPDATE;
    v_status := public._cloud_row_status(cur.version, cur.removed_at, cur.content_hash, r ->> 'content_hash', (r ->> 'base_version')::bigint);
    IF v_status = 'applied' THEN
      v_old_blob := cur.blob_id;
      UPDATE public.cloud_deal_files SET
        cloud_message_id = v_msg, blob_id = v_blob, filename = r ->> 'filename', mime_type = r ->> 'mime_type',
        size_bytes = (r ->> 'size_bytes')::bigint, not_saved_reason = r ->> 'not_saved_reason',
        source_updated_at = (r ->> 'source_updated_at')::timestamptz,
        content_hash = r ->> 'content_hash', version = cur.version + 1, updated_at = now(), removed_at = NULL
       WHERE id = cur.id RETURNING * INTO cur;
      IF v_old_blob IS NOT NULL AND v_old_blob IS DISTINCT FROM v_blob THEN
        v_old_blobs := v_old_blobs || v_old_blob;
      END IF;
    END IF;
    out := out || jsonb_build_object('local_id', r ->> 'local_id', 'cloud_id', cur.id, 'version', cur.version,
                                     'content_hash', cur.content_hash, 'status', v_status);
  END LOOP;
  PERFORM public._cloud_fence_unreferenced(v_uid, v_old_blobs);                              /*FILE:fence*/
  UPDATE public.cloud_deals SET last_synced_at = greatest(last_synced_at, clock_timestamp()) WHERE id = v_deal;   /*CLOCK:files*/
  RETURN jsonb_build_object('ok', true, 'results', out);
END $f$;
REVOKE ALL ON FUNCTION public.cloud_upsert_files(uuid, uuid, uuid, jsonb) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.cloud_upsert_files(uuid, uuid, uuid, jsonb) TO authenticated;
CREATE OR REPLACE FUNCTION public.cloud_register_blob(p_expected_user_id uuid, p_source_install_id uuid, p_sha256 text, p_size_bytes bigint,
                                                      p_mime_type text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = '' AS $f$
/*BODY:4263-s1*/
DECLARE v_uid uuid := auth.uid(); b record; v_id uuid := gen_random_uuid();
BEGIN
  IF v_uid IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'not_entitled'); END IF;
  IF p_expected_user_id IS DISTINCT FROM v_uid THEN RETURN jsonb_build_object('ok', false, 'error', 'wrong_account'); END IF;   /*WHO:register*/
  IF p_source_install_id IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'invalid_input'); END IF;
  PERFORM 1 FROM public.cloud_autosave_settings WHERE user_id = v_uid FOR SHARE;                  /*LOCK:register*/
  IF public.cloud_autosave_entitled() IS NOT TRUE THEN                                       /*ENTITLED:register*/
    RETURN jsonb_build_object('ok', false, 'error', 'not_entitled');
  END IF;
  IF public._cloud_install_inactive(v_uid, p_source_install_id) THEN                           /*GATE:active:register*/
    RETURN jsonb_build_object('ok', false, 'error', 'computer_not_active');
  END IF;
  IF coalesce((SELECT w.messages_upload FROM public.cloud_release_switches w WHERE w.id), false) IS NOT TRUE THEN      /*GATE:upload:register*/
    RETURN jsonb_build_object('ok', false, 'error', 'feature_off');
  END IF;
  IF (p_sha256 ~ '^[0-9a-f]{64}$') IS NOT TRUE OR p_size_bytes IS NULL OR p_size_bytes <= 0 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'invalid_input');
  END IF;
  IF p_size_bytes > 52428800 THEN RETURN jsonb_build_object('ok', false, 'error', 'too_large'); END IF;   /*CAP:blob*/
  INSERT INTO public.cloud_blobs (id, owner_user_id, sha256, size_bytes, mime_type, storage_path)
  VALUES (v_id, v_uid, p_sha256, p_size_bytes, p_mime_type, v_uid::text || '/' || v_id::text)
  ON CONFLICT (owner_user_id, sha256) WHERE purge_requested_at IS NULL DO NOTHING;
  SELECT * INTO b FROM public.cloud_blobs x
   WHERE x.owner_user_id = v_uid AND x.sha256 = p_sha256 AND x.purge_requested_at IS NULL FOR UPDATE;
  RETURN jsonb_build_object('ok', true, 'blob_id', b.id, 'storage_path', b.storage_path,
    'state', CASE WHEN b.id = v_id THEN 'new' WHEN b.uploaded_at IS NULL THEN 'pending' ELSE 'uploaded' END);
END $f$;
REVOKE ALL ON FUNCTION public.cloud_register_blob(uuid, uuid, text, bigint, text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.cloud_register_blob(uuid, uuid, text, bigint, text) TO authenticated;
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
  IF public._cloud_install_inactive(v_uid, p_source_install_id) THEN                         /*GATE:active:tombstone*/
    RETURN jsonb_build_object('ok', false, 'error', 'computer_not_active');
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
      -- the message's live file rows are removed in the same call, as kind 'file' removes them; their blobs are fenced below
      SELECT v_fence || coalesce(array_agg(x.blob_id ORDER BY x.id) FILTER (WHERE x.blob_id IS NOT NULL), '{}')
        INTO v_fence
        FROM (SELECT f.id, f.blob_id FROM public.cloud_deal_files f
               WHERE f.cloud_message_id = v_row_id AND f.cloud_deal_id = v_row_deal AND f.owner_user_id = v_uid
                 AND f.removed_at IS NULL
               ORDER BY f.id FOR UPDATE) x;                                                     /*TOMB:msgfiles:lock*/
      UPDATE public.cloud_deal_files f SET removed_at = now(), version = f.version + 1, updated_at = now(),
             filename = NULL, blob_id = NULL
       WHERE f.cloud_message_id = v_row_id AND f.cloud_deal_id = v_row_deal AND f.owner_user_id = v_uid
         AND f.removed_at IS NULL;                                                              /*TOMB:msgfiles*/
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
      ,('message',       'cloud_deal_messages',        'local_message_id',     't.cloud_deal_id', 't.removed_at IS NOT NULL OR d.removed_at IS NOT NULL')  /*LIST:message*/
      ,('file',          'cloud_deal_files',           'local_attachment_id',  't.cloud_deal_id', 't.removed_at IS NOT NULL OR d.removed_at IS NOT NULL')  /*LIST:file*/
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
  IF p_kind = 'message' THEN                                                                  /*LIST:channel_kind*/
    SELECT coalesce(jsonb_agg(e.value || jsonb_build_object('channel_kind', m.channel_kind) ORDER BY e.n), '[]'::jsonb)
      INTO v_rows
      FROM jsonb_array_elements(v_rows) WITH ORDINALITY e(value, n)
      LEFT JOIN public.cloud_deal_messages m ON m.id = (e.value ->> 'cloud_id')::uuid;
  END IF;
  RETURN jsonb_build_object('ok', true, 'rows', v_rows,
                            'next_after', CASE WHEN v_n = v_limit THEN v_last END);
END $f$;
REVOKE ALL ON FUNCTION public.cloud_list_install_rows(uuid, uuid, text, uuid, integer) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.cloud_list_install_rows(uuid, uuid, text, uuid, integer) TO authenticated;

-- ============================================================================ post-check
DO $post4263s2$
DECLARE r record; v text; bad text := '';
BEGIN
  FOR r IN SELECT * FROM (VALUES
      ('public.cloud_upsert_messages(uuid,uuid,uuid,jsonb)', 'bf47b37b6978a5fd28900f325ad7dccb'),
      ('public.cloud_upsert_files(uuid,uuid,uuid,jsonb)', '1c451a46774bd4795a62ca3f0b506d1d'),
      ('public.cloud_register_blob(uuid,uuid,text,bigint,text)', 'e93b0145e909eb893e4a8be7ab05e160'),
      ('public.cloud_tombstone(uuid,uuid,text,uuid[])', '0377717bb08178e111b2bff2767ffd85'),
      ('public.cloud_list_install_rows(uuid,uuid,text,uuid,integer)', 'fc083af905f66bcd6dfc8c0e5aa20636'))
      x(sig, want_md5) LOOP
    SELECT CASE
             WHEN p.oid IS NULL THEN 'missing'
             WHEN md5(p.prosrc) <> r.want_md5 THEN 'md5'
             WHEN p.prosecdef IS NOT TRUE THEN 'security definer'
             WHEN array_to_string(p.proconfig, ',') IS DISTINCT FROM 'search_path=""' THEN 'search_path'
             WHEN has_function_privilege('anon', p.oid, 'EXECUTE') THEN 'anon'
             WHEN NOT has_function_privilege('authenticated', p.oid, 'EXECUTE') THEN 'authenticated'
             WHEN has_function_privilege('service_role', p.oid, 'EXECUTE') THEN 'service_role'
             ELSE NULL END
      INTO v
      FROM (SELECT to_regprocedure(r.sig) AS oid) o LEFT JOIN pg_catalog.pg_proc p ON p.oid = o.oid;
    IF v IS NOT NULL THEN bad := bad || r.sig || ' ' || v || '; '; END IF;
  END LOOP;
  IF (SELECT provolatile FROM pg_catalog.pg_proc WHERE oid = 'public.cloud_list_install_rows(uuid,uuid,text,uuid,integer)'::regprocedure) <> 's' THEN
    bad := bad || 'cloud_list_install_rows not STABLE; ';
  END IF;
  IF bad <> '' THEN
    RAISE EXCEPTION 'BACKLOG-4263 S2: post-check failed: %', bad;
  END IF;
END
$post4263s2$;
