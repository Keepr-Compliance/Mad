-- BACKLOG-4263 PR-5 harness: helpers and fixtures, loaded BEFORE the migration (inside the same rolled-back call).
-- Every id, name, address and secret is invented and derived from 'pr5-harness'. Rows of the reserved account and
-- the live AI-app connection are never read or written; the portal secret used here is a fixture value put in
-- mcp_settings.portal_secret_prev_sha256 for the length of this call only (rolled back with everything else).
-- Deals, checklists and items come from the real producers (cloud_upsert_deal, cloud_todo_push, cloud_delete_deal).
-- Two columns are set directly, each the column its producer writes: cloud_deals.lock_reason (the desktop's deal
-- upload) and transaction_submissions rows (the desktop's submission upsert); both as PR-2's probes do.

CREATE TEMP TABLE p5_out (o serial, k text, v jsonb);
CREATE FUNCTION pg_temp.rec(k text, v jsonb) RETURNS void LANGUAGE sql AS $h$ INSERT INTO pg_temp.p5_out (k, v) VALUES (k, v) $h$;
CREATE TEMP TABLE p5_fx (k text PRIMARY KEY, v text);
CREATE FUNCTION pg_temp.id(k text) RETURNS uuid LANGUAGE sql STABLE AS $h$ SELECT v::uuid FROM pg_temp.p5_fx WHERE p5_fx.k = id.k $h$;
CREATE FUNCTION pg_temp.fxv(k text) RETURNS text LANGUAGE sql STABLE AS $h$ SELECT v FROM pg_temp.p5_fx WHERE p5_fx.k = fxv.k $h$;
CREATE FUNCTION pg_temp.put(k text, v text) RETURNS void LANGUAGE sql AS $h$
  INSERT INTO pg_temp.p5_fx VALUES (k, v) ON CONFLICT (k) DO UPDATE SET v = excluded.v $h$;

CREATE FUNCTION pg_temp.secret() RETURNS text LANGUAGE sql IMMUTABLE AS $h$ SELECT 'p5-fixture-portal-secret-' || md5('pr5-harness') $h$;
CREATE FUNCTION pg_temp.res() RETURNS text LANGUAGE sql IMMUTABLE AS $h$ SELECT 'https://p5-fixture.example.test/api/mcp' $h$;
-- access token digest n (what the portal sends) and its bytea text literal
CREATE FUNCTION pg_temp.dg(n int) RETURNS bytea LANGUAGE sql IMMUTABLE AS $h$ SELECT sha256(convert_to('p5-at-' || md5('pr5-harness') || n, 'UTF8')) $h$;
CREATE FUNCTION pg_temp.dgl(n int) RETURNS text LANGUAGE sql IMMUTABLE AS $h$ SELECT '\x' || encode(pg_temp.dg(n), 'hex') $h$;
CREATE FUNCTION pg_temp.client() RETURNS text LANGUAGE sql IMMUTABLE AS $h$ SELECT 'kpr_c_' || substr(md5('pr5-harness-client'), 1, 22) $h$;

-- a connection with an access token (digest n) and a refresh token (digest n + 500)
CREATE FUNCTION pg_temp.conn(k text, u uuid, n int, scope text, provider text DEFAULT 'anthropic', cname text DEFAULT 'Fixture app') RETURNS uuid LANGUAGE plpgsql AS $h$
DECLARE v uuid := md5('pr5-harness-conn-' || k)::uuid;
BEGIN
  INSERT INTO public.mcp_connections (id, user_id, client_id, provider, client_name, redirect_uri, resource, scope, notice_version, status, activated_at)
  VALUES (v, u, pg_temp.client(), provider, cname,
          CASE provider WHEN 'anthropic' THEN 'https://claude.ai/api/mcp/auth_callback' ELSE 'https://chatgpt.com/connector_platform_oauth_redirect' END,
          pg_temp.res(), scope, 1, 'active', now());
  INSERT INTO public.mcp_tokens (token_sha256, connection_id, kind, pepper_version, expires_at) VALUES
    (sha256(pg_temp.dg(n)), v, 'access', (SELECT pepper_version FROM public.mcp_settings WHERE id), now() + interval '1 hour'),
    (sha256(pg_temp.dg(n + 500)), v, 'refresh', (SELECT pepper_version FROM public.mcp_settings WHERE id), now() + interval '30 days');
  PERFORM pg_temp.put(k, v::text);
  RETURN v;
END $h$;

-- desktop ops (the shapes PR-4a's sender sends)
CREATE FUNCTION pg_temp.cc(dl uuid, lid text, tpl text, name text, so int) RETURNS jsonb LANGUAGE sql VOLATILE AS $h$
  SELECT jsonb_build_object('op_id', gen_random_uuid(), 'kind', 'create_checklist', 'deal_id', dl, 'local_id', lid, 'template_id', tpl,
    'template_name', name, 'sort_order', so, 'is_private', tpl = 'keepr:my-items', 'edited_at', pg_temp.nowt()) $h$;
CREATE FUNCTION pg_temp.ci(dl uuid, cl text, lid text, title text, so int, req boolean DEFAULT false, note text DEFAULT NULL) RETURNS jsonb LANGUAGE sql VOLATILE AS $h$
  SELECT jsonb_build_object('op_id', gen_random_uuid(), 'kind', 'create_item', 'deal_id', dl, 'checklist_local_id', cl,
    'local_id', lid, 'title', title, 'is_required', req, 'done', jsonb_build_object('is_checked', false, 'checked_at', NULL),
    'sort_order', so, 'edit_seq', 1, 'edited_at', pg_temp.nowt(), 'note', note) $h$;
CREATE FUNCTION pg_temp.op_set(id uuid, part text, val jsonb, base bigint, es bigint, edited text) RETURNS jsonb LANGUAGE sql VOLATILE AS $h$
  SELECT jsonb_build_object('op_id', gen_random_uuid(), 'kind', 'set', 'entity', 'item', 'id', id, 'part', part,
           'base_rev', base, 'edit_seq', es, 'edited_at', edited, 'value', val)
$h$;
CREATE FUNCTION pg_temp.op(kind text, ent text, id uuid) RETURNS jsonb LANGUAGE sql VOLATILE AS $h$
  SELECT jsonb_build_object('op_id', gen_random_uuid(), 'kind', kind, 'entity', ent, 'id', id, 'edited_at', pg_temp.nowt())
$h$;
CREATE FUNCTION pg_temp.it(id uuid) RETURNS public.cloud_deal_checklist_items LANGUAGE sql STABLE AS $h$
  SELECT * FROM public.cloud_deal_checklist_items WHERE id = it.id
$h$;
CREATE FUNCTION pg_temp.hist_n(id uuid) RETURNS bigint LANGUAGE sql STABLE AS $h$
  SELECT count(*) FROM public.cloud_todo_history h WHERE h.entity_id = hist_n.id
$h$;
CREATE FUNCTION pg_temp.head(u uuid) RETURNS bigint LANGUAGE sql STABLE AS $h$
  SELECT coalesce((SELECT last_seq FROM public.cloud_todo_feed_head WHERE owner_user_id = u), 0)
$h$;
-- the cloud id of a desktop local item / checklist id on a deal
CREATE FUNCTION pg_temp.item_of(dl uuid, lid text) RETURNS uuid LANGUAGE sql STABLE AS $h$
  SELECT id FROM public.cloud_deal_checklist_items WHERE cloud_deal_id = dl AND local_item_id = lid
$h$;

-- the old reader's answer (as the data tools call it: definer, read-only, the owner's claims), before the migration
CREATE FUNCTION pg_temp.reader(u uuid, dl uuid) RETURNS jsonb LANGUAGE sql AS $h$
  SELECT pg_temp.j(pg_temp.as_user(u, format('SELECT public._mcp_r_deal_checklists(%L::uuid, false, NULL::uuid)', dl)))
$h$;

DO $fx5$
DECLARE A uuid := pg_temp.fx(1); B uuid := pg_temp.fx(2); C uuid := pg_temp.fx(3); O uuid := pg_temp.fx(101);
        IA uuid := pg_temp.fx(301); IB uuid := pg_temp.fx(302); r jsonb; d uuid; u uuid; k text;
BEGIN
  SET LOCAL session_replication_role = replica;
  INSERT INTO auth.users (id, email, aud, role, instance_id, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
  SELECT pg_temp.fx(n), 'p4263-' || substr(md5('pr5-harness'), 1, 8) || '-' || n || '@example.test', 'authenticated', 'authenticated',
         '00000000-0000-0000-0000-000000000000', '{"provider":"email"}', '{}', now(), now() FROM generate_series(1, 3) n;
  INSERT INTO public.users (id, email, oauth_provider, oauth_id, display_name)
  SELECT pg_temp.fx(n), 'p4263-' || substr(md5('pr5-harness'), 1, 8) || '-' || n || '@example.test', 'email', pg_temp.fx(n)::text, 'Fixture ' || n
    FROM generate_series(1, 3) n ON CONFLICT (id) DO NOTHING;
  INSERT INTO public.organizations (id, name, slug) VALUES (O, 'Fixture O', 'p4263-o-' || substr(md5('pr5-harness'), 1, 8));
  INSERT INTO public.organization_members (id, organization_id, user_id, role, license_status) VALUES
    (pg_temp.fx(201), O, A, 'agent', 'active'), (pg_temp.fx(202), O, B, 'agent', 'active'), (pg_temp.fx(203), O, C, 'agent', 'active');
  INSERT INTO public.organization_plans (organization_id, plan_id, feature_overrides)
  SELECT O, (SELECT id FROM public.plans WHERE tier = 'team' ORDER BY sort_order, name LIMIT 1), '{"cloud_autosave_assignable":{"enabled":true}}'::jsonb;
  SET LOCAL session_replication_role = origin;
  FOREACH u IN ARRAY ARRAY[A, B] LOOP
    PERFORM pg_temp.assign(O, u);
    PERFORM pg_temp.rec('fx_on_' || CASE WHEN u = A THEN 'A' ELSE 'B' END, pg_temp.onoff(u, true) -> 'success');
  END LOOP;
  PERFORM pg_temp.put('A', A::text); PERFORM pg_temp.put('B', B::text); PERFORM pg_temp.put('C', C::text);
  PERFORM pg_temp.put('IA', IA::text); PERFORM pg_temp.put('IB', IB::text); PERFORM pg_temp.put('O', O::text);

  -- deals: DA1 live (template list + My items), DA2 live (template list only), DA3 live (locked later),
  -- DA4 not confirmed (rejected), DA5 removed, DA6 live (a submission row later); DB1 (owner B)
  FOREACH k IN ARRAY ARRAY['DA1', 'DA2', 'DA3', 'DA4', 'DA5', 'DA6'] LOOP
    r := pg_temp.deal(A, pg_temp.dp(IA, lower(k), CASE WHEN k = 'DA4' THEN '{"detection_status":"rejected"}'::jsonb ELSE '{}'::jsonb END));
    PERFORM pg_temp.put(k, r -> 'results' -> 0 ->> 'cloud_id');
  END LOOP;
  r := pg_temp.deal(B, pg_temp.dp(IB, 'db1')); PERFORM pg_temp.put('DB1', r -> 'results' -> 0 ->> 'cloud_id');

  r := pg_temp.push(A, IA, pg_temp.nowt(), jsonb_build_array(
         pg_temp.cc(pg_temp.id('DA1'), 'a1-tpl', 'tpl-purchase', 'Purchase', 0),
         pg_temp.ci(pg_temp.id('DA1'), 'a1-tpl', 't1', 'Inspection report', 0, true),
         pg_temp.ci(pg_temp.id('DA1'), 'a1-tpl', 't2', 'Appraisal', 1, false),
         pg_temp.cc(pg_temp.id('DA1'), 'a1-my', 'keepr:my-items', 'My items', 1),
         pg_temp.ci(pg_temp.id('DA1'), 'a1-my', 'm1', 'Call the lender', 0),
         pg_temp.ci(pg_temp.id('DA1'), 'a1-my', 'm2', 'Order keys', 1),
         pg_temp.ci(pg_temp.id('DA1'), 'a1-my', 'm3', 'Long note', 2, false, repeat('Remember the side gate code. ', 40)),
         pg_temp.ci(pg_temp.id('DA1'), 'a1-my', 'm4', 'Removed one', 3),
         pg_temp.cc(pg_temp.id('DA2'), 'a2-tpl', 'tpl-listing', 'Listing', 0),
         pg_temp.ci(pg_temp.id('DA2'), 'a2-tpl', 'u1', 'Photos', 0),
         pg_temp.cc(pg_temp.id('DA3'), 'a3-my', 'keepr:my-items', 'My items', 0),
         pg_temp.ci(pg_temp.id('DA3'), 'a3-my', 'l1', 'Locked one', 0),
         pg_temp.ci(pg_temp.id('DA3'), 'a3-my', 'l2', 'Locked removed', 1),
         pg_temp.cc(pg_temp.id('DA4'), 'a4-my', 'keepr:my-items', 'My items', 0),
         pg_temp.ci(pg_temp.id('DA4'), 'a4-my', 'n1', 'Unconfirmed one', 0),
         pg_temp.cc(pg_temp.id('DA5'), 'a5-my', 'keepr:my-items', 'My items', 0),
         pg_temp.ci(pg_temp.id('DA5'), 'a5-my', 'r1', 'On a removed deal', 0),
         pg_temp.cc(pg_temp.id('DA6'), 'a6-my', 'keepr:my-items', 'My items', 0),
         pg_temp.ci(pg_temp.id('DA6'), 'a6-my', 's1', 'Submitted one', 0)));
  PERFORM pg_temp.rec('fx_push_A', (SELECT jsonb_agg(DISTINCT x ->> 'status') FROM jsonb_array_elements(r -> 'results') x));
  r := pg_temp.push(B, IB, pg_temp.nowt(), jsonb_build_array(
         pg_temp.cc(pg_temp.id('DB1'), 'b1-my', 'keepr:my-items', 'My items', 0),
         pg_temp.ci(pg_temp.id('DB1'), 'b1-my', 'b1', 'Owner B item', 0)));
  PERFORM pg_temp.rec('fx_push_B', (SELECT jsonb_agg(DISTINCT x ->> 'status') FROM jsonb_array_elements(r -> 'results') x));
  FOR k, d IN SELECT x.k, y.d FROM (VALUES ('t1', 'DA1'), ('t2', 'DA1'), ('m1', 'DA1'), ('m2', 'DA1'), ('m3', 'DA1'), ('m4', 'DA1'),
                                           ('u1', 'DA2'), ('l1', 'DA3'), ('l2', 'DA3'), ('n1', 'DA4'), ('r1', 'DA5'), ('s1', 'DA6'), ('b1', 'DB1')) x(k, d0)
                                   CROSS JOIN LATERAL (SELECT pg_temp.id(x.d0) AS d) y LOOP
    PERFORM pg_temp.put(k, pg_temp.item_of(d, k)::text);
  END LOOP;
  -- removals by the desktop: a My item (m4), a template item (t2), a My item on DA3 (l2); the deal DA5
  r := pg_temp.push(A, IA, pg_temp.nowt(), jsonb_build_array(pg_temp.op('remove', 'item', pg_temp.id('m4')),
         pg_temp.op('remove', 'item', pg_temp.id('t2')), pg_temp.op('remove', 'item', pg_temp.id('l2'))));
  PERFORM pg_temp.rec('fx_removals', (SELECT jsonb_agg(x ->> 'status') FROM jsonb_array_elements(r -> 'results') x));
  PERFORM pg_temp.rec('fx_remove_DA5', pg_temp.deldeal(A, pg_temp.id('DA5')) -> 'ok');
  -- DA3 locked as the desktop's deal upload records a submitted deal
  UPDATE public.cloud_deals SET lock_reason = 'submitted' WHERE id = pg_temp.id('DA3');

  -- the portal secret (prev slot, this call only) and connections that existed before the migration (read scope)
  UPDATE public.mcp_settings SET portal_secret_prev_sha256 = sha256(convert_to(pg_temp.secret(), 'UTF8')) WHERE id;
  INSERT INTO public.mcp_oauth_clients (client_id, client_name, redirect_uris, ip_sha256)
  VALUES (pg_temp.client(), 'Fixture app', ARRAY['https://claude.ai/api/mcp/auth_callback', 'https://chatgpt.com/connector_platform_oauth_redirect'],
          sha256(convert_to('p5-ip', 'UTF8')));
  PERFORM pg_temp.conn('KA_read', A, 1, 'mcp:read');
  PERFORM pg_temp.conn('KB_read', B, 2, 'mcp:read', 'openai');

  -- the frame v1 answer before the migration, for the byte-equality control
  PERFORM pg_temp.put('reader_v1_before', pg_temp.reader(A, pg_temp.id('DA1'))::text);
  PERFORM pg_temp.rec('fx_reader_before', jsonb_build_object('v', pg_temp.reader(A, pg_temp.id('DA1')) -> 'v',
    'items', pg_temp.reader(A, pg_temp.id('DA1')) -> 'items_returned'));
END
$fx5$;
