-- BACKLOG-4243 PR-0 probes. Loaded after lib/fixtures.sql, inside the same transaction.
-- Each probe runs in its own subtransaction that is undone at its end and returns 'PASS' or
-- 'FAIL: <detail>'. They read the base fixtures (pg_temp.base()), so base() must have run.

-- Every row of the nine cloud tables, as one md5. Equal before and after a call = the call wrote nothing.
CREATE FUNCTION pg_temp.snap() RETURNS text LANGUAGE sql AS $h$
  SELECT md5(coalesce(string_agg(x, '|' ORDER BY x), '')) FROM (
    SELECT 'settings' || t::text AS x FROM public.cloud_autosave_settings t UNION ALL
    SELECT 'addons' || t::text FROM public.member_addons t UNION ALL
    SELECT 'deals' || t::text FROM public.cloud_deals t UNION ALL
    SELECT 'parties' || t::text FROM public.cloud_deal_parties t UNION ALL
    SELECT 'checklists' || t::text FROM public.cloud_deal_checklists t UNION ALL
    SELECT 'items' || t::text FROM public.cloud_deal_checklist_items t UNION ALL
    SELECT 'messages' || t::text FROM public.cloud_deal_messages t UNION ALL
    SELECT 'blobs' || t::text FROM public.cloud_blobs t UNION ALL
    SELECT 'files' || t::text FROM public.cloud_deal_files t) y
$h$;

-- One call of a client write by `caller` with p_expected_user_id = `exp`. Arguments other than the
-- expected user are valid for user A's base fixtures, so only the expected-user check can refuse.
CREATE FUNCTION pg_temp.k6_call(fn text, caller uuid, exp uuid) RETURNS text LANGUAGE plpgsql AS $h$
DECLARE A uuid := pg_temp.fx(1); I1 uuid := pg_temp.fx(301); D1 uuid; P1 uuid; BLK uuid; q text;
BEGIN
  SELECT id INTO D1 FROM public.cloud_deals WHERE owner_user_id = A AND source_install_id = I1 AND local_transaction_id = 't-1';
  SELECT id INTO P1 FROM public.cloud_deal_parties WHERE cloud_deal_id = D1 AND local_party_id = 'p-1';
  SELECT id INTO BLK FROM public.cloud_blobs WHERE owner_user_id = A AND sha256 = pg_temp.h('k6-c') AND purge_requested_at IS NULL;
  q := CASE fn
    WHEN 'set_my_cloud_autosave' THEN format('SELECT public.set_my_cloud_autosave(%L::uuid, false, NULL::integer)', exp)
    WHEN 'cloud_delete_install' THEN format('SELECT public.cloud_delete_install(%L::uuid, %L::uuid)', exp, I1)
    WHEN 'cloud_upsert_deal' THEN format('SELECT public.cloud_upsert_deal(%L::uuid, %L::jsonb)', exp,
      jsonb_build_object('source_install_id', I1, 'local_id', 'k6-deal', 'content_hash', pg_temp.h('k6-deal')))
    WHEN 'cloud_tombstone' THEN format('SELECT public.cloud_tombstone(%L::uuid, %L::uuid, %L, %L::uuid[])', exp, I1, 'party', ARRAY[P1])
    WHEN 'cloud_delete_deal' THEN format('SELECT public.cloud_delete_deal(%L::uuid, %L::uuid)', exp, D1)
    WHEN 'cloud_mark_deal_synced' THEN format('SELECT public.cloud_mark_deal_synced(%L::uuid, %L::uuid, %L::uuid)', exp, I1, D1)
    WHEN 'cloud_register_blob' THEN format('SELECT public.cloud_register_blob(%L::uuid, %L, 5, NULL)', exp, pg_temp.h('k6-r'))
    WHEN 'cloud_confirm_blob' THEN format('SELECT public.cloud_confirm_blob(%L::uuid, %L::uuid)', exp, BLK)
    ELSE format('SELECT public.%I(%L::uuid, %L::uuid, %L::uuid, %L::jsonb)', fn, exp, I1, D1,
      jsonb_build_array(pg_temp.row_of(fn, 'k6-row')))
  END;
  RETURN pg_temp.call_as(caller, q);
END $h$;

