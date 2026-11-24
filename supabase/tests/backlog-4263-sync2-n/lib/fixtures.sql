-- BACKLOG-4263 P11 (T-N) harness fixtures. Users A and B: licensed through one invented organization on the team plan,
-- Keepr Cloud on (Keepr Cloud notice 1), as backlog-4263-sync2-t/lib/fixtures.sql. Rows come from the real producers
-- (assign_member_addon, set_my_cloud_autosave, cloud_upsert_deal, cloud_upsert_messages, and the approval chain
-- mcp_authorize_begin -> mcp_authorize_view -> mcp_authorize_approve -> mcp_exchange_code). Set directly, each named here:
--   cloud_release_switches (one row): messages_upload on, one_computer off (the readers' active-computer filter is off);
--   mcp_settings (one row): enabled and the fixture portal secret in portal_secret_prev_sha256, for this call only;
--   mcp_oauth_clients: one invented registered client with both allowlisted redirect addresses (the registration
--     function needs the portal and an address digest; the row is what it writes, 20261112170000 mcp_register_client).
-- Connections K1 (A) and KB1 (B) are made through the chain while mcp_settings.notice_version is 1, so they carry 1.
DO $fx4263n$
DECLARE A uuid; B uuid; O uuid; r jsonb; who jsonb; k text; t0 timestamptz := clock_timestamp(); t1 timestamptz;
BEGIN
  PERFORM pg_temp.put('RUN', gen_random_uuid());
  A := pg_temp.put('A', gen_random_uuid());
  B := pg_temp.put('B', gen_random_uuid());
  O := pg_temp.put('O', gen_random_uuid());
  PERFORM pg_temp.put('IA', gen_random_uuid());
  PERFORM pg_temp.put('IB', gen_random_uuid());
  PERFORM pg_temp.rec('wal_start', to_jsonb(pg_catalog.pg_current_wal_insert_lsn()::text));
  SET LOCAL session_replication_role = replica;
  INSERT INTO auth.users (id, email, aud, role, instance_id, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
  SELECT pg_temp.f(x), 'p4263n-' || left(pg_temp.s('RUN'), 8) || '-' || lower(x) || '@example.test', 'authenticated', 'authenticated',
         '00000000-0000-0000-0000-000000000000', '{"provider":"email"}', '{}', now(), now()
    FROM unnest(ARRAY['A', 'B']) x;
  INSERT INTO public.users (id, email, oauth_provider, oauth_id, display_name)
  SELECT pg_temp.f(x), 'p4263n-' || left(pg_temp.s('RUN'), 8) || '-' || lower(x) || '@example.test', 'email', pg_temp.s(x), 'Fixture n ' || x
    FROM unnest(ARRAY['A', 'B']) x
  ON CONFLICT (id) DO NOTHING;
  INSERT INTO public.organizations (id, name, slug) VALUES (O, 'Fixture n', 'p4263n-' || left(pg_temp.s('RUN'), 12));
  INSERT INTO public.organization_members (id, organization_id, user_id, role, license_status)
  VALUES (gen_random_uuid(), O, A, 'agent', 'active'), (gen_random_uuid(), O, B, 'agent', 'active');
  INSERT INTO public.organization_plans (organization_id, plan_id, feature_overrides)
  VALUES (O, (SELECT id FROM public.plans WHERE tier = 'team' ORDER BY sort_order, name LIMIT 1), '{"cloud_autosave_assignable":{"enabled":true}}');
  SET LOCAL session_replication_role = origin;
  UPDATE public.cloud_release_switches SET one_computer = false, messages_upload = true WHERE id;
  FOREACH k IN ARRAY ARRAY['A', 'B'] LOOP
    r := pg_temp.j(pg_temp.call_as(NULL, format('SELECT public.assign_member_addon(%L::uuid, %L::uuid, %L, true, NULL::timestamptz)', O, pg_temp.f(k), 'cloud_autosave'), 'service_role'));
    IF r ->> 'state' IS DISTINCT FROM 'assigned' THEN RAISE EXCEPTION 'FIXTURE assign % failed: %', k, r; END IF;
    r := pg_temp.as_user(k, 'set_my_cloud_autosave', '%L::uuid, %L::boolean, %L::integer, %L::uuid', pg_temp.s(k), 'true', '1', NULL);
    IF r ->> 'success' IS DISTINCT FROM 'true' THEN RAISE EXCEPTION 'FIXTURE enable % failed: %', k, r; END IF;
  END LOOP;

  -- one confirmed deal of A with three messages: linked, matched by a contact only (Needs review), a text hidden from exports
  r := pg_temp.as_user('A', 'cloud_upsert_deal', '%L::uuid, %L::jsonb', pg_temp.s('A'),
         jsonb_build_object('source_install_id', pg_temp.s('IA'), 'local_id', 'p4263n-dA', 'content_hash', pg_temp.h('d:dA'),
                            'property_address', 'Fixture dA Street', 'status', 'active')::text);
  IF r -> 'results' -> 0 ->> 'status' IS DISTINCT FROM 'applied' THEN RAISE EXCEPTION 'FIXTURE deal failed: %', left(r::text, 400); END IF;
  PERFORM pg_temp.put('dA', (r -> 'results' -> 0 ->> 'cloud_id')::uuid);
  who := '{"from":"Seller Agent <seller@example.test>","to":["buyer@example.test"],"cc":[]}';
  -- the row shape cloud_upsert_messages reads (backlog-4263-sync2-t/lib/helpers.sql pg_temp.mrow, transcribed)
  r := pg_temp.as_user('A', 'cloud_upsert_messages', '%L::uuid, %L::uuid, %L::uuid, %L::jsonb', pg_temp.s('A'), pg_temp.s('IA'), pg_temp.s('dA'),
         (SELECT jsonb_agg(jsonb_build_object('local_id', x.lid, 'local_link_id', 'cm-' || x.lid, 'content_hash', pg_temp.h('m:' || x.lid),
            'channel_kind', x.kind, 'channel', CASE WHEN x.kind = 'text' THEN 'imessage' ELSE 'email' END, 'direction', 'inbound',
            'subject', x.subject, 'body_text', x.body, 'participants', who, 'thread_key', 'thr-' || x.lid, 'sent_at', x.sent, 'received_at', NULL,
            'link_source', 'auto', 'link_confidence', CASE WHEN x.reason = 'address_missing' THEN 0.5 ELSE 1 END, 'match_reason', x.reason,
            'linked_at', NULL, 'link_origin', 'link', 'hidden_from_export', x.hidden, 'source_updated_at', NULL) ORDER BY x.lid)
            FROM (VALUES ('m_lin', 'email', 'Offer accepted', 'Line 1', '2026-01-01T10:00:00.000Z', NULL, false),
                         ('m_rev', 'email', 'Inspection', 'Contact-only match', '2026-01-02T10:00:00.000Z', 'address_missing', false),
                         ('m_txt', 'text', NULL, 'See you at closing', '2026-01-03T10:00:00.000Z', NULL, true)) x(lid, kind, subject, body, sent, reason, hidden))::text);
  IF r ->> 'ok' IS DISTINCT FROM 'true' OR EXISTS (SELECT 1 FROM jsonb_array_elements(r -> 'results') e WHERE e ->> 'status' <> 'applied') THEN
    RAISE EXCEPTION 'FIXTURE messages failed: %', left(r::text, 400);
  END IF;

  -- MCP: switched on, the fixture portal secret, one registered client with both allowlisted addresses
  UPDATE public.mcp_settings SET portal_secret_prev_sha256 = sha256(convert_to(pg_temp.secret(), 'UTF8')), enabled = true WHERE id;
  INSERT INTO public.mcp_oauth_clients (client_id, client_name, redirect_uris, ip_sha256)
  VALUES (pg_temp.client(), 'Fixture app', ARRAY[pg_temp.redir('claude'), pg_temp.redir('chatgpt')], sha256(convert_to('p4263n-ip', 'UTF8')));
  t1 := clock_timestamp();
  r := pg_temp.chain('K1', 'A', 'claude');
  PERFORM pg_temp.rec('chain_ms', to_jsonb(ceil(extract(epoch FROM clock_timestamp() - t1) * 1000)));
  IF r ->> 'exchange_ok' IS DISTINCT FROM 'true' OR (r ->> 'view_version')::int IS DISTINCT FROM 1 THEN RAISE EXCEPTION 'FIXTURE chain K1 failed: %', r; END IF;
  r := pg_temp.chain('KB1', 'B', 'claude');
  IF r ->> 'exchange_ok' IS DISTINCT FROM 'true' THEN RAISE EXCEPTION 'FIXTURE chain KB1 failed: %', r; END IF;
  PERFORM pg_temp.rec('fx_counts', jsonb_build_object(
    'A_messages', (SELECT count(*) FROM public.cloud_deal_messages WHERE owner_user_id = A),
    'connections', (SELECT count(*) FROM public.mcp_connections WHERE user_id IN (A, B) AND status = 'active'),
    'versions', (SELECT jsonb_agg(c.notice_version ORDER BY c.notice_version) FROM public.mcp_connections c WHERE c.user_id IN (A, B)),
    'setting', pg_temp.setting_version()));
  PERFORM pg_temp.rec('fixture_ms', to_jsonb(ceil(extract(epoch FROM clock_timestamp() - t0) * 1000)));
END
$fx4263n$;
