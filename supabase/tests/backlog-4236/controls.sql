-- BACKLOG-4236 PR-1 controls (single session). compose.py places this after the rollback, M1 twice,
-- M2 twice, lib/helpers.sql and lib/fixtures.sql. The call ends in RAISE, so nothing persists.
-- Each block runs in its own subtransaction that is undone at its end; the base fixtures
-- (lib/fixtures.sql) are shared. Every refusal block keeps the other gates open so the gate under
-- test is the only one that can refuse.

CREATE FUNCTION pg_temp.run() RETURNS jsonb LANGUAGE plpgsql AS $run$
DECLARE
  r jsonb := '{}'::jsonb; base jsonb;
  A uuid := pg_temp.fx(1); B uuid := pg_temp.fx(2); AD uuid := pg_temp.fx(3); S uuid := pg_temp.fx(4);
  J uuid := pg_temp.fx(5); X uuid := pg_temp.fx(6); IR uuid := pg_temp.fx(7);
  O uuid := pg_temp.fx(101); O2 uuid := pg_temp.fx(102); PS uuid := pg_temp.fx(104);
  I1 uuid := pg_temp.fx(301); I2 uuid := pg_temp.fx(302);
  D1 uuid; SD uuid; M1 uuid; F1 uuid; C1 uuid; IT1 uuid; P1 uuid; BL uuid;
  t text; t2 text; t3 text; acc text; ok boolean; n bigint; n2 bigint; js jsonb; js2 jsonb; u uuid; u2 uuid; fn text;
  CHILD_FNS text[] := ARRAY['cloud_upsert_parties', 'cloud_upsert_checklists', 'cloud_upsert_checklist_items', 'cloud_upsert_messages', 'cloud_upsert_files'];
  TABLES text[] := ARRAY['cloud_autosave_settings', 'member_addons', 'cloud_deals', 'cloud_deal_parties', 'cloud_deal_checklists',
                         'cloud_deal_checklist_items', 'cloud_deal_messages', 'cloud_blobs', 'cloud_deal_files'];
  AUTH_FNS text[] := ARRAY['public.cloud_autosave_entitled()', 'public.get_my_cloud_autosave_state()',
    'public.set_my_cloud_autosave(uuid,boolean,integer)', 'public.cloud_list_installs()', 'public.cloud_delete_install(uuid,uuid)',
    'public.cloud_upsert_deal(uuid,jsonb)', 'public.cloud_upsert_parties(uuid,uuid,uuid,jsonb)', 'public.cloud_upsert_checklists(uuid,uuid,uuid,jsonb)',
    'public.cloud_upsert_checklist_items(uuid,uuid,uuid,jsonb)', 'public.cloud_upsert_messages(uuid,uuid,uuid,jsonb)',
    'public.cloud_upsert_files(uuid,uuid,uuid,jsonb)', 'public.cloud_register_blob(uuid,text,bigint,text)', 'public.cloud_confirm_blob(uuid,uuid)',
    'public.cloud_tombstone(uuid,uuid,text,uuid[])', 'public.cloud_delete_deal(uuid,uuid)', 'public.cloud_mark_deal_synced(uuid,uuid,uuid)'];
  SVC_FNS text[] := ARRAY['public.assign_member_addon(uuid,uuid,text,boolean,timestamp with time zone)'];
  NONE_FNS text[] := ARRAY['public._cloud_autosave_license(uuid)', 'public._cloud_autosave_current_notice_version()',
    'public._cloud_bad_field(jsonb,text[],text[],text[],text[])', 'public._cloud_row_status(bigint,timestamp with time zone,text,text,bigint)',
    'public._cloud_fence_unreferenced(uuid,uuid[])'];