-- C0.1: expected = another real user, and expected = NULL -> wrong_account and no row of any cloud
-- table changed; expected = caller -> the call succeeds and changes rows. set_my_cloud_autosave and
-- cloud_delete_install are called by a user with no settings row (X), so a write placed before the
-- check (the settings INSERT) changes the snapshot.
CREATE FUNCTION pg_temp.k6_probe(fn text) RETURNS text LANGUAGE plpgsql AS $h$
DECLARE A uuid := pg_temp.fx(1); B uuid := pg_temp.fx(2); X uuid := pg_temp.fx(6);
        caller uuid; key text; js jsonb; s0 text; s1 text; s2 text; s3 text; tw text; tn text; tp text; res text; pre boolean;
BEGIN
  caller := CASE WHEN fn IN ('set_my_cloud_autosave', 'cloud_delete_install') THEN X ELSE A END;
  key := CASE WHEN fn IN ('set_my_cloud_autosave', 'cloud_delete_install') THEN 'success' ELSE 'ok' END;
  BEGIN
    IF fn = 'cloud_confirm_blob' THEN
      js := pg_temp.j(pg_temp.call_as(A, format('SELECT public.cloud_register_blob(%L::uuid, %L, 4, NULL)', A, pg_temp.h('k6-c'))));
      PERFORM pg_temp.call_as(A, format('INSERT INTO storage.objects (bucket_id, name, metadata) VALUES (%L, %L, %L::jsonb)',
                                        'cloud-deal-files', js ->> 'storage_path', '{"size":"4"}'));
    END IF;
    pre := NOT EXISTS (SELECT 1 FROM public.cloud_autosave_settings WHERE user_id = X);
    s0 := pg_temp.snap();
    tw := pg_temp.k6_call(fn, caller, B);
    s1 := pg_temp.snap();
    tn := pg_temp.k6_call(fn, caller, NULL);
    s2 := pg_temp.snap();
    tp := pg_temp.k6_call(fn, caller, caller);
    s3 := pg_temp.snap();
    res := pg_temp.pass(pre
      AND pg_temp.j(tw) ->> 'error' = 'wrong_account' AND pg_temp.j(tw) ->> key = 'false' AND s1 = s0
      AND pg_temp.j(tn) ->> 'error' = 'wrong_account' AND pg_temp.j(tn) ->> key = 'false' AND s2 = s0
      AND pg_temp.err(tp) = 'OK' AND s3 <> s0,
      fn || ' wrong=' || left(tw, 120) || ' null=' || left(tn, 120) || ' self=' || left(tp, 160)
         || ' changed_by_wrong=' || (s1 <> s0) || ' changed_by_null=' || (s2 <> s0) || ' changed_by_self=' || (s3 <> s0) || ' x_clean=' || pre);
    RAISE EXCEPTION USING ERRCODE = 'T4243';
  EXCEPTION WHEN SQLSTATE 'T4243' THEN NULL;
            WHEN OTHERS THEN EXECUTE 'RESET ROLE'; res := 'FAIL: crash ' || SQLSTATE || ' ' || SQLERRM;
  END;
  RETURN res;
END $h$;

-- C0.3 / C0.2 catalog: every new signature exists with EXECUTE for authenticated only (not PUBLIC,
-- anon or service_role), and no earlier signature of the 13 writes exists.
CREATE FUNCTION pg_temp.k6_catalog() RETURNS text LANGUAGE plpgsql AS $h$
DECLARE s text; acc text := '';
  NEW_SIGS text[] := ARRAY['public.set_my_cloud_autosave(uuid,boolean,integer)', 'public.cloud_delete_install(uuid,uuid)',
    'public.cloud_upsert_deal(uuid,jsonb)', 'public.cloud_upsert_parties(uuid,uuid,uuid,jsonb)', 'public.cloud_upsert_checklists(uuid,uuid,uuid,jsonb)',
    'public.cloud_upsert_checklist_items(uuid,uuid,uuid,jsonb)', 'public.cloud_upsert_messages(uuid,uuid,uuid,jsonb)',
    'public.cloud_upsert_files(uuid,uuid,uuid,jsonb)', 'public.cloud_tombstone(uuid,uuid,text,uuid[])', 'public.cloud_delete_deal(uuid,uuid)',
    'public.cloud_mark_deal_synced(uuid,uuid,uuid)', 'public.cloud_register_blob(uuid,text,bigint,text)', 'public.cloud_confirm_blob(uuid,uuid)'];
  OLD_SIGS text[] := ARRAY['public.set_my_cloud_autosave(boolean,integer)', 'public.cloud_delete_install(uuid)',
    'public.cloud_upsert_deal(jsonb)', 'public.cloud_upsert_parties(uuid,uuid,jsonb)', 'public.cloud_upsert_checklists(uuid,uuid,jsonb)',
    'public.cloud_upsert_checklist_items(uuid,uuid,jsonb)', 'public.cloud_upsert_messages(uuid,uuid,jsonb)',
    'public.cloud_upsert_files(uuid,uuid,jsonb)', 'public.cloud_tombstone(uuid,text,uuid[])', 'public.cloud_delete_deal(uuid)',
    'public.cloud_mark_deal_synced(uuid,uuid)', 'public.cloud_register_blob(text,bigint,text)', 'public.cloud_confirm_blob(uuid)'];
