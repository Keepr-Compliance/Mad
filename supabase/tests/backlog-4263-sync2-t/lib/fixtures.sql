-- BACKLOG-4263 P9 harness fixtures. Users A and B: licensed through one invented organization on the team plan, Keepr
-- Cloud on (notice 1). Rows come from the real producers (cloud_upsert_deal, cloud_upsert_messages, cloud_upsert_files,
-- cloud_tombstone, cloud_delete_deal, cloud_claim_install, set_my_cloud_autosave). Set directly, each named here:
--   cloud_release_switches (one row): messages_upload on, one_computer off while the second computer's deal is saved,
--     then on (the coordinator's release UPDATE);
--   one message's link_state set to 'suggested': the value the 20261123100000 writer gives a row sent with
--     link_origin 'review_queue' (/*MSG:linkstate*/); 20261123130000 refuses such rows (plan P4 condition 2), so this
--     row stands for one written before it;
--   mcp_settings (one row): enabled and the fixture portal secret in portal_secret_prev_sha256, for this call only;
--   mcp_oauth_clients, mcp_connections and mcp_tokens rows of three invented connections (approval-page version 1 or 2;
--     no producer exists until 20261123150000 sets the approval page to version 2).
DO $fx4263t$
DECLARE A uuid; B uuid; O uuid; r jsonb; big text; who jsonb; rows jsonb; k text; n int; sweep record;
BEGIN
  PERFORM pg_temp.put('RUN', gen_random_uuid());
  A := pg_temp.put('A', gen_random_uuid());
  B := pg_temp.put('B', gen_random_uuid());
  O := pg_temp.put('O', gen_random_uuid());
  FOREACH k IN ARRAY ARRAY['IA', 'IB', 'IBB'] LOOP PERFORM pg_temp.put(k, gen_random_uuid()); END LOOP;
  SET LOCAL session_replication_role = replica;
  INSERT INTO auth.users (id, email, aud, role, instance_id, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
  SELECT pg_temp.f(x), 'p4263t-' || left(pg_temp.s('RUN'), 8) || '-' || lower(x) || '@example.test', 'authenticated', 'authenticated',
         '00000000-0000-0000-0000-000000000000', '{"provider":"email"}', '{}', now(), now()
    FROM unnest(ARRAY['A', 'B']) x;
  INSERT INTO public.users (id, email, oauth_provider, oauth_id, display_name)
  SELECT pg_temp.f(x), 'p4263t-' || left(pg_temp.s('RUN'), 8) || '-' || lower(x) || '@example.test', 'email', pg_temp.s(x), 'Fixture t ' || x
    FROM unnest(ARRAY['A', 'B']) x
  ON CONFLICT (id) DO NOTHING;
  INSERT INTO public.organizations (id, name, slug) VALUES (O, 'Fixture t', 'p4263t-' || left(pg_temp.s('RUN'), 12));
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

  -- deals: dA, dBig, dSw (A, computer IA); dU unconfirmed, dR removed (IA); dB (A, computer IB); dBB (B)
  PERFORM pg_temp.deal('A', 'IA', 'dA', 'active');
  PERFORM pg_temp.deal('A', 'IA', 'dBig', 'active');
  PERFORM pg_temp.deal('A', 'IA', 'dSw', 'active');
  PERFORM pg_temp.deal('A', 'IA', 'dU', 'rejected');
  PERFORM pg_temp.deal('A', 'IA', 'dR', 'active');
  PERFORM pg_temp.deal('A', 'IB', 'dB', 'active');
  PERFORM pg_temp.deal('B', 'IBB', 'dBB', 'active');
  IF (SELECT is_confirmed FROM public.cloud_deals WHERE id = pg_temp.f('dU')) IS NOT FALSE THEN RAISE EXCEPTION 'FIXTURE dU is confirmed'; END IF;

  who := '{"from":"Seller Agent <seller@example.test>","to":["buyer@example.test","agent@example.test"],"cc":["tc@example.test"]}';
  PERFORM pg_temp.msgs('A', 'IA', 'dA', jsonb_build_array(
    pg_temp.mrow('m_lin', 'email', 'Offer accepted', E'Line 1\nLine 2', who, '2026-01-01T10:00:00.000Z', NULL, NULL, false, 'thr-lin'),
    pg_temp.mrow('m_rev', 'email', 'Inspection', 'Contact-only match', who, '2026-01-03T10:00:00.000Z', NULL, 'address_missing', false, 'thr-rev'),
    pg_temp.mrow('m_txt', 'text', NULL, 'See you at closing', '{"from":"+15555550100","to":["me"]}', '2026-01-04T10:00:00.000Z', NULL, NULL, true, 'chat-p4263t'),
    pg_temp.mrow('m_recv', 'email', 'No send time', 'Received only', who, NULL, '2026-01-02T12:00:00.000Z', NULL, false, 'thr-recv'),
    pg_temp.mrow('m_none', 'email', 'No times', 'No send or receive time', who, NULL, NULL, NULL, false, 'thr-none'),
    pg_temp.mrow('m_tomb', 'email', 'Unlinked later', 'Removed body', who, '2026-01-05T10:00:00.000Z', NULL, NULL, false, 'thr-tomb'),
    pg_temp.mrow('m_sug', 'email', 'Suggested', 'Suggested body', who, '2026-01-06T10:00:00.000Z', NULL, NULL, false, 'thr-sug')));
  PERFORM pg_temp.files('A', 'IA', 'dA', jsonb_build_array(
    pg_temp.frow('f_lin1', 'm_lin', 'Contract.pdf', 'application/pdf', 'too_large'),
    pg_temp.frow('f_lin2', 'm_lin', 'Photo.jpg', 'image/jpeg', 'no_local_file'),
    pg_temp.frow('f_lin3', 'm_lin', 'Removed.pdf', 'application/pdf', 'too_large'),
    pg_temp.frow('f_deal', NULL, 'Deal level.pdf', 'application/pdf', 'too_large'),
    pg_temp.frow('f_tomb', 'm_tomb', 'Of removed message.pdf', 'application/pdf', 'too_large')));
  r := pg_temp.tomb('A', 'IA', 'message', ARRAY[pg_temp.f('m_tomb')]);
  IF r -> 'results' -> 0 ->> 'status' IS DISTINCT FROM 'applied' THEN RAISE EXCEPTION 'FIXTURE tombstone message failed: %', r; END IF;
  r := pg_temp.tomb('A', 'IA', 'file', ARRAY[pg_temp.f('f_lin3')]);
  IF r -> 'results' -> 0 ->> 'status' IS DISTINCT FROM 'applied' THEN RAISE EXCEPTION 'FIXTURE tombstone file failed: %', r; END IF;
  UPDATE public.cloud_deal_messages SET link_state = 'suggested' WHERE id = pg_temp.f('m_sug');
  PERFORM pg_temp.msgs('A', 'IA', 'dU', jsonb_build_array(pg_temp.mrow('m_unc', 'email', 'Unconfirmed deal', 'x', who, '2026-01-01T10:00:00.000Z', NULL, NULL, false, 't')));
  PERFORM pg_temp.msgs('A', 'IA', 'dR', jsonb_build_array(pg_temp.mrow('m_rem', 'email', 'Removed deal', 'x', who, '2026-01-01T10:00:00.000Z', NULL, NULL, false, 't')));
  r := pg_temp.as_user('A', 'cloud_delete_deal', '%L::uuid, %L::uuid', pg_temp.s('A'), pg_temp.s('dR'));
  IF r ->> 'ok' IS DISTINCT FROM 'true' THEN RAISE EXCEPTION 'FIXTURE delete deal failed: %', r; END IF;
  PERFORM pg_temp.msgs('A', 'IB', 'dB', jsonb_build_array(pg_temp.mrow('m_inact', 'email', 'Other computer', 'x', who, '2026-01-01T10:00:00.000Z', NULL, NULL, false, 't')));
  PERFORM pg_temp.msgs('B', 'IBB', 'dBB', jsonb_build_array(pg_temp.mrow('m_bb', 'email', 'Another person', 'x', who, '2026-01-01T10:00:00.000Z', NULL, NULL, false, 't')));

  -- two messages at every cap: a 1,000,000-character subject, 1 + 1000 + 10 participants of 400 four-byte characters
  -- each, 500 files with 300-character names and 200-character types; m_big1's body is 1,000,000 characters of quotes,
  -- newlines, control characters, four-byte and two-byte characters
  big := left(repeat('a"' || E'\n' || chr(1) || chr(128512) || chr(233), 166667), 1000000);
  INSERT INTO pg_temp.t_txt VALUES ('big1_md5', md5(big));
  who := jsonb_build_object('from', repeat(chr(128512), 400),
                            'to', (SELECT jsonb_agg(repeat(chr(128512), 399) || g) FROM generate_series(1, 1000) g),
                            'cc', (SELECT jsonb_agg(repeat(chr(128512), 399) || g) FROM generate_series(1, 10) g));
  PERFORM pg_temp.msgs('A', 'IA', 'dBig', jsonb_build_array(
    pg_temp.mrow('m_big1', 'email', repeat(chr(128512) || 'x', 500000), big, who, '2026-02-01T10:00:00.000Z', NULL, NULL, false, repeat(chr(128512), 3000)),
    pg_temp.mrow('m_big2', 'email', repeat(chr(128512) || 'x', 500000), 'short', who, '2026-02-02T10:00:00.000Z', NULL, NULL, false, repeat(chr(128512), 3000))));
  IF (SELECT char_length(body_text) FROM public.cloud_deal_messages WHERE id = pg_temp.f('m_big1')) <> 1000000 THEN
    RAISE EXCEPTION 'FIXTURE m_big1 body was cut';
  END IF;
  FOREACH k IN ARRAY ARRAY['m_big1', 'm_big2'] LOOP
    PERFORM pg_temp.files('A', 'IA', 'dBig', (SELECT jsonb_agg(pg_temp.frow(k || '_f' || g, k, repeat(chr(128512), 300), repeat(chr(128512), 200), 'too_large'))
                                               FROM generate_series(1, 500) g));
  END LOOP;

  -- body sizes at a part boundary (budget 60000 bytes for these small answers): 1 part, then 2 parts
  FOR sweep IN SELECT * FROM (VALUES ('s_a1', 'a', 60000), ('s_a2', 'a', 60001), ('s_q1', '"', 30000), ('s_q2', '"', 30001),
                                     ('s_e1', chr(128512), 15000), ('s_e2', chr(128512), 15001), ('s_c1', chr(1), 10000), ('s_c2', chr(1), 10001)) x(k, ch, n) LOOP
    PERFORM pg_temp.msgs('A', 'IA', 'dSw', jsonb_build_array(pg_temp.mrow(sweep.k, 'email', NULL, repeat(sweep.ch, sweep.n), NULL, '2026-03-01T10:00:00.000Z', NULL, NULL, false, 't')));
  END LOOP;

  -- MCP: switched on, the fixture portal secret, connections K1 (A, approval page 1), K2 (A, page 2), KB2 (B, page 2)
  UPDATE public.mcp_settings SET portal_secret_prev_sha256 = sha256(convert_to(pg_temp.secret(), 'UTF8')), enabled = true WHERE id;
  INSERT INTO public.mcp_oauth_clients (client_id, client_name, redirect_uris, ip_sha256)
  VALUES (pg_temp.client(), 'Fixture app', ARRAY['https://claude.ai/api/mcp/auth_callback'], sha256(convert_to('p4263t-ip', 'UTF8')));
  PERFORM pg_temp.conn('K1', A, 1);
  PERFORM pg_temp.conn('K2', A, 2);
  PERFORM pg_temp.conn('KB2', B, 2);

  -- one computer per account on; A's active computer is IA, B's is IBB
  UPDATE public.cloud_release_switches SET one_computer = true WHERE id;
  r := pg_temp.claim('A', 'IA', false);
  IF r ->> 'ok' IS DISTINCT FROM 'true' THEN RAISE EXCEPTION 'FIXTURE claim A failed: %', r; END IF;
  r := pg_temp.claim('B', 'IBB', false);
  IF r ->> 'ok' IS DISTINCT FROM 'true' THEN RAISE EXCEPTION 'FIXTURE claim B failed: %', r; END IF;
  PERFORM pg_temp.rec('fx_counts', jsonb_build_object(
    'A_messages', (SELECT count(*) FROM public.cloud_deal_messages WHERE owner_user_id = A),
    'A_files', (SELECT count(*) FROM public.cloud_deal_files WHERE owner_user_id = A),
    'A_active_is_IA', (SELECT active_install_id = pg_temp.f('IA') FROM public.cloud_autosave_settings WHERE user_id = A)));
END
$fx4263t$;