BEGIN
  base := pg_temp.base();
  D1 := (base ->> 'deal_A_id')::uuid;
  SELECT id INTO SD FROM public.cloud_deals WHERE owner_user_id = S;
  SELECT id INTO M1 FROM public.cloud_deal_messages WHERE cloud_deal_id = D1 AND local_message_id = 'm-1';
  SELECT id INTO F1 FROM public.cloud_deal_files WHERE cloud_deal_id = D1 AND local_attachment_id = 'f-1';
  SELECT id INTO C1 FROM public.cloud_deal_checklists WHERE cloud_deal_id = D1 AND local_checklist_id = 'cl-1';
  SELECT id INTO IT1 FROM public.cloud_deal_checklist_items WHERE cloud_deal_id = D1 AND local_item_id = 'it-1';
  SELECT id INTO P1 FROM public.cloud_deal_parties WHERE cloud_deal_id = D1 AND local_party_id = 'p-1';
  SELECT id INTO BL FROM public.cloud_blobs WHERE owner_user_id = A;
  r := r || jsonb_build_object('K0_fixtures', pg_temp.pass(
    base ->> 'assign_A' = 'OK' AND base ->> 'on_A' = 'OK' AND base ->> 'on_S' = 'OK' AND base ->> 'deal_A' = 'applied'
    AND base ->> 'cl_A' = 'applied' AND base ->> 'item_A' = 'applied' AND base ->> 'party_A' = 'applied' AND base ->> 'msg_A' = 'applied'
    AND base ->> 'blob_A' = 'new' AND base ->> 'obj_A' = '"rows=1"' AND base ->> 'confirm_A' = 'OK' AND base ->> 'file_A' = 'applied'
    AND base ->> 'deal_S' = 'applied' AND D1 IS NOT NULL AND SD IS NOT NULL AND F1 IS NOT NULL AND BL IS NOT NULL
    AND (SELECT blob_id FROM public.cloud_deal_files WHERE id = F1) = BL, base::text));

  -- ===================================================================== grants and catalog
  BEGIN
    acc := '';
    FOREACH t IN ARRAY TABLES LOOP
      FOREACH t2 IN ARRAY ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'] LOOP
        IF has_table_privilege('anon', ('public.' || t)::regclass, t2) THEN acc := acc || ' anon:' || t || ':' || t2; END IF;
        IF has_table_privilege('authenticated', ('public.' || t)::regclass, t2) <> (t2 = 'SELECT') THEN acc := acc || ' auth:' || t || ':' || t2; END IF;
      END LOOP;
      IF (SELECT relacl::text FROM pg_class WHERE oid = ('public.' || t)::regclass) ~ '(^|[{,])=' THEN acc := acc || ' public:' || t; END IF;
    END LOOP;
    -- every table this PR creates, from the catalog (not only the hand list)
    SELECT count(*) INTO n FROM pg_class c WHERE c.relnamespace = 'public'::regnamespace AND c.relkind = 'r'
       AND (c.relname LIKE 'cloud\_%' OR c.relname = 'member_addons') AND NOT (c.relname = ANY (TABLES));
    r := r || jsonb_build_object('A1_table_privileges', pg_temp.pass(acc = '' AND n = 0, acc || ' extra_tables=' || n));
    RAISE EXCEPTION USING ERRCODE = 'T4236';
  EXCEPTION WHEN SQLSTATE 'T4236' THEN NULL; WHEN OTHERS THEN r := r || jsonb_build_object('A1_crash', 'ERR ' || SQLSTATE || ' ' || SQLERRM);
  END;

  BEGIN
    acc := '';
    FOREACH t IN ARRAY AUTH_FNS || SVC_FNS || NONE_FNS LOOP
      ok := has_function_privilege('public', t, 'EXECUTE') = false
        AND has_function_privilege('anon', t, 'EXECUTE') = false
        AND has_function_privilege('authenticated', t, 'EXECUTE') = (t = ANY (AUTH_FNS))
        AND has_function_privilege('service_role', t, 'EXECUTE') = (t = ANY (SVC_FNS));
      IF NOT ok THEN acc := acc || ' ' || t; END IF;
    END LOOP;
    SELECT count(*) INTO n FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace
       AND (p.proname ~ '^_?cloud_' OR p.proname IN ('assign_member_addon', 'get_my_cloud_autosave_state', 'set_my_cloud_autosave'))
       AND NOT (p.oid = ANY (SELECT fsig::regprocedure FROM unnest(AUTH_FNS || SVC_FNS || NONE_FNS) fsig));
    r := r || jsonb_build_object('A2_function_privileges', pg_temp.pass(acc = '' AND n = 0, acc || ' unlisted=' || n));
    -- what the default would be (positive control for the REVOKE mutants)
    CREATE FUNCTION public.p4236_probe_fn() RETURNS int LANGUAGE sql AS 'SELECT 1';
    r := r || jsonb_build_object('A2_default_is_open', pg_temp.pass(
      has_function_privilege('anon', 'public.p4236_probe_fn()', 'EXECUTE') AND has_function_privilege('authenticated', 'public.p4236_probe_fn()', 'EXECUTE'), 'default closed'));
    RAISE EXCEPTION USING ERRCODE = 'T4236';
  EXCEPTION WHEN SQLSTATE 'T4236' THEN NULL; WHEN OTHERS THEN r := r || jsonb_build_object('A2_crash', 'ERR ' || SQLSTATE || ' ' || SQLERRM);
  END;

  BEGIN
    -- sequences owned by these tables (pg_depend); positive control: an identity column is found
    SELECT count(*) INTO n FROM pg_class sq JOIN pg_depend dp ON dp.objid = sq.oid AND dp.classid = 'pg_class'::regclass
      JOIN pg_class tb ON tb.oid = dp.refobjid
     WHERE sq.relkind = 'S' AND tb.relname = ANY (TABLES) AND tb.relnamespace = 'public'::regnamespace;
    SELECT count(*) INTO n2 FROM pg_type ty WHERE ty.typnamespace = 'public'::regnamespace AND ty.typname ~ '^_?cloud_' AND ty.typtype IN ('e', 'd', 'c')
       AND NOT EXISTS (SELECT 1 FROM pg_class c WHERE c.reltype = ty.oid);
    CREATE TABLE public.p4236_probe_seq (id bigint GENERATED ALWAYS AS IDENTITY);
    r := r || jsonb_build_object('A3_no_sequences_or_types', pg_temp.pass(n = 0 AND n2 = 0
      AND (SELECT count(*) FROM pg_class sq JOIN pg_depend dp ON dp.objid = sq.oid AND dp.classid = 'pg_class'::regclass
             WHERE sq.relkind = 'S' AND dp.refobjid = 'public.p4236_probe_seq'::regclass) = 1,
      'sequences=' || n || ' types=' || n2));
    RAISE EXCEPTION USING ERRCODE = 'T4236';
  EXCEPTION WHEN SQLSTATE 'T4236' THEN NULL; WHEN OTHERS THEN r := r || jsonb_build_object('A3_crash', 'ERR ' || SQLSTATE || ' ' || SQLERRM);
  END;

  BEGIN
    acc := '';
    FOREACH t IN ARRAY TABLES LOOP
      IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = ('public.' || t)::regclass) THEN acc := acc || ' norls:' || t; END IF;
      IF (SELECT count(*) FROM pg_policies p WHERE p.schemaname = 'public' AND p.tablename = t) <> 1
         OR (SELECT bool_or(p.cmd <> 'SELECT' OR p.roles <> '{authenticated}'::name[] OR p.permissive <> 'PERMISSIVE') FROM pg_policies p WHERE p.schemaname = 'public' AND p.tablename = t) THEN
        acc := acc || ' policies:' || t;
      END IF;
    END LOOP;
    SELECT string_agg(p.policyname, ',') INTO t2 FROM pg_policies p
     WHERE p.schemaname = 'storage' AND p.tablename = 'objects' AND coalesce(p.qual, '') || coalesce(p.with_check, '') NOT LIKE '%bucket_id = %';
    SELECT string_agg(p.cmd, ',' ORDER BY p.cmd) INTO t3 FROM pg_policies p
     WHERE p.schemaname = 'storage' AND p.tablename = 'objects' AND coalesce(p.qual, '') || coalesce(p.with_check, '') LIKE '%cloud-deal-files%';
    SELECT count(*) INTO n FROM pg_publication_tables pt WHERE pt.schemaname = 'public' AND pt.tablename = ANY (TABLES);
    r := r || jsonb_build_object('A4_policies_and_publication', pg_temp.pass(
      acc = '' AND t2 IS NULL AND t3 = 'INSERT,SELECT' AND n = 0
      AND (SELECT NOT public AND file_size_limit = 52428800 FROM storage.buckets WHERE id = 'cloud-deal-files'),
      acc || ' unscoped=' || coalesce(t2, '-') || ' bucket_cmds=' || coalesce(t3, '-') || ' realtime=' || n));
    RAISE EXCEPTION USING ERRCODE = 'T4236';
  EXCEPTION WHEN SQLSTATE 'T4236' THEN NULL; WHEN OTHERS THEN r := r || jsonb_build_object('A4_crash', 'ERR ' || SQLSTATE || ' ' || SQLERRM);
  END;

  BEGIN
    r := r || jsonb_build_object('F1_feature_keys', pg_temp.pass(
      (SELECT count(*) FROM public.feature_definitions WHERE key IN ('cloud_autosave', 'cloud_autosave_assignable')
          AND default_value = 'false' AND min_tier IS NULL AND NOT is_built AND value_type = 'boolean') = 2
      AND (SELECT count(*) FROM public.plan_features pf JOIN public.feature_definitions fd ON fd.id = pf.feature_id
            WHERE fd.key IN ('cloud_autosave', 'cloud_autosave_assignable')) = 2 * (SELECT count(*) FROM public.plans)
      AND NOT EXISTS (SELECT 1 FROM public.plan_features pf JOIN public.feature_definitions fd ON fd.id = pf.feature_id
            WHERE fd.key IN ('cloud_autosave', 'cloud_autosave_assignable') AND (pf.enabled OR pf.value IS DISTINCT FROM 'false'))
      AND (SELECT count(*) FROM public.plans) > 0, 'keys'));
    RAISE EXCEPTION USING ERRCODE = 'T4236';
  EXCEPTION WHEN SQLSTATE 'T4236' THEN NULL; WHEN OTHERS THEN r := r || jsonb_build_object('F1_crash', 'ERR ' || SQLSTATE || ' ' || SQLERRM);
  END;

  -- ===================================================================== reads
  BEGIN
    acc := '';
    FOREACH t IN ARRAY TABLES LOOP
      t2 := CASE WHEN t IN ('cloud_autosave_settings', 'member_addons') THEN 'user_id' ELSE 'owner_user_id' END;
      n := pg_temp.j(pg_temp.call_as(A, format('SELECT to_jsonb(count(*)) FROM public.%I WHERE %I = %L', t, t2, A)))::text::bigint;
      IF n IS DISTINCT FROM 1::bigint THEN acc := acc || ' A_own:' || t || '=' || coalesce(n::text, 'null'); END IF;
      FOREACH u IN ARRAY ARRAY[B, AD, IR, X, J, S] LOOP
        n := pg_temp.j(pg_temp.call_as(u, format('SELECT to_jsonb(count(*)) FROM public.%I WHERE %I = %L', t, t2, A)))::text::bigint;
        IF n IS DISTINCT FROM 0::bigint THEN acc := acc || ' other_user_row:' || t || ':' || u::text; END IF;
      END LOOP;
    END LOOP;
    FOREACH u IN ARRAY ARRAY[B, AD, IR, X] LOOP
      IF pg_temp.call_as(u, 'SELECT to_jsonb(count(*)) FROM storage.objects WHERE bucket_id = ''cloud-deal-files''') <> '0' THEN acc := acc || ' obj:' || u::text; END IF;
    END LOOP;
    r := r || jsonb_build_object('R1_owner_only_reads', pg_temp.pass(acc = ''
      AND pg_temp.call_as(B, format('SELECT to_jsonb(count(*)) FROM public.organization_members WHERE user_id = %L', A)) = '1'
      AND pg_temp.call_as(A, 'SELECT to_jsonb(count(*)) FROM storage.objects WHERE bucket_id = ''cloud-deal-files''') = '1'
      AND pg_temp.call_as(NULL, 'SELECT to_jsonb(count(*)) FROM public.cloud_deals', 'anon') LIKE 'ERR 42501%', acc));
    RAISE EXCEPTION USING ERRCODE = 'T4236';
  EXCEPTION WHEN SQLSTATE 'T4236' THEN NULL; WHEN OTHERS THEN r := r || jsonb_build_object('R1_crash', 'ERR ' || SQLSTATE || ' ' || SQLERRM);
  END;

  -- ===================================================================== direct writes
  BEGIN
    acc := '';
    FOREACH t IN ARRAY TABLES LOOP
      t2 := CASE WHEN t IN ('cloud_autosave_settings', 'member_addons') THEN 'user_id' ELSE 'owner_user_id' END;
      t3 := pg_temp.call_as(A, format('UPDATE public.%I SET %I = %I WHERE %I = %L', t, t2, t2, t2, A));
      IF t3 NOT LIKE 'ERR 42501%' THEN acc := acc || ' upd:' || t || '=' || t3; END IF;
      t3 := pg_temp.call_as(A, format('DELETE FROM public.%I WHERE %I = %L', t, t2, A));
      IF t3 NOT LIKE 'ERR 42501%' THEN acc := acc || ' del:' || t || '=' || t3; END IF;
    END LOOP;
    t3 := pg_temp.call_as(A, format('INSERT INTO public.cloud_deals (owner_user_id, source_install_id, local_transaction_id, content_hash) VALUES (%L, %L, %L, %L)', A, I1, 'w-1', pg_temp.h('w')));
    IF t3 NOT LIKE 'ERR 42501%' THEN acc := acc || ' ins:deals=' || t3; END IF;
    t3 := pg_temp.call_as(AD, format('INSERT INTO public.member_addons (membership_id, organization_id, user_id, addon_key, source) VALUES (%L, %L, %L, %L, %L)', pg_temp.fx(205), O, J, 'cloud_autosave', 'admin'));
    IF t3 NOT LIKE 'ERR 42501%' THEN acc := acc || ' ins:addons=' || t3; END IF;
    r := r || jsonb_build_object('W1_no_direct_writes', pg_temp.pass(acc = ''
      AND pg_temp.st(pg_temp.deal(A, jsonb_build_object('source_install_id', I1, 'local_id', 'w-1', 'content_hash', pg_temp.h('w')))) = 'applied', acc));
    RAISE EXCEPTION USING ERRCODE = 'T4236';
  EXCEPTION WHEN SQLSTATE 'T4236' THEN NULL; WHEN OTHERS THEN r := r || jsonb_build_object('W1_crash', 'ERR ' || SQLSTATE || ' ' || SQLERRM);
  END;

  -- ===================================================================== entitlement
  BEGIN
    js := pg_temp.state(A); js2 := pg_temp.state(S);
    r := r || jsonb_build_object('E0_licensed_paths', pg_temp.pass(
      js ->> 'path' = 'brokerage' AND (js ->> 'organization_id')::uuid = O AND (js ->> 'entitled')::boolean
      AND js2 ->> 'path' = 'solo' AND (js2 ->> 'organization_id')::uuid = PS AND (js2 ->> 'entitled')::boolean, js::text || js2::text));
    -- J: personal org with the key on but no membership in it; active agent in O with no assignment
    r := r || jsonb_build_object('E1_personal_org_without_membership', pg_temp.pass(
      pg_temp.state(J) ->> 'reason' = 'no_license' AND pg_temp.err(pg_temp.onoff(J, true)) = 'not_licensed',
      pg_temp.state(J)::text));
    RAISE EXCEPTION USING ERRCODE = 'T4236';
  EXCEPTION WHEN SQLSTATE 'T4236' THEN NULL; WHEN OTHERS THEN r := r || jsonb_build_object('E0_crash', 'ERR ' || SQLSTATE || ' ' || SQLERRM);
  END;

  BEGIN
    UPDATE public.organization_plans SET feature_overrides = jsonb_build_object('cloud_autosave', jsonb_build_object('enabled', true,
           'paid_through', to_char(now() + interval '1 day', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'))) WHERE organization_id = PS;
    t := pg_temp.state(S) ->> 'path';
    UPDATE public.organization_plans SET feature_overrides = jsonb_build_object('cloud_autosave', jsonb_build_object('enabled', true,
           'paid_through', to_char(now() - interval '1 day', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'))) WHERE organization_id = PS;
    r := r || jsonb_build_object('E2_solo_paid_through', pg_temp.pass(t = 'solo' AND pg_temp.state(S) ->> 'reason' = 'no_license', t));
    RAISE EXCEPTION USING ERRCODE = 'T4236';
  EXCEPTION WHEN SQLSTATE 'T4236' THEN NULL; WHEN OTHERS THEN r := r || jsonb_build_object('E2_crash', 'ERR ' || SQLSTATE || ' ' || SQLERRM);
  END;

  BEGIN
    SET LOCAL session_replication_role = replica;
    INSERT INTO public.org_deals (organization_id, stripe_mode, term, seats, start_date, status, suspended_reason, entitlement_prior, version)
    VALUES (PS, 'test', 'month', 1, current_date, 'suspended', 'non_payment', '{}'::jsonb, 1);
    SET LOCAL session_replication_role = origin;
    r := r || jsonb_build_object('E2_solo_billing_off', pg_temp.pass(pg_temp.state(S) ->> 'licensed' = 'false', pg_temp.state(S)::text));
    RAISE EXCEPTION USING ERRCODE = 'T4236';
  EXCEPTION WHEN SQLSTATE 'T4236' THEN NULL; WHEN OTHERS THEN r := r || jsonb_build_object('E2b_crash', 'ERR ' || SQLSTATE || ' ' || SQLERRM);
  END;

  BEGIN
    -- internal helpers refuse a caller asking about someone else (reachable only from definer code)
    PERFORM set_config('request.jwt.claims', json_build_object('sub', S, 'role', 'authenticated')::text, true);
    PERFORM set_config('request.jwt.claim.sub', S::text, true);
    PERFORM set_config('request.jwt.claim.role', 'authenticated', true);
    BEGIN PERFORM * FROM public._cloud_autosave_license(A); t := 'ran'; EXCEPTION WHEN OTHERS THEN t := 'ERR ' || SQLSTATE; END;
    BEGIN PERFORM public._cloud_fence_unreferenced(A, ARRAY[BL]); t2 := 'ran'; EXCEPTION WHEN OTHERS THEN t2 := 'ERR ' || SQLSTATE; END;
    PERFORM pg_temp.clear_claims();
    t3 := (SELECT public.assign_member_addon(O, J, 'cloud_autosave', true, NULL)) ->> 'error';
    r := r || jsonb_build_object('E7_internal_caller_checks', pg_temp.pass(t = 'ERR 42501' AND t2 = 'ERR 42501' AND t3 = 'not_authorized'
      AND (SELECT purge_requested_at IS NULL FROM public.cloud_blobs WHERE id = BL), t || ' ' || t2 || ' ' || coalesce(t3, '-')));
    RAISE EXCEPTION USING ERRCODE = 'T4236';
  EXCEPTION WHEN SQLSTATE 'T4236' THEN NULL; WHEN OTHERS THEN PERFORM pg_temp.clear_claims(); r := r || jsonb_build_object('E7_crash', 'ERR ' || SQLSTATE || ' ' || SQLERRM);
  END;

  -- brokerage: each term alone
  BEGIN
    PERFORM pg_temp.assign(O, A, false);
    r := r || jsonb_build_object('E3_revoked', pg_temp.pass(pg_temp.state(A) ->> 'reason' = 'assignment_lapsed', pg_temp.state(A)::text));
    RAISE EXCEPTION USING ERRCODE = 'T4236';
  EXCEPTION WHEN SQLSTATE 'T4236' THEN NULL; WHEN OTHERS THEN r := r || jsonb_build_object('E3_revoked_crash', 'ERR ' || SQLSTATE || ' ' || SQLERRM);
  END;
  BEGIN
    PERFORM pg_temp.assign(O, A, true, now() + interval '1 hour');
    t := pg_temp.state(A) ->> 'path';
    PERFORM pg_temp.assign(O, A, true, now() - interval '1 second');
    r := r || jsonb_build_object('E3_ends_at', pg_temp.pass(t = 'brokerage' AND pg_temp.state(A) ->> 'reason' = 'assignment_lapsed', t || ' ' || pg_temp.state(A)::text));
    RAISE EXCEPTION USING ERRCODE = 'T4236';
  EXCEPTION WHEN SQLSTATE 'T4236' THEN NULL; WHEN OTHERS THEN r := r || jsonb_build_object('E3_ends_at_crash', 'ERR ' || SQLSTATE || ' ' || SQLERRM);
  END;
  BEGIN
    SET LOCAL session_replication_role = replica;
    UPDATE public.organization_members SET license_status = 'suspended' WHERE id = pg_temp.fx(201);
    SET LOCAL session_replication_role = origin;
    r := r || jsonb_build_object('E3_member_inactive', pg_temp.pass(pg_temp.state(A) ->> 'reason' = 'member_inactive', pg_temp.state(A)::text));
    RAISE EXCEPTION USING ERRCODE = 'T4236';
  EXCEPTION WHEN SQLSTATE 'T4236' THEN NULL; WHEN OTHERS THEN r := r || jsonb_build_object('E3_member_inactive_crash', 'ERR ' || SQLSTATE || ' ' || SQLERRM);
  END;
  BEGIN
    SET LOCAL session_replication_role = replica;
    INSERT INTO public.org_deals (organization_id, stripe_mode, term, seats, start_date, status, suspended_reason, entitlement_prior, version)
    VALUES (O, 'test', 'month', 1, current_date, 'suspended', 'non_payment', '{}'::jsonb, 1);
    SET LOCAL session_replication_role = origin;
    r := r || jsonb_build_object('E3_billing_off', pg_temp.pass(pg_temp.state(A) ->> 'reason' = 'billing_off'
      AND pg_temp.call_as(A, format('SELECT to_jsonb(public.org_billing_service_off(%L))', O)) = 'true', pg_temp.state(A)::text));
    RAISE EXCEPTION USING ERRCODE = 'T4236';
  EXCEPTION WHEN SQLSTATE 'T4236' THEN NULL; WHEN OTHERS THEN r := r || jsonb_build_object('E3_billing_off_crash', 'ERR ' || SQLSTATE || ' ' || SQLERRM);
  END;
  BEGIN
    UPDATE public.organization_plans SET feature_overrides = '{}' WHERE organization_id = O;
    r := r || jsonb_build_object('E3_plan_disallows', pg_temp.pass(pg_temp.state(A) ->> 'reason' = 'plan_disallows', pg_temp.state(A)::text));
    RAISE EXCEPTION USING ERRCODE = 'T4236';
  EXCEPTION WHEN SQLSTATE 'T4236' THEN NULL; WHEN OTHERS THEN r := r || jsonb_build_object('E3_plan_disallows_crash', 'ERR ' || SQLSTATE || ' ' || SQLERRM);
  END;
  BEGIN
    -- an assignment row in a personal organization (written directly) never licenses; S'acc solo key off
    UPDATE public.organization_plans SET feature_overrides = '{"cloud_autosave_assignable":{"enabled":true}}' WHERE organization_id = PS;
    INSERT INTO public.member_addons (membership_id, organization_id, user_id, addon_key, source)
    VALUES (pg_temp.fx(204), PS, S, 'cloud_autosave', 'staff');
    r := r || jsonb_build_object('E3_personal_assignment', pg_temp.pass(pg_temp.state(S) ->> 'licensed' = 'false', pg_temp.state(S)::text));
    RAISE EXCEPTION USING ERRCODE = 'T4236';
  EXCEPTION WHEN SQLSTATE 'T4236' THEN NULL; WHEN OTHERS THEN r := r || jsonb_build_object('E3_personal_assignment_crash', 'ERR ' || SQLSTATE || ' ' || SQLERRM);
  END;
  BEGIN
    -- the assignment'acc membership_id names B'acc (active) membership while A'acc own is suspended
    SET LOCAL session_replication_role = replica;
    UPDATE public.organization_members SET license_status = 'suspended' WHERE id = pg_temp.fx(201);
    SET LOCAL session_replication_role = origin;
    UPDATE public.member_addons SET membership_id = pg_temp.fx(202) WHERE user_id = A;
    r := r || jsonb_build_object('E3_membership_join', pg_temp.pass(pg_temp.state(A) ->> 'licensed' = 'false', pg_temp.state(A)::text));
    RAISE EXCEPTION USING ERRCODE = 'T4236';
  EXCEPTION WHEN SQLSTATE 'T4236' THEN NULL; WHEN OTHERS THEN r := r || jsonb_build_object('E3_membership_join_crash', 'ERR ' || SQLSTATE || ' ' || SQLERRM);
  END;
  BEGIN
    -- live-only reasons: a revoked row in O2 next to a live row in O whose billing is off
    SET LOCAL session_replication_role = replica;
    INSERT INTO public.organization_members (id, organization_id, user_id, role, license_status) VALUES (pg_temp.fx(206), O2, A, 'agent', 'active');
    INSERT INTO public.org_deals (organization_id, stripe_mode, term, seats, start_date, status, suspended_reason, entitlement_prior, version)
    VALUES (O, 'test', 'month', 1, current_date, 'suspended', 'non_payment', '{}'::jsonb, 1);
    SET LOCAL session_replication_role = origin;
    UPDATE public.organization_plans SET feature_overrides = '{"cloud_autosave_assignable":{"enabled":true}}' WHERE organization_id = O2;
    PERFORM pg_temp.assign(O2, A, true);
    PERFORM pg_temp.assign(O2, A, false);
    r := r || jsonb_build_object('E4_reason_live_rows_only', pg_temp.pass(pg_temp.state(A) ->> 'reason' = 'billing_off', pg_temp.state(A)::text));
    RAISE EXCEPTION USING ERRCODE = 'T4236';
  EXCEPTION WHEN SQLSTATE 'T4236' THEN NULL; WHEN OTHERS THEN r := r || jsonb_build_object('E4_crash', 'ERR ' || SQLSTATE || ' ' || SQLERRM);
  END;
  BEGIN
    -- two live assignments; the one inserted second is older and must win
    SET LOCAL session_replication_role = replica;
    INSERT INTO public.organization_members (id, organization_id, user_id, role, license_status) VALUES (pg_temp.fx(206), O2, A, 'agent', 'active');
    SET LOCAL session_replication_role = origin;
    UPDATE public.organization_plans SET feature_overrides = '{"cloud_autosave_assignable":{"enabled":true}}' WHERE organization_id = O2;
    PERFORM pg_temp.assign(O2, A, true);
    -- in each case the row updated last (physically last) is the one that must win
    UPDATE public.member_addons SET assigned_at = now() - interval '1 day' WHERE organization_id = O2 AND user_id = A;
    UPDATE public.member_addons SET assigned_at = now() - interval '2 days' WHERE organization_id = O AND user_id = A;
    t := pg_temp.state(A) ->> 'organization_id';
    UPDATE public.member_addons SET assigned_at = now() - interval '3 days' WHERE organization_id = O AND user_id = A;
    UPDATE public.member_addons SET assigned_at = now() - interval '4 days' WHERE organization_id = O2 AND user_id = A;
    t2 := pg_temp.state(A) ->> 'organization_id';
    r := r || jsonb_build_object('E5_assignment_order', pg_temp.pass(t::uuid = O AND t2::uuid = O2, coalesce(t, '-') || ' ' || coalesce(t2, '-')));
    RAISE EXCEPTION USING ERRCODE = 'T4236';
  EXCEPTION WHEN SQLSTATE 'T4236' THEN NULL; WHEN OTHERS THEN r := r || jsonb_build_object('E5_crash', 'ERR ' || SQLSTATE || ' ' || SQLERRM);
  END;

  BEGIN
    -- entitled() equals licensed AND enabled AND notice current, over all users
    UPDATE public.cloud_autosave_settings SET notice_version = 0 WHERE user_id = S;
    acc := ''; n := 0; n2 := 0;
    FOREACH u IN ARRAY ARRAY[A, B, AD, S, J, X, IR] LOOP
      js := pg_temp.state(u);
      t := pg_temp.call_as(u, 'SELECT to_jsonb(public.cloud_autosave_entitled())');
      ok := (js ->> 'licensed')::boolean AND (js -> 'settings' ->> 'enabled')::boolean AND (js -> 'settings' ->> 'notice_version') = '1';
      IF t <> ok::text OR (js ->> 'entitled') <> ok::text THEN acc := acc || ' ' || u::text || ':' || t; END IF;
      IF ok THEN n := n + 1; ELSE n2 := n2 + 1; END IF;
    END LOOP;
    r := r || jsonb_build_object('E6_entitled_matches_state', pg_temp.pass(acc = '' AND n >= 1 AND n2 >= 1, acc || ' true=' || n || ' false=' || n2));
    RAISE EXCEPTION USING ERRCODE = 'T4236';
  EXCEPTION WHEN SQLSTATE 'T4236' THEN NULL; WHEN OTHERS THEN r := r || jsonb_build_object('E6_crash', 'ERR ' || SQLSTATE || ' ' || SQLERRM);
  END;

  -- ===================================================================== state shape
  BEGIN
    js := pg_temp.state(A);
    t := (SELECT string_agg(k, ',' ORDER BY k) FROM jsonb_object_keys(js) k);
    t2 := (SELECT string_agg(k, ',' ORDER BY k) FROM jsonb_object_keys(js -> 'settings') k) || '|' || (SELECT string_agg(k, ',' ORDER BY k) FROM jsonb_object_keys(js -> 'storage') k);
    UPDATE public.cloud_autosave_settings SET enabled = false WHERE user_id = S;
    t3 := pg_temp.state(S) ->> 'reason';
    UPDATE public.cloud_autosave_settings SET enabled = true, notice_version = 0 WHERE user_id = S;
    r := r || jsonb_build_object('ST1_shape_and_reasons', pg_temp.pass(
      t = 'current_notice_version,entitled,licensed,organization_id,path,reason,schema_version,settings,storage,user_id'
      AND t2 = 'accepted_at,enabled,notice_version|quota_bytes,used_bytes'
      AND js ->> 'schema_version' = '1' AND js -> 'reason' = 'null'::jsonb AND (js -> 'storage' ->> 'used_bytes')::bigint = 10
      AND js -> 'storage' -> 'quota_bytes' = 'null'::jsonb AND js ->> 'current_notice_version' = '1'
      AND t3 = 'not_enabled' AND pg_temp.state(S) ->> 'reason' = 'notice_outdated' AND pg_temp.state(X) ->> 'reason' = 'no_license'
      AND pg_temp.call_as(NULL, 'SELECT public.get_my_cloud_autosave_state()', 'anon') LIKE 'ERR 42501%'
      AND pg_temp.call_as(NULL, 'SELECT public.get_my_cloud_autosave_state()', 'authenticated') LIKE 'ERR 42501%',
      t || ' / ' || t2 || ' / ' || coalesce(t3, '-')));
    RAISE EXCEPTION USING ERRCODE = 'T4236';
  EXCEPTION WHEN SQLSTATE 'T4236' THEN NULL; WHEN OTHERS THEN r := r || jsonb_build_object('ST1_crash', 'ERR ' || SQLSTATE || ' ' || SQLERRM);
  END;

  BEGIN
    -- read-only block shape: a NOLOGIN, non-BYPASSRLS member of authenticated owns a STABLE reader
    t3 := 'p4236_rd_' || substr(md5('__RUN__'), 1, 10);
    EXECUTE format('CREATE ROLE %I NOLOGIN NOBYPASSRLS', t3);
    EXECUTE format('GRANT %I TO %I WITH SET TRUE', t3, current_user);
    EXECUTE format('GRANT authenticated TO %I', t3);
    EXECUTE format('GRANT CREATE ON SCHEMA public TO %I', t3);
    CREATE FUNCTION public.p4236_r(p_case text) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $f$
    BEGIN
      IF p_case = 'state' THEN RETURN public.get_my_cloud_autosave_state(); END IF;
      IF p_case = 'installs' THEN RETURN public.cloud_list_installs(); END IF;
      RETURN to_jsonb((SELECT count(*) FROM public.cloud_deals));
    END $f$;
    EXECUTE format('ALTER FUNCTION public.p4236_r(text) OWNER TO %I', t3);
    EXECUTE format('REVOKE CREATE ON SCHEMA public FROM %I', t3);
    CREATE FUNCTION public.p4236_blk(p_case text, p_owner uuid) RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = '' AS $f$
    DECLARE v jsonb; o text := 'ok';
    BEGIN
      BEGIN
        PERFORM set_config('transaction_read_only', 'on', true);
        PERFORM set_config('request.jwt.claims', json_build_object('sub', p_owner, 'role', 'authenticated')::text, true);
        v := public.p4236_r(p_case);
        RAISE EXCEPTION USING ERRCODE = 'MC000';
      EXCEPTION WHEN SQLSTATE 'MC000' THEN NULL; WHEN OTHERS THEN o := 'error:' || SQLSTATE; v := NULL;
      END;
      RETURN jsonb_build_object('o', o, 'v', v);
    END $f$;
    js := public.p4236_blk('state', A);
    js2 := public.p4236_blk('installs', A);
    t := public.p4236_blk('rows', A)::text;
    r := r || jsonb_build_object('ST2_readonly_block', pg_temp.pass(
      js ->> 'o' = 'ok' AND js -> 'v' ->> 'entitled' = 'true' AND js2 ->> 'o' = 'ok'
      AND (js2 -> 'v' -> 'installs' -> 0 ->> 'deals')::int = 1 AND (pg_temp.j(t) -> 'v')::text = '1'
      AND (SELECT string_agg(p.provolatile::text, '' ORDER BY p.proname) FROM pg_proc p WHERE p.oid IN
           ('public.get_my_cloud_autosave_state()'::regprocedure, 'public.cloud_autosave_entitled()'::regprocedure,
            'public._cloud_autosave_license(uuid)'::regprocedure, 'public.cloud_list_installs()'::regprocedure)) = 'ssss',
      js::text || js2::text || t));
    RAISE EXCEPTION USING ERRCODE = 'T4236';
  EXCEPTION WHEN SQLSTATE 'T4236' THEN NULL; WHEN OTHERS THEN r := r || jsonb_build_object('ST2_crash', 'ERR ' || SQLSTATE || ' ' || SQLERRM);
  END;

  -- ===================================================================== on / off
  BEGIN
    t := pg_temp.onoff(X, true);
    t2 := pg_temp.onoff(A, true, 0);
    r := r || jsonb_build_object('SET1_enable_gates', pg_temp.pass(
      pg_temp.err(t) = 'not_licensed' AND pg_temp.err(t2) = 'notice_outdated'
      AND (SELECT enabled FROM public.cloud_autosave_settings WHERE user_id = X) = false
      AND (SELECT notice_version FROM public.cloud_autosave_settings WHERE user_id = A) = 1
      AND pg_temp.err(pg_temp.onoff(A, true)) = 'OK'
      AND pg_temp.err(pg_temp.onoff(A, NULL)) = 'invalid_input', t || t2));
    RAISE EXCEPTION USING ERRCODE = 'T4236';
  EXCEPTION WHEN SQLSTATE 'T4236' THEN NULL; WHEN OTHERS THEN r := r || jsonb_build_object('SET1_crash', 'ERR ' || SQLSTATE || ' ' || SQLERRM);
  END;

  BEGIN
    DROP FUNCTION IF EXISTS public._mcp_disconnect_all_for(uuid, text);
    PERFORM pg_temp.assign(O, A, false);
    t := pg_temp.onoff(A, false);
    r := r || jsonb_build_object('SET2_off_unlicensed_deletes_all', pg_temp.pass(
      pg_temp.err(t) = 'OK' AND (pg_temp.j(t) -> 'deleted' ->> 'deals')::int = 1 AND (pg_temp.j(t) -> 'deleted' ->> 'files')::int = 1
      AND (pg_temp.j(t) ->> 'blobs_fenced')::int = 1 AND pg_temp.j(t) -> 'ai_apps_disconnected' = 'null'::jsonb
      AND (SELECT count(*) FROM public.cloud_deals WHERE owner_user_id = A) + (SELECT count(*) FROM public.cloud_deal_messages WHERE owner_user_id = A)
        + (SELECT count(*) FROM public.cloud_deal_files WHERE owner_user_id = A) + (SELECT count(*) FROM public.cloud_deal_parties WHERE owner_user_id = A)
        + (SELECT count(*) FROM public.cloud_deal_checklists WHERE owner_user_id = A) + (SELECT count(*) FROM public.cloud_deal_checklist_items WHERE owner_user_id = A) = 0
      AND (SELECT purge_requested_at IS NOT NULL FROM public.cloud_blobs WHERE id = BL)
      AND pg_temp.call_as(A, 'SELECT to_jsonb(count(*)) FROM storage.objects WHERE bucket_id = ''cloud-deal-files''') = '0'
      AND (SELECT count(*) FROM public.cloud_deals WHERE owner_user_id = S) = 1, t));
    RAISE EXCEPTION USING ERRCODE = 'T4236';
  EXCEPTION WHEN SQLSTATE 'T4236' THEN NULL; WHEN OTHERS THEN r := r || jsonb_build_object('SET2_crash', 'ERR ' || SQLSTATE || ' ' || SQLERRM);
  END;

  BEGIN
    t := pg_temp.onoff(A, false);
    t2 := pg_temp.deal(A, jsonb_build_object('source_install_id', I1, 'local_id', 't-9', 'content_hash', pg_temp.h('t-9')));
    r := r || jsonb_build_object('SET3_off_then_upsert', pg_temp.pass(pg_temp.err(t) = 'OK' AND pg_temp.err(t2) = 'not_entitled'
      AND (SELECT count(*) FROM public.cloud_deals WHERE owner_user_id = A) = 0, t2));
    RAISE EXCEPTION USING ERRCODE = 'T4236';
  EXCEPTION WHEN SQLSTATE 'T4236' THEN NULL; WHEN OTHERS THEN r := r || jsonb_build_object('SET3_crash', 'ERR ' || SQLSTATE || ' ' || SQLERRM);
  END;

  BEGIN
    -- a present disconnect function, revoked from every API role, is called once with (user, 'cloud_off')
    DROP FUNCTION IF EXISTS public._mcp_disconnect_all_for(uuid, text);
    CREATE TABLE public.p4236_disc (user_id uuid, event text CHECK (event IN ('disconnect_all', 'cloud_off')));
    CREATE FUNCTION public._mcp_disconnect_all_for(p_user_id uuid, p_event text) RETURNS integer
      LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = '' AS $f$
      BEGIN INSERT INTO public.p4236_disc VALUES (p_user_id, p_event); RETURN 2; END $f$;
    REVOKE ALL ON FUNCTION public._mcp_disconnect_all_for(uuid, text) FROM PUBLIC, anon, authenticated, service_role;
    t := pg_temp.onoff(A, false);
    r := r || jsonb_build_object('MCP1_disconnect_called', pg_temp.pass(pg_temp.err(t) = 'OK'
      AND (pg_temp.j(t) ->> 'ai_apps_disconnected')::int = 2
      AND (SELECT count(*) FROM public.p4236_disc WHERE user_id = A AND event = 'cloud_off') = 1
      AND (SELECT count(*) FROM public.p4236_disc) = 1, t));
    RAISE EXCEPTION USING ERRCODE = 'T4236';
  EXCEPTION WHEN SQLSTATE 'T4236' THEN NULL; WHEN OTHERS THEN r := r || jsonb_build_object('MCP1_called_crash', 'ERR ' || SQLSTATE || ' ' || SQLERRM);
  END;

  BEGIN
    -- a disconnect that fails: the whole turn-off is refused and nothing changes
    DROP FUNCTION IF EXISTS public._mcp_disconnect_all_for(uuid, text);
    CREATE TABLE public.p4236_disc (user_id uuid, event text CHECK (event IN ('disconnect_all')));
    CREATE FUNCTION public._mcp_disconnect_all_for(p_user_id uuid, p_event text) RETURNS integer
      LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = '' AS $f$
      BEGIN INSERT INTO public.p4236_disc VALUES (p_user_id, p_event); RETURN 1; END $f$;
    REVOKE ALL ON FUNCTION public._mcp_disconnect_all_for(uuid, text) FROM PUBLIC, anon, authenticated, service_role;
    t := pg_temp.onoff(A, false);
    r := r || jsonb_build_object('MCP1_failing_disconnect_refuses', pg_temp.pass(pg_temp.err(t) = 'turn_off_failed'
      AND (SELECT count(*) FROM public.cloud_deals WHERE owner_user_id = A) = 1
      AND (SELECT count(*) FROM public.cloud_deal_files WHERE owner_user_id = A) = 1
      AND (SELECT purge_requested_at IS NULL FROM public.cloud_blobs WHERE id = BL)
      AND (SELECT enabled FROM public.cloud_autosave_settings WHERE user_id = A), t));
    RAISE EXCEPTION USING ERRCODE = 'T4236';
  EXCEPTION WHEN SQLSTATE 'T4236' THEN NULL; WHEN OTHERS THEN r := r || jsonb_build_object('MCP1_failing_crash', 'ERR ' || SQLSTATE || ' ' || SQLERRM);
  END;

  -- ===================================================================== entitlement on every write
  BEGIN
    -- A stays licensed, enabled and the owner of everything; only the notice makes A unentitled
    UPDATE public.cloud_autosave_settings SET notice_version = 0 WHERE user_id = A;
    acc := '';
    t := pg_temp.deal(A, jsonb_build_object('source_install_id', I1, 'local_id', 't-1', 'content_hash', pg_temp.h('x')));
    IF pg_temp.err(t) <> 'not_entitled' THEN acc := acc || ' deal=' || t; END IF;
    FOREACH fn IN ARRAY CHILD_FNS LOOP
      t := pg_temp.up(A, fn, I1, D1, jsonb_build_array(pg_temp.row_of(fn, 'e-1')));
      IF pg_temp.err(t) <> 'not_entitled' THEN acc := acc || ' ' || fn || '=' || t; END IF;
    END LOOP;
    t := pg_temp.call_as(A, format('SELECT public.cloud_register_blob(%L::uuid, %L, 5, NULL)', A, pg_temp.h('e-blob')));
    IF pg_temp.err(t) <> 'not_entitled' THEN acc := acc || ' register=' || t; END IF;
    t := pg_temp.call_as(A, format('SELECT public.cloud_mark_deal_synced(%L::uuid, %L::uuid, %L::uuid)', A, I1, D1));
    IF pg_temp.err(t) <> 'not_entitled' THEN acc := acc || ' mark=' || t; END IF;
    UPDATE public.cloud_autosave_settings SET notice_version = 1 WHERE user_id = A;
    -- positive: the same calls succeed once the notice is current
    t2 := pg_temp.st(pg_temp.deal(A, jsonb_build_object('source_install_id', I1, 'local_id', 't-1', 'content_hash', pg_temp.h('x'))));
    FOREACH fn IN ARRAY CHILD_FNS LOOP
      t2 := t2 || ',' || pg_temp.st(pg_temp.up(A, fn, I1, D1, jsonb_build_array(pg_temp.row_of(fn, 'e-1'))));
    END LOOP;
    t2 := t2 || ',' || pg_temp.err(pg_temp.call_as(A, format('SELECT public.cloud_register_blob(%L::uuid, %L, 5, NULL)', A, pg_temp.h('e-blob'))))
               || ',' || pg_temp.err(pg_temp.call_as(A, format('SELECT public.cloud_mark_deal_synced(%L::uuid, %L::uuid, %L::uuid)', A, I1, D1)));
    r := r || jsonb_build_object('U1_entitlement_every_write', pg_temp.pass(acc = '' AND t2 = 'applied,applied,applied,applied,applied,applied,OK,OK', acc || ' / ' || t2));
    RAISE EXCEPTION USING ERRCODE = 'T4236';
  EXCEPTION WHEN SQLSTATE 'T4236' THEN NULL; WHEN OTHERS THEN r := r || jsonb_build_object('U1_crash', 'ERR ' || SQLSTATE || ' ' || SQLERRM);
  END;

  -- ===================================================================== owner binding on every function that takes an id
  BEGIN
    acc := '';
    -- S is entitled and passes A'acc real install id and A'acc ids
    FOREACH fn IN ARRAY CHILD_FNS LOOP
      t := pg_temp.up(S, fn, I1, D1, jsonb_build_array(pg_temp.row_of(fn, 'o-1')));
      IF pg_temp.err(t) <> 'not_found' THEN acc := acc || ' ' || fn || '=' || t; END IF;
      t := pg_temp.up(S, fn, I1, D1, '[]'::jsonb);
      IF pg_temp.err(t) <> 'not_found' THEN acc := acc || ' ' || fn || '[]=' || t; END IF;
    END LOOP;
    t := pg_temp.call_as(S, format('SELECT public.cloud_mark_deal_synced(%L::uuid, %L::uuid, %L::uuid)', S, I1, D1));
    IF pg_temp.err(t) <> 'not_found' THEN acc := acc || ' mark=' || t; END IF;
    t := pg_temp.call_as(S, format('SELECT public.cloud_delete_deal(%L::uuid, %L::uuid)', S, D1));
    IF pg_temp.err(t) <> 'not_found' THEN acc := acc || ' delete=' || t; END IF;
    t := pg_temp.call_as(S, format('SELECT public.cloud_confirm_blob(%L::uuid, %L::uuid)', S, BL));
    IF pg_temp.err(t) <> 'not_found' THEN acc := acc || ' confirm=' || t; END IF;
    FOREACH t2 IN ARRAY ARRAY['party:' || P1, 'checklist:' || C1, 'checklist_item:' || IT1, 'message:' || M1, 'file:' || F1] LOOP
      t := pg_temp.tomb(S, I1, split_part(t2, ':', 1), ARRAY[split_part(t2, ':', 2)::uuid]);
      IF pg_temp.st(t) <> 'not_found' THEN acc := acc || ' tomb_' || t2 || '=' || t; END IF;
    END LOOP;
    -- S has its own live blob for A'acc file content: S'acc file row must not take A'acc blob
    PERFORM pg_temp.call_as(S, format('SELECT public.cloud_register_blob(%L::uuid, %L, 10, NULL)', S, pg_temp.h('blob-other')));
    t := pg_temp.up(S, 'cloud_upsert_files', I1, SD, jsonb_build_array(jsonb_build_object('local_id', 'sf-1', 'content_hash', pg_temp.h('sf'),
           'filename', 'acc.pdf', 'blob_sha256', pg_temp.h('blob-a'))));
    IF pg_temp.st(t) <> 'rejected:blob_unavailable' THEN acc := acc || ' file_blob=' || t; END IF;
    js := pg_temp.j(pg_temp.call_as(S, 'SELECT public.cloud_list_installs()'));
    t := pg_temp.call_as(S, format('SELECT public.cloud_delete_install(%L::uuid, %L::uuid)', S, I1));
    IF (SELECT count(*) FROM public.cloud_deals WHERE owner_user_id = A) <> 1 OR pg_temp.err(t) <> 'OK' THEN acc := acc || ' delete_install=' || t; END IF;
    r := r || jsonb_build_object('O1_owner_binding', pg_temp.pass(acc = ''
      AND jsonb_array_length(js -> 'installs') = 1 AND (js -> 'installs' -> 0 ->> 'deals')::int = 1
      AND (SELECT count(*) FROM public.cloud_deal_messages WHERE id = M1 AND removed_at IS NULL) = 1
      AND pg_temp.err(pg_temp.call_as(A, format('SELECT public.cloud_mark_deal_synced(%L::uuid, %L::uuid, %L::uuid)', A, I1, D1))) = 'OK', acc || ' ' || js::text));
    RAISE EXCEPTION USING ERRCODE = 'T4236';
  EXCEPTION WHEN SQLSTATE 'T4236' THEN NULL; WHEN OTHERS THEN r := r || jsonb_build_object('O1_crash', 'ERR ' || SQLSTATE || ' ' || SQLERRM);
  END;

  -- ===================================================================== install binding
  BEGIN
    acc := '';
    FOREACH fn IN ARRAY CHILD_FNS LOOP
      t := pg_temp.up(A, fn, I2, D1, jsonb_build_array(pg_temp.row_of(fn, 'i-1')));
      IF pg_temp.err(t) <> 'not_found' THEN acc := acc || ' ' || fn || '=' || t; END IF;
    END LOOP;
    t := pg_temp.call_as(A, format('SELECT public.cloud_mark_deal_synced(%L::uuid, %L::uuid, %L::uuid)', A, I2, D1));
    IF pg_temp.err(t) <> 'not_found' THEN acc := acc || ' mark=' || t; END IF;
    FOREACH t2 IN ARRAY ARRAY['party:' || P1, 'checklist:' || C1, 'checklist_item:' || IT1, 'message:' || M1, 'file:' || F1] LOOP
      t := pg_temp.tomb(A, I2, split_part(t2, ':', 1), ARRAY[split_part(t2, ':', 2)::uuid]);
      IF pg_temp.st(t) <> 'not_found' THEN acc := acc || ' tomb_' || t2 || '=' || t; END IF;
    END LOOP;
    t := pg_temp.call_as(A, format('SELECT public.cloud_delete_install(%L::uuid, %L::uuid)', A, I2));
    IF (SELECT count(*) FROM public.cloud_deals WHERE owner_user_id = A) <> 1 THEN acc := acc || ' delete_install=' || t; END IF;
    -- the same local id under a second install is a second deal
    t := pg_temp.deal(A, jsonb_build_object('source_install_id', I2, 'local_id', 't-1', 'content_hash', pg_temp.h('t-1')));
    r := r || jsonb_build_object('I1_install_binding', pg_temp.pass(acc = ''
      AND pg_temp.st(t) = 'applied' AND pg_temp.cid(t) IS DISTINCT FROM D1
      AND (SELECT count(*) FROM public.cloud_deals WHERE owner_user_id = A AND local_transaction_id = 't-1') = 2
      AND pg_temp.st(pg_temp.up(A, 'cloud_upsert_messages', I1, D1, jsonb_build_array(pg_temp.row_of('cloud_upsert_messages', 'i-1')))) = 'applied'
      AND pg_temp.err(pg_temp.call_as(A, format('SELECT public.cloud_delete_deal(%L::uuid, %L::uuid)', A, pg_temp.cid(t)))) = 'OK', acc || ' ' || t));
    RAISE EXCEPTION USING ERRCODE = 'T4236';
  EXCEPTION WHEN SQLSTATE 'T4236' THEN NULL; WHEN OTHERS THEN r := r || jsonb_build_object('I1_crash', 'ERR ' || SQLSTATE || ' ' || SQLERRM);
  END;

  BEGIN
    -- list and delete one install; a blob shared with another install stays live until its last reference goes
    t := pg_temp.deal(A, jsonb_build_object('source_install_id', I2, 'local_id', 't-2', 'content_hash', pg_temp.h('t-2')));
    u := pg_temp.cid(t);
    t2 := pg_temp.st(pg_temp.up(A, 'cloud_upsert_files', I2, u, jsonb_build_array(jsonb_build_object('local_id', 'f-2',
            'content_hash', pg_temp.h('f-2'), 'filename', 'b.pdf', 'blob_sha256', pg_temp.h('blob-a')))));
    js := pg_temp.j(pg_temp.call_as(A, 'SELECT public.cloud_list_installs()'));
    t3 := pg_temp.call_as(A, format('SELECT public.cloud_delete_install(%L::uuid, %L::uuid)', A, I1));
    ok := (SELECT purge_requested_at IS NULL FROM public.cloud_blobs WHERE id = BL);
    js2 := pg_temp.j(pg_temp.call_as(A, format('SELECT public.cloud_delete_install(%L::uuid, %L::uuid)', A, I2)));
    r := r || jsonb_build_object('I2_list_and_delete_install', pg_temp.pass(
      t2 = 'applied' AND jsonb_array_length(js -> 'installs') = 2
      AND (SELECT sum((e ->> 'deals')::int) FROM jsonb_array_elements(js -> 'installs') e) = 2
      AND pg_temp.err(t3) = 'OK' AND (pg_temp.j(t3) ->> 'deleted_deals')::int = 1 AND (pg_temp.j(t3) ->> 'blobs_fenced')::int = 0 AND ok
      AND (js2 ->> 'blobs_fenced')::int = 1 AND (SELECT purge_requested_at IS NOT NULL FROM public.cloud_blobs WHERE id = BL)
      AND (SELECT count(*) FROM public.cloud_deals WHERE owner_user_id = A) = 0
      AND (SELECT count(*) FROM public.cloud_deals WHERE owner_user_id = S) = 1
      AND pg_temp.err(pg_temp.call_as(A, format('SELECT public.cloud_delete_install(%L::uuid, NULL::uuid)', A))) = 'invalid_input',
      t2 || ' ' || js::text || ' ' || t3 || ' ' || js2::text));
    RAISE EXCEPTION USING ERRCODE = 'T4236';
  EXCEPTION WHEN SQLSTATE 'T4236' THEN NULL; WHEN OTHERS THEN r := r || jsonb_build_object('I2_crash', 'ERR ' || SQLSTATE || ' ' || SQLERRM);
  END;

  -- ===================================================================== upsert semantics
  BEGIN
    t := pg_temp.deal(A, jsonb_build_object('source_install_id', I1, 'local_id', 'u-1', 'content_hash', pg_temp.h('h1')));
    acc := pg_temp.st(t) || (pg_temp.j(t) -> 'results' -> 0 ->> 'version');
    t := pg_temp.deal(A, jsonb_build_object('source_install_id', I1, 'local_id', 'u-1', 'content_hash', pg_temp.h('h2'), 'base_version', 1));
    acc := acc || ',' || pg_temp.st(t) || (pg_temp.j(t) -> 'results' -> 0 ->> 'version');
    t := pg_temp.deal(A, jsonb_build_object('source_install_id', I1, 'local_id', 'u-1', 'content_hash', pg_temp.h('h2'), 'base_version', 1));
    acc := acc || ',' || pg_temp.st(t) || (pg_temp.j(t) -> 'results' -> 0 ->> 'version');
    t := pg_temp.deal(A, jsonb_build_object('source_install_id', I1, 'local_id', 'u-1', 'content_hash', pg_temp.h('h3'), 'base_version', 1));
    acc := acc || ',' || pg_temp.st(t) || (pg_temp.j(t) -> 'results' -> 0 ->> 'version');
    t := pg_temp.deal(A, jsonb_build_object('source_install_id', I1, 'local_id', 'u-1', 'content_hash', pg_temp.h('h3'), 'base_version', NULL));
    acc := acc || ',' || pg_temp.st(t) || (pg_temp.j(t) -> 'results' -> 0 ->> 'version');
    t := pg_temp.deal(A, jsonb_build_object('source_install_id', I1, 'local_id', 'u-1', 'content_hash', pg_temp.h('h4'),
           'id', gen_random_uuid(), 'owner_user_id', S, 'version', 99, 'origin', 'ai_app'));
    acc := acc || ',' || pg_temp.st(t) || (pg_temp.j(t) -> 'results' -> 0 ->> 'version');
    r := r || jsonb_build_object('U3_versions_and_ids', pg_temp.pass(
      acc = 'applied1,applied2,unchanged2,conflict2,applied3,applied4'
      AND (SELECT count(*) FROM public.cloud_deals WHERE local_transaction_id = 'u-1') = 1
      AND (SELECT owner_user_id = A AND origin = 'desktop' AND version = 4 FROM public.cloud_deals WHERE local_transaction_id = 'u-1'), acc));
    RAISE EXCEPTION USING ERRCODE = 'T4236';
  EXCEPTION WHEN SQLSTATE 'T4236' THEN NULL; WHEN OTHERS THEN r := r || jsonb_build_object('U3_crash', 'ERR ' || SQLSTATE || ' ' || SQLERRM);
  END;

  BEGIN
    acc := '';
    FOREACH fn IN ARRAY CHILD_FNS LOOP
      t := pg_temp.up(A, fn, I1, D1, jsonb_build_array(pg_temp.row_of(fn, 'v-1', 'a')));
      t2 := pg_temp.up(A, fn, I1, D1, jsonb_build_array(pg_temp.row_of(fn, 'v-1', 'b') || '{"base_version":1}'));
      t3 := pg_temp.up(A, fn, I1, D1, jsonb_build_array(pg_temp.row_of(fn, 'v-1', 'b') || '{"base_version":1}'));
      acc := acc || fn || ':' || pg_temp.st(t) || ',' || pg_temp.st(t2) || ',' || pg_temp.st(t3) || ','
             || pg_temp.st(pg_temp.up(A, fn, I1, D1, jsonb_build_array(pg_temp.row_of(fn, 'v-1', 'c') || '{"base_version":1}'))) || ' ';
    END LOOP;
    r := r || jsonb_build_object('U3_child_versions', pg_temp.pass(acc =
      'cloud_upsert_parties:applied,applied,unchanged,conflict cloud_upsert_checklists:applied,applied,unchanged,conflict '
      || 'cloud_upsert_checklist_items:applied,applied,unchanged,conflict cloud_upsert_messages:applied,applied,unchanged,conflict '
      || 'cloud_upsert_files:applied,applied,unchanged,conflict ', acc));
    RAISE EXCEPTION USING ERRCODE = 'T4236';
  EXCEPTION WHEN SQLSTATE 'T4236' THEN NULL; WHEN OTHERS THEN r := r || jsonb_build_object('U3_child_crash', 'ERR ' || SQLSTATE || ' ' || SQLERRM);
  END;

  BEGIN
    n := (SELECT version FROM public.cloud_deals WHERE id = D1);
    PERFORM pg_temp.up(A, 'cloud_upsert_messages', I1, D1, jsonb_build_array(pg_temp.row_of('cloud_upsert_messages', 'w-2')));
    t := pg_temp.deal(A, jsonb_build_object('source_install_id', I1, 'local_id', 't-1', 'content_hash', pg_temp.h('t-1b'), 'base_version', n));
    r := r || jsonb_build_object('U4_child_write_keeps_deal_version', pg_temp.pass(
      (SELECT version FROM public.cloud_deals WHERE id = D1) IN (n, n + 1) AND pg_temp.st(t) = 'applied', n || ' ' || t));
    RAISE EXCEPTION USING ERRCODE = 'T4236';
  EXCEPTION WHEN SQLSTATE 'T4236' THEN NULL; WHEN OTHERS THEN r := r || jsonb_build_object('U4_crash', 'ERR ' || SQLSTATE || ' ' || SQLERRM);
  END;

  BEGIN
    SET LOCAL session_replication_role = replica;
    INSERT INTO public.organization_members (id, organization_id, user_id, role, license_status) VALUES (pg_temp.fx(207), O2, A, 'agent', 'suspended');
    SET LOCAL session_replication_role = origin;
    t := pg_temp.deal(A, jsonb_build_object('source_install_id', I1, 'local_id', 'g-1', 'content_hash', pg_temp.h('g'), 'organization_id', PS));
    t2 := pg_temp.deal(A, jsonb_build_object('source_install_id', I1, 'local_id', 'g-1', 'content_hash', pg_temp.h('g'), 'organization_id', O2));
    t3 := pg_temp.deal(A, jsonb_build_object('source_install_id', I1, 'local_id', 'g-1', 'content_hash', pg_temp.h('g'), 'organization_id', gen_random_uuid()));
    r := r || jsonb_build_object('U5_deal_organization', pg_temp.pass(pg_temp.err(t) = 'invalid_organization' AND pg_temp.err(t2) = 'invalid_organization'
      AND pg_temp.err(t3) = 'invalid_organization'
      AND pg_temp.st(pg_temp.deal(A, jsonb_build_object('source_install_id', I1, 'local_id', 'g-1', 'content_hash', pg_temp.h('g'), 'organization_id', O))) = 'applied',
      t || t2 || t3));
    RAISE EXCEPTION USING ERRCODE = 'T4236';
  EXCEPTION WHEN SQLSTATE 'T4236' THEN NULL; WHEN OTHERS THEN r := r || jsonb_build_object('U5_crash', 'ERR ' || SQLSTATE || ' ' || SQLERRM);
  END;

  -- the S solo user is personal-organization only: its own personal org is refused too
  BEGIN
    t := pg_temp.deal(S, jsonb_build_object('source_install_id', I1, 'local_id', 'g-2', 'content_hash', pg_temp.h('g'), 'organization_id', PS));
    r := r || jsonb_build_object('U5_own_personal_org', pg_temp.pass(pg_temp.err(t) = 'invalid_organization', t));
    RAISE EXCEPTION USING ERRCODE = 'T4236';
  EXCEPTION WHEN SQLSTATE 'T4236' THEN NULL; WHEN OTHERS THEN r := r || jsonb_build_object('U5b_crash', 'ERR ' || SQLSTATE || ' ' || SQLERRM);
  END;

  -- ===================================================================== limits (every function, both sides of each boundary)
  BEGIN
    acc := '';
    FOREACH fn IN ARRAY CHILD_FNS LOOP
      t := pg_temp.up(A, fn, I1, D1, pg_temp.rows_of(fn, 501, 'k'));
      IF pg_temp.err(t) <> 'batch_too_large' THEN acc := acc || ' ' || fn || '501=' || left(t, 80); END IF;
      t := pg_temp.up(A, fn, I1, D1, pg_temp.rows_of(fn, 500, 'k'));
      IF pg_temp.err(t) <> 'OK' OR jsonb_array_length(pg_temp.j(t) -> 'results') <> 500 THEN acc := acc || ' ' || fn || '500=' || left(t, 80); END IF;
    END LOOP;
    r := r || jsonb_build_object('U6_row_cap', pg_temp.pass(acc = '', acc));
    RAISE EXCEPTION USING ERRCODE = 'T4236';
  EXCEPTION WHEN SQLSTATE 'T4236' THEN NULL; WHEN OTHERS THEN r := r || jsonb_build_object('U6_rows_crash', 'ERR ' || SQLSTATE || ' ' || SQLERRM);
  END;

  BEGIN
    acc := '';
    FOREACH fn IN ARRAY CHILD_FNS LOOP
      -- one row padded past 16,777,216 bytes of batch text
      t := pg_temp.up(A, fn, I1, D1, jsonb_build_array(pg_temp.row_of(fn, 'b-1') || jsonb_build_object('pad', repeat('x', 16777216))));
      IF pg_temp.err(t) <> 'batch_too_large' THEN acc := acc || ' ' || fn || '=' || left(t, 80); END IF;
      t := pg_temp.up(A, fn, I1, D1, jsonb_build_array(pg_temp.row_of(fn, 'b-1') || jsonb_build_object('pad', repeat('x', 16776000))));
      IF pg_temp.st(t) <> 'applied' THEN acc := acc || ' ' || fn || '_under=' || left(t, 80); END IF;
    END LOOP;
    t := pg_temp.deal(A, jsonb_build_object('source_install_id', I1, 'local_id', 'b-2', 'content_hash', pg_temp.h('b'), 'pad', repeat('x', 1048576)));
    IF pg_temp.err(t) <> 'batch_too_large' THEN acc := acc || ' deal=' || left(t, 80); END IF;
    t := pg_temp.deal(A, jsonb_build_object('source_install_id', I1, 'local_id', 'b-2', 'content_hash', pg_temp.h('b'), 'pad', repeat('x', 1048000)));
    IF pg_temp.st(t) <> 'applied' THEN acc := acc || ' deal_under=' || left(t, 80); END IF;
    r := r || jsonb_build_object('U6_byte_cap', pg_temp.pass(acc = '', acc));
    RAISE EXCEPTION USING ERRCODE = 'T4236';
  EXCEPTION WHEN SQLSTATE 'T4236' THEN NULL; WHEN OTHERS THEN r := r || jsonb_build_object('U6_bytes_crash', 'ERR ' || SQLSTATE || ' ' || SQLERRM);
  END;

  BEGIN
    t := pg_temp.up(A, 'cloud_upsert_messages', I1, D1, jsonb_build_array(
      pg_temp.row_of('cloud_upsert_messages', 'x-over') || jsonb_build_object('body_text', repeat('é', 1000001)),
      pg_temp.row_of('cloud_upsert_messages', 'x-at') || jsonb_build_object('body_text', repeat('é', 1000000))));
    r := r || jsonb_build_object('U9_body_cap', pg_temp.pass(pg_temp.st(t, 0) = 'applied' AND pg_temp.st(t, 1) = 'applied'
      AND (SELECT char_length(body_text) = 1000000 AND body_truncated FROM public.cloud_deal_messages WHERE cloud_deal_id = D1 AND local_message_id = 'x-over')
      AND (SELECT char_length(body_text) = 1000000 AND NOT body_truncated FROM public.cloud_deal_messages WHERE cloud_deal_id = D1 AND local_message_id = 'x-at'),
      left(t, 300)));
    RAISE EXCEPTION USING ERRCODE = 'T4236';
  EXCEPTION WHEN SQLSTATE 'T4236' THEN NULL; WHEN OTHERS THEN r := r || jsonb_build_object('U9_crash', 'ERR ' || SQLSTATE || ' ' || SQLERRM);
  END;

  BEGIN
    t := pg_temp.call_as(A, format('SELECT public.cloud_register_blob(%L::uuid, %L, 52428801, NULL)', A, pg_temp.h('big')));
    t2 := pg_temp.call_as(A, format('SELECT public.cloud_register_blob(%L::uuid, %L, 52428800, NULL)', A, pg_temp.h('big')));
    t3 := pg_temp.tomb(A, I1, 'message', (SELECT array_agg(gen_random_uuid()) FROM generate_series(1, 1001)));
    r := r || jsonb_build_object('B3_blob_and_tombstone_caps', pg_temp.pass(pg_temp.err(t) = 'too_large' AND pg_temp.err(t2) = 'OK'
      AND pg_temp.err(t3) = 'invalid_input'
      AND pg_temp.err(pg_temp.tomb(A, I1, 'message', (SELECT array_agg(gen_random_uuid()) FROM generate_series(1, 1000)))) = 'OK', t || t2 || t3));
    RAISE EXCEPTION USING ERRCODE = 'T4236';
  EXCEPTION WHEN SQLSTATE 'T4236' THEN NULL; WHEN OTHERS THEN r := r || jsonb_build_object('B3_crash', 'ERR ' || SQLSTATE || ' ' || SQLERRM);
  END;

  -- ===================================================================== bad values
  BEGIN
    acc := '';
    FOREACH t2 IN ARRAY ARRAY['started_at:"x"', 'detection_confidence:"high"', 'texts_outside_window_count:1.5', 'base_version:1.5',
                              'organization_id:"nope"', 'details:[1]', 'source_install_id:"nope"', 'local_id:7'] LOOP
      js := jsonb_build_object('source_install_id', I1, 'local_id', 'bv-1', 'content_hash', pg_temp.h('bv'))
            || jsonb_build_object(split_part(t2, ':', 1), split_part(t2, ':', 2)::jsonb);
      t := pg_temp.deal(A, js);
      IF pg_temp.err(t) <> 'invalid_input' OR pg_temp.j(t) -> 'detail' ->> 'field' <> split_part(t2, ':', 1) THEN acc := acc || ' ' || t2 || '=' || t; END IF;
    END LOOP;
    t := pg_temp.deal(A, jsonb_build_object('local_id', 'bv-1', 'content_hash', pg_temp.h('bv')));
    IF pg_temp.j(t) -> 'detail' ->> 'field' IS DISTINCT FROM 'source_install_id' THEN acc := acc || ' no_install=' || t; END IF;
    r := r || jsonb_build_object('U7_deal_values', pg_temp.pass(acc = '', acc));
    RAISE EXCEPTION USING ERRCODE = 'T4236';
  EXCEPTION WHEN SQLSTATE 'T4236' THEN NULL; WHEN OTHERS THEN r := r || jsonb_build_object('U7_deal_crash', 'ERR ' || SQLSTATE || ' ' || SQLERRM);
  END;

  BEGIN
    t := pg_temp.up(A, 'cloud_upsert_messages', I1, D1, jsonb_build_array(
      pg_temp.row_of('cloud_upsert_messages', 'p-date') || '{"sent_at":"x"}',
      pg_temp.row_of('cloud_upsert_messages', 'p-chan') || '{"channel":"fax"}',
      pg_temp.row_of('cloud_upsert_messages', 'p-num') || '{"link_confidence":"high"}',
      pg_temp.row_of('cloud_upsert_messages', 'p-orig') || '{"link_origin":"other"}',
      pg_temp.row_of('cloud_upsert_messages', 'p-thr') || '{"channel_kind":"text"}',
      pg_temp.row_of('cloud_upsert_messages', 'p-ok') || '{"sent_at":"2026-01-01T00:00:00.000Z"}'));
    t2 := pg_temp.up(A, 'cloud_upsert_parties', I1, D1, jsonb_build_array(
      pg_temp.row_of('cloud_upsert_parties', 'pp-1') || '{"is_primary":"yes"}',
      pg_temp.row_of('cloud_upsert_parties', 'pp-2') || '{"emails":{"a":1}}',
      pg_temp.row_of('cloud_upsert_parties', 'pp-3')));
    t3 := pg_temp.up(A, 'cloud_upsert_checklist_items', I1, D1, jsonb_build_array(
      pg_temp.row_of('cloud_upsert_checklist_items', 'pi-1') || '{"is_checked":1}',
      pg_temp.row_of('cloud_upsert_checklist_items', 'pi-2') || '{"local_checklist_id":"cl-none"}',
      pg_temp.row_of('cloud_upsert_checklist_items', 'pi-3') || '{"links":"x"}'));
    acc := pg_temp.up(A, 'cloud_upsert_files', I1, D1, jsonb_build_array(
      pg_temp.row_of('cloud_upsert_files', 'pf-1') || '{"not_saved_reason":"lost"}',
      pg_temp.row_of('cloud_upsert_files', 'pf-2') - 'filename',
      pg_temp.row_of('cloud_upsert_files', 'pf-3') || '{"message_channel_kind":"email","message_local_id":"m-none"}',
      pg_temp.row_of('cloud_upsert_files', 'pf-4') || jsonb_build_object('blob_sha256', pg_temp.h('no-blob')),
      pg_temp.row_of('cloud_upsert_files', 'pf-5') || '{"size_bytes":"1"}'));
    r := r || jsonb_build_object('U7_row_rejects', pg_temp.pass(
      pg_temp.st(t, 0) = 'rejected:invalid_value' AND pg_temp.st(t, 1) = 'rejected:invalid_value' AND pg_temp.st(t, 2) = 'rejected:invalid_value'
      AND pg_temp.st(t, 3) = 'rejected:invalid_value' AND pg_temp.st(t, 4) = 'rejected:thread_key_required' AND pg_temp.st(t, 5) = 'applied'
      AND pg_temp.st(t2, 0) = 'rejected:invalid_value' AND pg_temp.st(t2, 1) = 'rejected:invalid_value' AND pg_temp.st(t2, 2) = 'applied'
      AND pg_temp.st(t3, 0) = 'rejected:invalid_value' AND pg_temp.st(t3, 1) = 'rejected:parent_missing' AND pg_temp.st(t3, 2) = 'rejected:invalid_value'
      AND pg_temp.st(acc, 0) = 'rejected:invalid_value' AND pg_temp.st(acc, 1) = 'rejected:invalid_value' AND pg_temp.st(acc, 2) = 'rejected:parent_missing'
      AND pg_temp.st(acc, 3) = 'rejected:blob_unavailable' AND pg_temp.st(acc, 4) = 'rejected:invalid_value',
      left(t, 200) || ' | ' || left(t2, 150) || ' | ' || left(t3, 150) || ' | ' || left(acc, 200)));
    RAISE EXCEPTION USING ERRCODE = 'T4236';
  EXCEPTION WHEN SQLSTATE 'T4236' THEN NULL; WHEN OTHERS THEN r := r || jsonb_build_object('U7_rows_crash', 'ERR ' || SQLSTATE || ' ' || SQLERRM);
  END;

  BEGIN
    acc := '';
    t := pg_temp.up(A, 'cloud_upsert_messages', I1, D1, jsonb_build_array(pg_temp.row_of('cloud_upsert_messages', 'acc-1') - 'hidden_from_export'));
    IF pg_temp.err(t) <> 'invalid_input' THEN acc := acc || ' hidden=' || t; END IF;
    t := pg_temp.up(A, 'cloud_upsert_messages', I1, D1, jsonb_build_array(pg_temp.row_of('cloud_upsert_messages', 'acc-2'), pg_temp.row_of('cloud_upsert_messages', 'acc-3') || '{"content_hash":"no"}'));
    IF pg_temp.err(t) <> 'invalid_input' OR (pg_temp.j(t) -> 'detail' ->> 'index') <> '1' THEN acc := acc || ' hash=' || t; END IF;
    t := pg_temp.up(A, 'cloud_upsert_parties', I1, D1, jsonb_build_array(pg_temp.row_of('cloud_upsert_parties', 'acc-4') || '{"base_version":1.5}'));
    IF pg_temp.err(t) <> 'invalid_input' THEN acc := acc || ' base=' || t; END IF;
    t := pg_temp.up(A, 'cloud_upsert_checklists', I1, D1, jsonb_build_array(pg_temp.row_of('cloud_upsert_checklists', 'acc-5') - 'template_id'));
    IF pg_temp.err(t) <> 'invalid_input' THEN acc := acc || ' template=' || t; END IF;
    t := pg_temp.up(A, 'cloud_upsert_checklist_items', I1, D1, jsonb_build_array(pg_temp.row_of('cloud_upsert_checklist_items', 'acc-6') - 'local_checklist_id'));
    IF pg_temp.err(t) <> 'invalid_input' THEN acc := acc || ' parent=' || t; END IF;
    r := r || jsonb_build_object('U7_structural_refusals', pg_temp.pass(acc = ''
      AND NOT EXISTS (SELECT 1 FROM public.cloud_deal_messages WHERE local_message_id IN ('acc-1', 'acc-2', 'acc-3')), acc));
    RAISE EXCEPTION USING ERRCODE = 'T4236';
  EXCEPTION WHEN SQLSTATE 'T4236' THEN NULL; WHEN OTHERS THEN r := r || jsonb_build_object('U7_structural_crash', 'ERR ' || SQLSTATE || ' ' || SQLERRM);
  END;

  -- ===================================================================== derived columns
  BEGIN
    t := pg_temp.up(A, 'cloud_upsert_messages', I1, D1, jsonb_build_array(
      pg_temp.row_of('cloud_upsert_messages', 'd-1') || '{"match_reason":"address_missing","link_state":"linked"}',
      pg_temp.row_of('cloud_upsert_messages', 'd-2') || '{"link_origin":"review_queue"}',
      pg_temp.row_of('cloud_upsert_messages', 'd-3')));
    PERFORM pg_temp.up(A, 'cloud_upsert_checklists', I1, D1, jsonb_build_array(
      jsonb_build_object('local_id', 'cl-p', 'content_hash', pg_temp.h('clp'), 'template_id', 'keepr:my-items', 'is_private', false)));
    PERFORM pg_temp.up(A, 'cloud_upsert_checklist_items', I1, D1, jsonb_build_array(
      jsonb_build_object('local_id', 'it-p', 'content_hash', pg_temp.h('itp'), 'local_checklist_id', 'cl-p', 'is_private', false)));
    -- a private flag on the parent reaches an existing item of a non-template checklist
    PERFORM pg_temp.up(A, 'cloud_upsert_checklists', I1, D1, jsonb_build_array(
      jsonb_build_object('local_id', 'cl-1', 'content_hash', pg_temp.h('cl-1-priv'), 'template_id', 'tpl-1', 'is_private', true)));
    t2 := pg_temp.st(pg_temp.deal(A, jsonb_build_object('source_install_id', I1, 'local_id', 'dc-1', 'content_hash', pg_temp.h('dc1'), 'detection_status', 'pending')))
       || pg_temp.st(pg_temp.deal(A, jsonb_build_object('source_install_id', I1, 'local_id', 'dc-2', 'content_hash', pg_temp.h('dc2'), 'status', 'rejected', 'detection_status', 'confirmed')))
       || pg_temp.st(pg_temp.deal(A, jsonb_build_object('source_install_id', I1, 'local_id', 'dc-3', 'content_hash', pg_temp.h('dc3'), 'status', 'closed', 'is_confirmed', false)));
    r := r || jsonb_build_object('U8_derived_columns', pg_temp.pass(
      (SELECT string_agg(local_message_id || '=' || link_state, ',' ORDER BY local_message_id) FROM public.cloud_deal_messages
        WHERE cloud_deal_id = D1 AND local_message_id IN ('d-1', 'd-2', 'd-3')) = 'd-1=needs_review,d-2=suggested,d-3=linked'
      AND (SELECT is_private FROM public.cloud_deal_checklists WHERE cloud_deal_id = D1 AND local_checklist_id = 'cl-p')
      AND (SELECT is_private FROM public.cloud_deal_checklist_items WHERE cloud_deal_id = D1 AND local_item_id = 'it-p')
      AND (SELECT is_private FROM public.cloud_deal_checklist_items WHERE id = IT1)
      AND (SELECT string_agg(local_transaction_id || '=' || is_confirmed, ',' ORDER BY local_transaction_id) FROM public.cloud_deals
            WHERE owner_user_id = A AND local_transaction_id LIKE 'dc-%') = 'dc-1=false,dc-2=false,dc-3=true'
      AND t2 = 'appliedappliedapplied', left(t, 300) || ' ' || t2));
    RAISE EXCEPTION USING ERRCODE = 'T4236';
  EXCEPTION WHEN SQLSTATE 'T4236' THEN NULL; WHEN OTHERS THEN r := r || jsonb_build_object('U8_crash', 'ERR ' || SQLSTATE || ' ' || SQLERRM);
  END;

  -- ===================================================================== tombstone and delete
  BEGIN
    UPDATE public.cloud_autosave_settings SET notice_version = 0 WHERE user_id = A;  -- unentitled
    t := pg_temp.tomb(A, I1, 'message', ARRAY[M1]);
    t2 := pg_temp.tomb(A, I1, 'message', ARRAY[M1]);
    js := (SELECT to_jsonb(m) FROM public.cloud_deal_messages m WHERE id = M1);
    t3 := pg_temp.tomb(A, I1, 'checklist', ARRAY[C1]);
    r := r || jsonb_build_object('T1_tombstone_scrub_unentitled', pg_temp.pass(
      pg_temp.st(t) = 'removed' AND pg_temp.st(t2) = 'unchanged'
      AND js ->> 'subject' IS NULL AND js ->> 'body_text' IS NULL AND js -> 'participants' = 'null'::jsonb AND js ->> 'removed_at' IS NOT NULL
      AND (js ->> 'version')::int = 2
      AND pg_temp.call_as(A, format('SELECT to_jsonb(count(*)) FROM public.cloud_deal_messages WHERE id = %L', M1)) = '1'
      AND pg_temp.st(t3) = 'removed'
      AND (SELECT removed_at IS NOT NULL AND title = '[removed]' FROM public.cloud_deal_checklist_items WHERE id = IT1)
      AND pg_temp.err(pg_temp.tomb(A, I1, 'bogus', ARRAY[M1])) = 'invalid_input'
      AND pg_temp.err(pg_temp.tomb(A, NULL, 'message', ARRAY[M1])) = 'invalid_input', t || t2 || t3));
    RAISE EXCEPTION USING ERRCODE = 'T4236';
  EXCEPTION WHEN SQLSTATE 'T4236' THEN NULL; WHEN OTHERS THEN r := r || jsonb_build_object('T1_crash', 'ERR ' || SQLSTATE || ' ' || SQLERRM);
  END;

  BEGIN
    PERFORM pg_temp.tomb(A, I1, 'message', ARRAY[M1]);
    t := pg_temp.up(A, 'cloud_upsert_messages', I1, D1, jsonb_build_array(jsonb_build_object('local_id', 'm-1', 'content_hash', pg_temp.h('m-1'),
           'channel_kind', 'email', 'hidden_from_export', false, 'subject', 'hello', 'body_text', 'body')));
    r := r || jsonb_build_object('T2_same_hash_revives', pg_temp.pass(pg_temp.st(t) = 'applied' AND pg_temp.cid(t) = M1
      AND (SELECT removed_at IS NULL AND subject = 'hello' AND version = 3 FROM public.cloud_deal_messages WHERE id = M1), t));
    RAISE EXCEPTION USING ERRCODE = 'T4236';
  EXCEPTION WHEN SQLSTATE 'T4236' THEN NULL; WHEN OTHERS THEN r := r || jsonb_build_object('T2_crash', 'ERR ' || SQLSTATE || ' ' || SQLERRM);
  END;

  BEGIN
    -- a blob used by two deals: tombstoning one file or deleting one deal leaves it live; the last reference fences it
    t := pg_temp.deal(A, jsonb_build_object('source_install_id', I1, 'local_id', 't-3', 'content_hash', pg_temp.h('t-3')));
    u := pg_temp.cid(t);
    PERFORM pg_temp.up(A, 'cloud_upsert_files', I1, u, jsonb_build_array(jsonb_build_object('local_id', 'f-3', 'content_hash', pg_temp.h('f-3'),
              'filename', 'c.pdf', 'blob_sha256', pg_temp.h('blob-a'))));
    t := pg_temp.tomb(A, I1, 'file', ARRAY[F1]);
    ok := (SELECT purge_requested_at IS NULL FROM public.cloud_blobs WHERE id = BL);
    UPDATE public.cloud_autosave_settings SET notice_version = 0 WHERE user_id = A;  -- unentitled
    t2 := pg_temp.call_as(A, format('SELECT public.cloud_delete_deal(%L::uuid, %L::uuid)', A, u));
    r := r || jsonb_build_object('T3_shared_blob_fencing', pg_temp.pass(pg_temp.st(t) = 'removed' AND ok
      AND pg_temp.err(t2) = 'OK' AND (pg_temp.j(t2) ->> 'blobs_fenced')::int = 1
      AND (SELECT purge_requested_at IS NOT NULL FROM public.cloud_blobs WHERE id = BL)
      AND (SELECT count(*) FROM public.cloud_deals WHERE id = u) = 0
      AND pg_temp.err(pg_temp.call_as(A, format('SELECT public.cloud_delete_deal(%L::uuid, %L::uuid)', A, u))) = 'not_found', t || ' ' || t2));
    RAISE EXCEPTION USING ERRCODE = 'T4236';
  EXCEPTION WHEN SQLSTATE 'T4236' THEN NULL; WHEN OTHERS THEN r := r || jsonb_build_object('T3_crash', 'ERR ' || SQLSTATE || ' ' || SQLERRM);
  END;

  BEGIN
    -- replacing a file'acc blob fences the old one when nothing else uses it
    js := pg_temp.j(pg_temp.call_as(A, format('SELECT public.cloud_register_blob(%L::uuid, %L, 5, NULL)', A, pg_temp.h('blob-b'))));
    PERFORM pg_temp.call_as(A, format('INSERT INTO storage.objects (bucket_id, name, metadata) VALUES (%L, %L, %L::jsonb)', 'cloud-deal-files', js ->> 'storage_path', '{"size":"5"}'));
    t2 := pg_temp.err(pg_temp.call_as(A, format('SELECT public.cloud_confirm_blob(%L::uuid, %L::uuid)', A, js ->> 'blob_id')));
    t := pg_temp.up(A, 'cloud_upsert_files', I1, D1, jsonb_build_array(jsonb_build_object('local_id', 'f-1', 'content_hash', pg_temp.h('f-1b'),
           'filename', 'a.pdf', 'blob_sha256', pg_temp.h('blob-b'))));
    r := r || jsonb_build_object('T4_replaced_blob_fenced', pg_temp.pass(t2 = 'OK' AND pg_temp.st(t) = 'applied'
      AND (SELECT purge_requested_at IS NOT NULL FROM public.cloud_blobs WHERE id = BL), t2 || ' ' || t));
    RAISE EXCEPTION USING ERRCODE = 'T4236';
  EXCEPTION WHEN SQLSTATE 'T4236' THEN NULL; WHEN OTHERS THEN r := r || jsonb_build_object('T4_crash', 'ERR ' || SQLSTATE || ' ' || SQLERRM);
  END;

  -- ===================================================================== blobs and storage
  BEGIN
    t := pg_temp.call_as(A, format('SELECT public.cloud_register_blob(%L::uuid, %L, 10, NULL)', A, pg_temp.h('blob-a')));
    PERFORM pg_temp.onoff(A, false);
    PERFORM pg_temp.onoff(A, true);
    t2 := pg_temp.call_as(A, format('SELECT public.cloud_register_blob(%L::uuid, %L, 10, NULL)', A, pg_temp.h('blob-a')));
    r := r || jsonb_build_object('B1_register_dedupe_and_refence', pg_temp.pass(
      pg_temp.j(t) ->> 'state' = 'uploaded' AND (pg_temp.j(t) ->> 'blob_id')::uuid = BL
      AND pg_temp.j(t2) ->> 'state' = 'new' AND (pg_temp.j(t2) ->> 'blob_id')::uuid <> BL
      AND (SELECT purge_requested_at IS NOT NULL FROM public.cloud_blobs WHERE id = BL)
      AND pg_temp.j(t2) ->> 'storage_path' = A::text || '/' || (pg_temp.j(t2) ->> 'blob_id'), t || t2));
    -- a deal created after the fence cannot attach the fenced blob, only the new live one
    UPDATE public.cloud_blobs SET purge_requested_at = now() WHERE id = (pg_temp.j(t2) ->> 'blob_id')::uuid;
    t := pg_temp.deal(A, jsonb_build_object('source_install_id', I1, 'local_id', 't-5', 'content_hash', pg_temp.h('t-5')));
    t3 := pg_temp.up(A, 'cloud_upsert_files', I1, pg_temp.cid(t), jsonb_build_array(jsonb_build_object('local_id', 'f-5',
            'content_hash', pg_temp.h('f-5'), 'filename', 'e.pdf', 'blob_sha256', pg_temp.h('blob-a'))));
    r := r || jsonb_build_object('B2_fenced_blob_not_attachable', pg_temp.pass(pg_temp.st(t3) = 'rejected:blob_unavailable', t3));
    RAISE EXCEPTION USING ERRCODE = 'T4236';
  EXCEPTION WHEN SQLSTATE 'T4236' THEN NULL; WHEN OTHERS THEN r := r || jsonb_build_object('B1_crash', 'ERR ' || SQLSTATE || ' ' || SQLERRM);
  END;

  BEGIN
    js := pg_temp.j(pg_temp.call_as(A, format('SELECT public.cloud_register_blob(%L::uuid, %L, 7, NULL)', A, pg_temp.h('blob-p'))));
    acc := js ->> 'storage_path';
    t := pg_temp.call_as(A, format('INSERT INTO storage.objects (bucket_id, name, metadata) VALUES (%L, %L, %L::jsonb)', 'cloud-deal-files', B::text || '/' || (js ->> 'blob_id'), '{"size":"7"}'));
    t2 := pg_temp.call_as(A, format('INSERT INTO storage.objects (bucket_id, name, metadata) VALUES (%L, %L, %L::jsonb)', 'cloud-deal-files', A::text || '/' || gen_random_uuid(), '{"size":"7"}'));
    -- registered path, but A becomes unentitled (assignment revoked): only the entitlement term can refuse
    PERFORM pg_temp.assign(O, A, false);
    t3 := pg_temp.call_as(A, format('INSERT INTO storage.objects (bucket_id, name, metadata) VALUES (%L, %L, %L::jsonb)', 'cloud-deal-files', acc, '{"size":"7"}'));
    PERFORM pg_temp.assign(O, A, true);
    r := r || jsonb_build_object('P1_storage_insert', pg_temp.pass(
      t LIKE 'ERR 42501%' AND t2 LIKE 'ERR 42501%' AND t3 LIKE 'ERR 42501%'
      AND pg_temp.call_as(A, format('INSERT INTO storage.objects (bucket_id, name, metadata) VALUES (%L, %L, %L::jsonb)', 'cloud-deal-files', acc, '{"size":"7"}')) = '"rows=1"'
      AND pg_temp.call_as(A, format('INSERT INTO storage.objects (bucket_id, name, metadata) VALUES (%L, %L, %L::jsonb)', 'cloud-deal-files', acc, '{"size":"7"}')) LIKE 'ERR 23505%'
      AND pg_temp.call_as(A, format('UPDATE storage.objects SET metadata = %L::jsonb WHERE name = %L', '{"size":"1"}', acc)) = '"rows=0"'
      AND pg_temp.call_as(A, format('SELECT to_jsonb(count(*)) FROM storage.objects WHERE name = %L AND metadata ->> %L = %L', acc, 'size', '7')) = '1',
      t || ' | ' || t2 || ' | ' || t3));
    RAISE EXCEPTION USING ERRCODE = 'T4236';
  EXCEPTION WHEN SQLSTATE 'T4236' THEN NULL; WHEN OTHERS THEN r := r || jsonb_build_object('P1_crash', 'ERR ' || SQLSTATE || ' ' || SQLERRM);
  END;

  BEGIN
    PERFORM set_config('storage.allow_delete_query', 'true', true);
    acc := pg_temp.call_as(A, 'DELETE FROM storage.objects WHERE bucket_id = ''cloud-deal-files''');
    t := pg_temp.call_as(A, 'SELECT to_jsonb(count(*)) FROM storage.objects WHERE bucket_id = ''cloud-deal-files''');
    UPDATE public.cloud_blobs SET purge_requested_at = now() WHERE id = BL;
    r := r || jsonb_build_object('P2_storage_read_closed_by_fence', pg_temp.pass(acc = '"rows=0"' AND t = '1'
      AND pg_temp.call_as(A, 'SELECT to_jsonb(count(*)) FROM storage.objects WHERE bucket_id = ''cloud-deal-files''') = '0', acc || t));
    RAISE EXCEPTION USING ERRCODE = 'T4236';
  EXCEPTION WHEN SQLSTATE 'T4236' THEN NULL; WHEN OTHERS THEN r := r || jsonb_build_object('P2_crash', 'ERR ' || SQLSTATE || ' ' || SQLERRM);
  END;

  BEGIN
    js := pg_temp.j(pg_temp.call_as(A, format('SELECT public.cloud_register_blob(%L::uuid, %L, 9, NULL)', A, pg_temp.h('blob-c'))));
    t := pg_temp.call_as(A, format('SELECT public.cloud_confirm_blob(%L::uuid, %L::uuid)', A, js ->> 'blob_id'));
    PERFORM pg_temp.call_as(A, format('INSERT INTO storage.objects (bucket_id, name, metadata) VALUES (%L, %L, %L::jsonb)', 'cloud-deal-files', js ->> 'storage_path', '{"size":"8"}'));
    t2 := pg_temp.call_as(A, format('SELECT public.cloud_confirm_blob(%L::uuid, %L::uuid)', A, js ->> 'blob_id'));
    js2 := pg_temp.j(pg_temp.call_as(A, format('SELECT public.cloud_register_blob(%L::uuid, %L, 9, NULL)', A, pg_temp.h('blob-c'))));
    PERFORM pg_temp.call_as(A, format('INSERT INTO storage.objects (bucket_id, name, metadata) VALUES (%L, %L, %L::jsonb)', 'cloud-deal-files', js2 ->> 'storage_path', '{"size":"9"}'));
    r := r || jsonb_build_object('P3_confirm_states', pg_temp.pass(pg_temp.err(t) = 'object_missing' AND pg_temp.err(t2) = 'size_mismatch'
      AND pg_temp.err(pg_temp.call_as(A, format('SELECT public.cloud_confirm_blob(%L::uuid, %L::uuid)', A, js2 ->> 'blob_id'))) = 'OK', t || t2 || coalesce(js2::text, 'null')));
    RAISE EXCEPTION USING ERRCODE = 'T4236';
  EXCEPTION WHEN SQLSTATE 'T4236' THEN NULL; WHEN OTHERS THEN r := r || jsonb_build_object('P3_crash', 'ERR ' || SQLSTATE || ' ' || SQLERRM);
  END;

  -- ===================================================================== assignment
  BEGIN
    t := pg_temp.call_as(AD, format('SELECT public.assign_member_addon(%L::uuid, %L::uuid, %L, true, NULL)', O, J, 'cloud_autosave'));
    t2 := pg_temp.err(pg_temp.assign(O, X, true)) || ',' || pg_temp.err(pg_temp.assign(PS, S, true)) || ',' || pg_temp.err(pg_temp.assign(O2, J, true))
      || ',' || (pg_temp.j(pg_temp.assign(O, A, true)) ->> 'state') || ',' || (pg_temp.j(pg_temp.assign(O, J, true)) ->> 'state')
      || ',' || (pg_temp.j(pg_temp.assign(O, J, false)) ->> 'state') || ',' || (pg_temp.j(pg_temp.assign(O, J, false)) ->> 'state')
      || ',' || pg_temp.err(pg_temp.assign(O, J, NULL));
    n := (SELECT count(*) FROM public.member_addons WHERE user_id = J);
    r := r || jsonb_build_object('M1_assign', pg_temp.pass(t LIKE 'ERR 42501%'
      AND t2 = 'not_member,personal_org,not_member,unchanged,assigned,revoked,unchanged,invalid_input' AND n = 1, t || ' ' || t2 || ' n=' || n));
    SET LOCAL session_replication_role = replica;
    UPDATE public.organization_members SET license_status = 'suspended' WHERE id = pg_temp.fx(205);
    SET LOCAL session_replication_role = origin;
    t := pg_temp.err(pg_temp.assign(O, J, true));
    SET LOCAL session_replication_role = replica;
    UPDATE public.organization_members SET license_status = 'active' WHERE id = pg_temp.fx(205);
    SET LOCAL session_replication_role = origin;
    r := r || jsonb_build_object('M1_assign_inactive_member', pg_temp.pass(t = 'not_member', t));
    UPDATE public.organization_plans SET feature_overrides = '{}' WHERE organization_id = O;
    r := r || jsonb_build_object('M1_assign_plan', pg_temp.pass(pg_temp.err(pg_temp.assign(O, J, true)) = 'plan_disallows', 'plan'));
    DELETE FROM public.organization_members WHERE id = pg_temp.fx(201);
    r := r || jsonb_build_object('M1_membership_removal', pg_temp.pass((SELECT count(*) FROM public.member_addons WHERE user_id = A) = 0, 'cascade'));
    RAISE EXCEPTION USING ERRCODE = 'T4236';
  EXCEPTION WHEN SQLSTATE 'T4236' THEN NULL; WHEN OTHERS THEN r := r || jsonb_build_object('M1_crash', 'ERR ' || SQLSTATE || ' ' || SQLERRM);
  END;

  -- ===================================================================== rollback and re-apply
  BEGIN
    EXECUTE $rbx$__ROLLBACK__$rbx$;
    acc := 'tables=' || (SELECT count(*) FROM pg_class WHERE relnamespace = 'public'::regnamespace AND relkind = 'r' AND (relname LIKE 'cloud\_%' OR relname = 'member_addons'))
      || ' fns=' || (SELECT count(*) FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND (proname ~ '^_?cloud_' OR proname IN ('assign_member_addon', 'get_my_cloud_autosave_state', 'set_my_cloud_autosave')))
      || ' bucket=' || (SELECT count(*) FROM storage.buckets WHERE id = 'cloud-deal-files')
      || ' policies=' || (SELECT count(*) FROM pg_policies WHERE schemaname = 'storage' AND policyname LIKE 'Cloud deal files:%')
      || ' keys=' || (SELECT count(*) FROM public.feature_definitions WHERE key LIKE 'cloud_autosave%');
    EXECUTE $mg1$__M1__$mg1$;
    EXECUTE $mg2$__M2__$mg2$;
    t := 'tables=' || (SELECT count(*) FROM pg_class WHERE relnamespace = 'public'::regnamespace AND relkind = 'r' AND (relname LIKE 'cloud\_%' OR relname = 'member_addons'))
      || ' fns=' || (SELECT count(*) FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND (proname ~ '^_?cloud_' OR proname IN ('assign_member_addon', 'get_my_cloud_autosave_state', 'set_my_cloud_autosave')))
      || ' bucket=' || (SELECT count(*) FROM storage.buckets WHERE id = 'cloud-deal-files')
      || ' policies=' || (SELECT count(*) FROM pg_policies WHERE schemaname = 'storage' AND policyname LIKE 'Cloud deal files:%')
      || ' keys=' || (SELECT count(*) FROM public.feature_definitions WHERE key LIKE 'cloud_autosave%');
    r := r || jsonb_build_object('G1_rollback_then_apply', pg_temp.pass(
      acc = 'tables=0 fns=0 bucket=0 policies=0 keys=0' AND t = 'tables=9 fns=22 bucket=1 policies=2 keys=2', acc || ' / ' || t));
    RAISE EXCEPTION USING ERRCODE = 'T4236';
  EXCEPTION WHEN SQLSTATE 'T4236' THEN NULL; WHEN OTHERS THEN
    EXECUTE 'RESET ROLE';
    r := r || jsonb_build_object('G1_crash', 'ERR ' || SQLSTATE || ' ' || SQLERRM);
  END;

  -- ===================================================================== child rows stay inside their deal
  BEGIN
    -- the same local child id exists in S's deal SD and in A's second-install deal D2
    t := pg_temp.deal(A, jsonb_build_object('source_install_id', I2, 'local_id', 'x-2', 'content_hash', pg_temp.h('x-2')));
    u := pg_temp.cid(t);
    PERFORM pg_temp.up(S, 'cloud_upsert_checklists', I1, SD, jsonb_build_array(jsonb_build_object('local_id', 'cl-1', 'content_hash', pg_temp.h('cl-1'), 'template_id', 'tpl-1')));
    PERFORM pg_temp.up(A, 'cloud_upsert_checklists', I2, u, jsonb_build_array(jsonb_build_object('local_id', 'cl-1', 'content_hash', pg_temp.h('cl-1'), 'template_id', 'tpl-1')));
    acc := '';
    FOREACH fn IN ARRAY CHILD_FNS LOOP
      t2 := pg_temp.st(pg_temp.up(S, fn, I1, SD, jsonb_build_array(pg_temp.row_of(fn, 'dup-1', 's'))))
         || pg_temp.st(pg_temp.up(A, fn, I2, u, jsonb_build_array(pg_temp.row_of(fn, 'dup-1', 'i'))));
      IF t2 <> 'appliedapplied' THEN acc := acc || ' setup_' || fn || '=' || t2; END IF;
    END LOOP;
    -- A writes the same local id into D1; then all three deals write it again with new content.
    -- Whatever row a deal-blind lookup would find first, at least two of these writes would land
    -- on another deal's row.
    FOREACH fn IN ARRAY CHILD_FNS LOOP
      t2 := pg_temp.up(A, fn, I1, D1, jsonb_build_array(pg_temp.row_of(fn, 'dup-1', 'a')));
      IF pg_temp.st(t2) <> 'applied' OR (pg_temp.j(t2) -> 'results' -> 0 ->> 'version') <> '1' THEN acc := acc || ' write_' || fn || '=' || left(t2, 120); END IF;
      t2 := pg_temp.st(pg_temp.up(S, fn, I1, SD, jsonb_build_array(pg_temp.row_of(fn, 'dup-1', 's2'))))
         || pg_temp.st(pg_temp.up(A, fn, I2, u, jsonb_build_array(pg_temp.row_of(fn, 'dup-1', 'i2'))))
         || pg_temp.st(pg_temp.up(A, fn, I1, D1, jsonb_build_array(pg_temp.row_of(fn, 'dup-1', 'a2'))));
      IF t2 <> 'appliedappliedapplied' THEN acc := acc || ' round2_' || fn || '=' || t2; END IF;
    END LOOP;
    js := jsonb_build_array(jsonb_build_array(D1, pg_temp.h('dup-1a2')), jsonb_build_array(SD, pg_temp.h('dup-1s2')), jsonb_build_array(u, pg_temp.h('dup-1i2')));
    FOREACH t3 IN ARRAY ARRAY['cloud_deal_parties:local_party_id', 'cloud_deal_checklists:local_checklist_id', 'cloud_deal_checklist_items:local_item_id',
                               'cloud_deal_messages:local_message_id', 'cloud_deal_files:local_attachment_id'] LOOP
      EXECUTE format('SELECT jsonb_agg(jsonb_build_array(cloud_deal_id, content_hash) ORDER BY cloud_deal_id) FROM public.%I WHERE %I = %L',
                     split_part(t3, ':', 1), split_part(t3, ':', 2), 'dup-1') INTO js2;
      IF js2 IS DISTINCT FROM (SELECT jsonb_agg(e ORDER BY e ->> 0) FROM jsonb_array_elements(js) e) THEN
        acc := acc || ' ' || split_part(t3, ':', 1) || '=' || coalesce(js2::text, 'null');
      END IF;
    END LOOP;
    r := r || jsonb_build_object('B1_child_rows_stay_in_their_deal', pg_temp.pass(acc = '', acc));
    RAISE EXCEPTION USING ERRCODE = 'T4236';
  EXCEPTION WHEN SQLSTATE 'T4236' THEN NULL; WHEN OTHERS THEN r := r || jsonb_build_object('B1c_crash', 'ERR ' || SQLSTATE || ' ' || SQLERRM);
  END;

  -- ===================================================================== tombstone erasure, per kind
  BEGIN
    -- f-1 is the only file using BL: its tombstone fences BL and closes the stored object
    n := pg_temp.j(pg_temp.call_as(A, 'SELECT to_jsonb(count(*)) FROM storage.objects WHERE bucket_id = ''cloud-deal-files'''))::text::bigint;
    t := pg_temp.tomb(A, I1, 'file', ARRAY[F1]);
    r := r || jsonb_build_object('T5_last_file_reference_fences_blob', pg_temp.pass(n = 1 AND pg_temp.st(t) = 'removed'
      AND (SELECT purge_requested_at IS NOT NULL FROM public.cloud_blobs WHERE id = BL)
      AND (SELECT blob_id IS NULL AND filename IS NULL FROM public.cloud_deal_files WHERE id = F1)
      AND pg_temp.call_as(A, 'SELECT to_jsonb(count(*)) FROM storage.objects WHERE bucket_id = ''cloud-deal-files''') = '0', n || ' ' || t));
    RAISE EXCEPTION USING ERRCODE = 'T4236';
  EXCEPTION WHEN SQLSTATE 'T4236' THEN NULL; WHEN OTHERS THEN r := r || jsonb_build_object('T5_crash', 'ERR ' || SQLSTATE || ' ' || SQLERRM);
  END;

  BEGIN
    PERFORM pg_temp.up(A, 'cloud_upsert_parties', I1, D1, jsonb_build_array(pg_temp.row_of('cloud_upsert_parties', 'p-1', 'full')
      || '{"company":"Co","notes":"n","emails":[{"email":"x@example.test","is_primary":true,"label":null}],"phones":[{"e164":"+12065550100","display":null,"is_primary":true,"label":null}]}'));
    ok := (SELECT company = 'Co' AND notes = 'n' AND emails IS NOT NULL AND phones IS NOT NULL AND display_name IS NOT NULL FROM public.cloud_deal_parties WHERE id = P1);
    t := pg_temp.tomb(A, I1, 'party', ARRAY[P1]);
    t2 := pg_temp.tomb(A, I1, 'checklist_item', ARRAY[IT1]);
    r := r || jsonb_build_object('T6_party_and_item_scrub', pg_temp.pass(ok AND pg_temp.st(t) = 'removed' AND pg_temp.st(t2) = 'removed'
      AND (SELECT display_name IS NULL AND company IS NULL AND emails IS NULL AND phones IS NULL AND notes IS NULL AND removed_at IS NOT NULL
             FROM public.cloud_deal_parties WHERE id = P1)
      AND (SELECT title = '[removed]' AND description IS NULL AND note IS NULL AND links = '[]'::jsonb AND removed_at IS NOT NULL
             FROM public.cloud_deal_checklist_items WHERE id = IT1)
      AND (SELECT removed_at IS NULL FROM public.cloud_deal_checklists WHERE id = C1), t || t2));
    RAISE EXCEPTION USING ERRCODE = 'T4236';
  EXCEPTION WHEN SQLSTATE 'T4236' THEN NULL; WHEN OTHERS THEN r := r || jsonb_build_object('T6_crash', 'ERR ' || SQLSTATE || ' ' || SQLERRM);
  END;

  BEGIN
    -- a removed party sent again with the same content comes back
    PERFORM pg_temp.tomb(A, I1, 'party', ARRAY[P1]);
    t := pg_temp.up(A, 'cloud_upsert_parties', I1, D1, jsonb_build_array(pg_temp.row_of('cloud_upsert_parties', 'p-1')));
    r := r || jsonb_build_object('T7_party_revives', pg_temp.pass(pg_temp.st(t) = 'applied' AND pg_temp.cid(t) = P1
      AND (SELECT removed_at IS NULL AND display_name = 'Party a' FROM public.cloud_deal_parties WHERE id = P1), t));
    RAISE EXCEPTION USING ERRCODE = 'T4236';
  EXCEPTION WHEN SQLSTATE 'T4236' THEN NULL; WHEN OTHERS THEN r := r || jsonb_build_object('T7_crash', 'ERR ' || SQLSTATE || ' ' || SQLERRM);
  END;

  BEGIN
    -- an item cannot attach to a removed checklist
    PERFORM pg_temp.tomb(A, I1, 'checklist', ARRAY[C1]);
    t := pg_temp.up(A, 'cloud_upsert_checklist_items', I1, D1, jsonb_build_array(pg_temp.row_of('cloud_upsert_checklist_items', 'it-9')));
    r := r || jsonb_build_object('T8_item_needs_live_checklist', pg_temp.pass(pg_temp.st(t) = 'rejected:parent_missing', t));
    RAISE EXCEPTION USING ERRCODE = 'T4236';
  EXCEPTION WHEN SQLSTATE 'T4236' THEN NULL; WHEN OTHERS THEN r := r || jsonb_build_object('T8_crash', 'ERR ' || SQLSTATE || ' ' || SQLERRM);
  END;

  -- ===================================================================== bindings found in review
  BEGIN
    -- an organization A is not a member of, where another user is an active member
    SET LOCAL session_replication_role = replica;
    INSERT INTO public.organizations (id, name, slug) VALUES (pg_temp.fx(103), 'Fixture O3', 'p4236-o3-' || substr(md5('__RUN__'), 1, 8));
    INSERT INTO public.organization_members (id, organization_id, user_id, role, license_status) VALUES (pg_temp.fx(208), pg_temp.fx(103), X, 'agent', 'active');
    SET LOCAL session_replication_role = origin;
    t := pg_temp.deal(A, jsonb_build_object('source_install_id', I1, 'local_id', 'g-3', 'content_hash', pg_temp.h('g3'), 'organization_id', pg_temp.fx(103)));
    r := r || jsonb_build_object('U5_org_needs_callers_membership', pg_temp.pass(pg_temp.err(t) = 'invalid_organization', t));
    RAISE EXCEPTION USING ERRCODE = 'T4236';
  EXCEPTION WHEN SQLSTATE 'T4236' THEN NULL; WHEN OTHERS THEN r := r || jsonb_build_object('U5c_crash', 'ERR ' || SQLSTATE || ' ' || SQLERRM);
  END;

  BEGIN
    -- the solo key on a brokerage plan does not license its unassigned members
    UPDATE public.organization_plans SET feature_overrides = '{"cloud_autosave_assignable":{"enabled":true},"cloud_autosave":{"enabled":true}}' WHERE organization_id = O;
    r := r || jsonb_build_object('E8_solo_path_is_own_personal_org', pg_temp.pass(pg_temp.state(J) ->> 'licensed' = 'false'
      AND pg_temp.state(A) ->> 'path' = 'brokerage', pg_temp.state(J)::text));
    RAISE EXCEPTION USING ERRCODE = 'T4236';
  EXCEPTION WHEN SQLSTATE 'T4236' THEN NULL; WHEN OTHERS THEN r := r || jsonb_build_object('E8_crash', 'ERR ' || SQLSTATE || ' ' || SQLERRM);
  END;

  BEGIN
    n := (pg_temp.state(A) -> 'storage' ->> 'used_bytes')::bigint;
    UPDATE public.cloud_blobs SET purge_requested_at = now() WHERE id = BL;
    r := r || jsonb_build_object('ST3_used_bytes_excludes_fenced', pg_temp.pass(n = 10 AND (pg_temp.state(A) -> 'storage' ->> 'used_bytes')::bigint = 0, n::text));
    RAISE EXCEPTION USING ERRCODE = 'T4236';
  EXCEPTION WHEN SQLSTATE 'T4236' THEN NULL; WHEN OTHERS THEN r := r || jsonb_build_object('ST3_crash', 'ERR ' || SQLSTATE || ' ' || SQLERRM);
  END;

  BEGIN
    -- a registered, not uploaded blob that is fenced: only the fence term can refuse the upload
    js := pg_temp.j(pg_temp.call_as(A, format('SELECT public.cloud_register_blob(%L::uuid, %L, 6, NULL)', A, pg_temp.h('blob-q'))));
    UPDATE public.cloud_blobs SET purge_requested_at = now() WHERE id = (js ->> 'blob_id')::uuid;
    t := pg_temp.call_as(A, format('INSERT INTO storage.objects (bucket_id, name, metadata) VALUES (%L, %L, %L::jsonb)', 'cloud-deal-files', js ->> 'storage_path', '{"size":"6"}'));
    r := r || jsonb_build_object('P4_no_upload_to_fenced_blob', pg_temp.pass(t LIKE 'ERR 42501%' AND pg_temp.err(pg_temp.call_as(A, 'SELECT to_jsonb(public.cloud_autosave_entitled())')) = 'true', t));
    RAISE EXCEPTION USING ERRCODE = 'T4236';
  EXCEPTION WHEN SQLSTATE 'T4236' THEN NULL; WHEN OTHERS THEN r := r || jsonb_build_object('P4_crash', 'ERR ' || SQLSTATE || ' ' || SQLERRM);
  END;

  -- ===================================================================== BACKLOG-4243 PR-0 (lib/contract-4243.sql)
  FOREACH fn IN ARRAY ARRAY['set_my_cloud_autosave', 'cloud_delete_install', 'cloud_upsert_deal', 'cloud_upsert_parties', 'cloud_upsert_checklists',
                            'cloud_upsert_checklist_items', 'cloud_upsert_messages', 'cloud_upsert_files', 'cloud_tombstone', 'cloud_delete_deal',
                            'cloud_mark_deal_synced', 'cloud_register_blob', 'cloud_confirm_blob'] LOOP
    r := r || jsonb_build_object('K6_' || fn, pg_temp.k6_probe(fn));
  END LOOP;
  r := r || jsonb_build_object('K6_catalog', pg_temp.k6_catalog());
  r := r || jsonb_build_object('K1_file_needs_uploaded_blob', pg_temp.k1_probe());
  r := r || jsonb_build_object('K2_file_needs_live_message', pg_temp.k2_probe());
  r := r || jsonb_build_object('K4_size_mismatch_fences_blob', pg_temp.k4_probe());
  r := r || jsonb_build_object('N1_freshness_clock', pg_temp.n1_probe());
  r := r || jsonb_build_object('N2_uploaded_blob_not_fenced', pg_temp.n2_probe());
  r := r || jsonb_build_object('W1_details_withheld', pg_temp.w_probe());

  -- a deliberate red that the driver must count (proves the parser counts failures)
  r := r || jsonb_build_object('Z0_parser_counts_a_fail', pg_temp.pass(false, 'expected'));
  RETURN r;
END
$run$;

DO $drv4236$
DECLARE v_r jsonb;
BEGIN
  v_r := pg_temp.run();
  RAISE EXCEPTION 'P4236_RESULT %', jsonb_build_object(
    'total', (SELECT count(*) FROM jsonb_each_text(v_r)),
    'pass', (SELECT count(*) FROM jsonb_each_text(v_r) e WHERE e.value = 'PASS'),
    'fail', (SELECT count(*) FROM jsonb_each_text(v_r) e WHERE e.value <> 'PASS'),
    'reds', (SELECT coalesce(jsonb_object_agg(e.key, e.value), '{}'::jsonb) FROM jsonb_each_text(v_r) e WHERE e.value <> 'PASS'));
END
$drv4236$;