BEGIN
  FOREACH s IN ARRAY NEW_SIGS LOOP
    IF to_regprocedure(s) IS NULL THEN acc := acc || ' missing:' || s; CONTINUE; END IF;
    IF has_function_privilege('public', s, 'EXECUTE') OR has_function_privilege('anon', s, 'EXECUTE')
       OR has_function_privilege('service_role', s, 'EXECUTE') OR NOT has_function_privilege('authenticated', s, 'EXECUTE') THEN
      acc := acc || ' acl:' || s || '=' || coalesce((SELECT proacl::text FROM pg_proc WHERE oid = to_regprocedure(s)), 'null');
    END IF;
  END LOOP;
  FOREACH s IN ARRAY OLD_SIGS LOOP
    IF to_regprocedure(s) IS NOT NULL THEN acc := acc || ' old_present:' || s; END IF;
  END LOOP;
  RETURN pg_temp.pass(acc = '', acc);
END $h$;

-- C0.5 (K1): a file row cannot attach a registered blob that is not uploaded; after the upload is
-- confirmed the same row is applied.
CREATE FUNCTION pg_temp.k1_probe() RETURNS text LANGUAGE plpgsql AS $h$
DECLARE A uuid := pg_temp.fx(1); I1 uuid := pg_temp.fx(301); D1 uuid; js jsonb; row_ jsonb; t1 text; t2 text; c text; res text;
BEGIN
  BEGIN
    SELECT id INTO D1 FROM public.cloud_deals WHERE owner_user_id = A AND source_install_id = I1 AND local_transaction_id = 't-1';
    js := pg_temp.j(pg_temp.call_as(A, format('SELECT public.cloud_register_blob(%L::uuid, %L, 3, NULL)', A, pg_temp.h('k1-blob'))));
    row_ := jsonb_build_array(jsonb_build_object('local_id', 'k1-f', 'content_hash', pg_temp.h('k1-f'), 'filename', 'k1.pdf',
                                                 'blob_sha256', pg_temp.h('k1-blob')));
    t1 := pg_temp.up(A, 'cloud_upsert_files', I1, D1, row_);
    PERFORM pg_temp.call_as(A, format('INSERT INTO storage.objects (bucket_id, name, metadata) VALUES (%L, %L, %L::jsonb)',
                                      'cloud-deal-files', js ->> 'storage_path', '{"size":"3"}'));
    c := pg_temp.err(pg_temp.call_as(A, format('SELECT public.cloud_confirm_blob(%L::uuid, %L::uuid)', A, js ->> 'blob_id')));
    t2 := pg_temp.up(A, 'cloud_upsert_files', I1, D1, row_);
    res := pg_temp.pass(js ->> 'state' = 'new' AND pg_temp.st(t1) = 'rejected:blob_unavailable' AND c = 'OK' AND pg_temp.st(t2) = 'applied'
      AND (SELECT blob_id FROM public.cloud_deal_files WHERE cloud_deal_id = D1 AND local_attachment_id = 'k1-f') = (js ->> 'blob_id')::uuid,
      'register=' || coalesce(js ->> 'state', 'null') || ' before_upload=' || t1 || ' confirm=' || c || ' after=' || t2);
    RAISE EXCEPTION USING ERRCODE = 'T4243';
  EXCEPTION WHEN SQLSTATE 'T4243' THEN NULL;
            WHEN OTHERS THEN EXECUTE 'RESET ROLE'; res := 'FAIL: crash ' || SQLSTATE || ' ' || SQLERRM;
  END;
  RETURN res;
END $h$;

-- C0.6 (K2): a file row cannot attach to a tombstoned message; attaching to a live message is applied.
CREATE FUNCTION pg_temp.k2_probe() RETURNS text LANGUAGE plpgsql AS $h$
DECLARE A uuid := pg_temp.fx(1); I1 uuid := pg_temp.fx(301); D1 uuid; M1 uuid; t0 text; t1 text; t2 text; tm text; res text;
BEGIN
  BEGIN
    SELECT id INTO D1 FROM public.cloud_deals WHERE owner_user_id = A AND source_install_id = I1 AND local_transaction_id = 't-1';
    SELECT id INTO M1 FROM public.cloud_deal_messages WHERE cloud_deal_id = D1 AND local_message_id = 'm-1';
    t0 := pg_temp.tomb(A, I1, 'message', ARRAY[M1]);
    t1 := pg_temp.up(A, 'cloud_upsert_files', I1, D1, jsonb_build_array(jsonb_build_object('local_id', 'k2-f', 'content_hash', pg_temp.h('k2-f'),
            'filename', 'k2.pdf', 'message_channel_kind', 'email', 'message_local_id', 'm-1')));
    tm := pg_temp.up(A, 'cloud_upsert_messages', I1, D1, jsonb_build_array(pg_temp.row_of('cloud_upsert_messages', 'k2-m')));
    t2 := pg_temp.up(A, 'cloud_upsert_files', I1, D1, jsonb_build_array(jsonb_build_object('local_id', 'k2-g', 'content_hash', pg_temp.h('k2-g'),
            'filename', 'k2g.pdf', 'message_channel_kind', 'email', 'message_local_id', 'k2-m')));
    res := pg_temp.pass(pg_temp.st(t0) = 'removed' AND pg_temp.st(t1) = 'rejected:parent_missing'
      AND pg_temp.st(tm) = 'applied' AND pg_temp.st(t2) = 'applied'
      AND (SELECT f.cloud_message_id = m.id FROM public.cloud_deal_files f JOIN public.cloud_deal_messages m ON m.cloud_deal_id = D1 AND m.local_message_id = 'k2-m'
            WHERE f.cloud_deal_id = D1 AND f.local_attachment_id = 'k2-g'),
      'tomb=' || t0 || ' removed_parent=' || t1 || ' msg=' || tm || ' live_parent=' || t2);
    RAISE EXCEPTION USING ERRCODE = 'T4243';
  EXCEPTION WHEN SQLSTATE 'T4243' THEN NULL;
            WHEN OTHERS THEN EXECUTE 'RESET ROLE'; res := 'FAIL: crash ' || SQLSTATE || ' ' || SQLERRM;
  END;
  RETURN res;
END $h$;

-- C0.7 (K4): confirm with a stored size that differs -> size_mismatch and the blob is fenced; the next
-- register of the same content returns a new blob id.
CREATE FUNCTION pg_temp.k4_probe() RETURNS text LANGUAGE plpgsql AS $h$
DECLARE A uuid := pg_temp.fx(1); js jsonb; js2 jsonb; c text; res text;
BEGIN
  BEGIN
    js := pg_temp.j(pg_temp.call_as(A, format('SELECT public.cloud_register_blob(%L::uuid, %L, 9, NULL)', A, pg_temp.h('k4-blob'))));
    PERFORM pg_temp.call_as(A, format('INSERT INTO storage.objects (bucket_id, name, metadata) VALUES (%L, %L, %L::jsonb)',
                                      'cloud-deal-files', js ->> 'storage_path', '{"size":"8"}'));
    c := pg_temp.err(pg_temp.call_as(A, format('SELECT public.cloud_confirm_blob(%L::uuid, %L::uuid)', A, js ->> 'blob_id')));
    js2 := pg_temp.j(pg_temp.call_as(A, format('SELECT public.cloud_register_blob(%L::uuid, %L, 9, NULL)', A, pg_temp.h('k4-blob'))));
    res := pg_temp.pass(c = 'size_mismatch'
      AND (SELECT purge_requested_at IS NOT NULL AND uploaded_at IS NULL FROM public.cloud_blobs WHERE id = (js ->> 'blob_id')::uuid)
      AND js2 ->> 'state' = 'new' AND (js2 ->> 'blob_id')::uuid IS DISTINCT FROM (js ->> 'blob_id')::uuid,
      'confirm=' || c || ' second_register=' || coalesce(js2::text, 'null'));
    RAISE EXCEPTION USING ERRCODE = 'T4243';
  EXCEPTION WHEN SQLSTATE 'T4243' THEN NULL;
            WHEN OTHERS THEN EXECUTE 'RESET ROLE'; res := 'FAIL: crash ' || SQLSTATE || ' ' || SQLERRM;
  END;
  RETURN res;
END $h$;
