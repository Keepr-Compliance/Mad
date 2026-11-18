-- BACKLOG-4263 list_deals address match harness: helpers and fixtures, loaded BEFORE the migration (inside the same
-- rolled-back call). Every id, name, address and secret is invented and derived from 'addr-harness'. The card-shaped
-- number is the well-known Luhn-valid test number; the dashed number is in 987-65-4320..4329, the range set aside
-- for advertising. Rows of the reserved account and of the live AI-app connection are never read or written. The
-- portal secret is a fixture value put in mcp_settings.portal_secret_prev_sha256 for this call only.
-- Deals come from the real producer (cloud_upsert_deal, cloud_delete_deal). Set directly, each named where it is
-- done: cloud_deals.last_synced_at of B's deals (distinct values plus ties, so the order and the cursor are tested on
-- more than the id); the timing rows (inserted by generate_series inside a rolled-back subtransaction).

CREATE TEMP TABLE pa_out (o serial, k text, v jsonb);
CREATE FUNCTION pg_temp.rec(k text, v jsonb) RETURNS void LANGUAGE sql AS $h$ INSERT INTO pg_temp.pa_out (k, v) VALUES (k, v) $h$;
CREATE TEMP TABLE pa_fx (k text PRIMARY KEY, v text);
CREATE FUNCTION pg_temp.id(k text) RETURNS uuid LANGUAGE sql STABLE AS $h$ SELECT v::uuid FROM pg_temp.pa_fx WHERE pa_fx.k = id.k $h$;
CREATE FUNCTION pg_temp.put(k text, v text) RETURNS void LANGUAGE sql AS $h$
  INSERT INTO pg_temp.pa_fx VALUES (k, v) ON CONFLICT (k) DO UPDATE SET v = excluded.v $h$;
CREATE FUNCTION pg_temp.ax(n int) RETURNS uuid LANGUAGE sql IMMUTABLE AS $h$ SELECT md5('p4263:addr-harness:' || n)::uuid $h$;

CREATE FUNCTION pg_temp.secret() RETURNS text LANGUAGE sql IMMUTABLE AS $h$ SELECT 'pa-fixture-portal-secret-' || md5('addr-harness') $h$;
CREATE FUNCTION pg_temp.res() RETURNS text LANGUAGE sql IMMUTABLE AS $h$ SELECT 'https://pa-fixture.example.test/api/mcp' $h$;
CREATE FUNCTION pg_temp.dg(n int) RETURNS bytea LANGUAGE sql IMMUTABLE AS $h$ SELECT sha256(convert_to('pa-at-' || md5('addr-harness') || n, 'UTF8')) $h$;
CREATE FUNCTION pg_temp.dgl(n int) RETURNS text LANGUAGE sql IMMUTABLE AS $h$ SELECT '\x' || encode(pg_temp.dg(n), 'hex') $h$;
CREATE FUNCTION pg_temp.client() RETURNS text LANGUAGE sql IMMUTABLE AS $h$ SELECT 'kpr_c_' || substr(md5('addr-harness-client'), 1, 22) $h$;

-- a connection with an access token (digest n)
CREATE FUNCTION pg_temp.conn(k text, u uuid, n int) RETURNS uuid LANGUAGE plpgsql AS $h$
DECLARE v uuid := md5('addr-harness-conn-' || k)::uuid;
BEGIN
  INSERT INTO public.mcp_connections (id, user_id, client_id, provider, client_name, redirect_uri, resource, scope, notice_version, status, activated_at)
  VALUES (v, u, pg_temp.client(), 'anthropic', 'Fixture app', 'https://claude.ai/api/mcp/auth_callback', pg_temp.res(), 'mcp:read', 1, 'active', now());
  INSERT INTO public.mcp_tokens (token_sha256, connection_id, kind, pepper_version, expires_at) VALUES
    (sha256(pg_temp.dg(n)), v, 'access', (SELECT pepper_version FROM public.mcp_settings WHERE id), now() + interval '1 hour');
  PERFORM pg_temp.put(k, v::text);
  RETURN v;
END $h$;

-- one deal through cloud_upsert_deal; its id is stored under key k
CREATE FUNCTION pg_temp.mk(u uuid, inst uuid, k text, addr text, st text DEFAULT 'active') RETURNS text LANGUAGE plpgsql AS $h$
DECLARE r jsonb;
BEGIN
  r := pg_temp.deal(u, pg_temp.dp(inst, 'pa-' || k, jsonb_build_object('property_address', addr, 'status', st)));
  IF (r -> 'results' -> 0 ->> 'cloud_id') IS NOT NULL THEN
    PERFORM pg_temp.put(k, r -> 'results' -> 0 ->> 'cloud_id');
  END IF;
  RETURN coalesce(r -> 'results' -> 0 ->> 'status', 'ERROR:' || left(r::text, 200));
END $h$;

-- ================================================================ what is stored on the test project (counts only)
DO $measure$
BEGIN
  PERFORM pg_temp.rec('measure_ledger_4263', (SELECT coalesce(jsonb_agg(version ORDER BY version), '[]') FROM supabase_migrations.schema_migrations
                                               WHERE version LIKE '202611181%'));
  PERFORM pg_temp.rec('measure_mcp_enabled', to_jsonb((SELECT enabled FROM public.mcp_settings WHERE id)));
  PERFORM pg_temp.rec('measure_deals', (SELECT jsonb_build_object('rows', count(*),
      'address_over_300', count(*) FILTER (WHERE char_length(property_address) > 300),
      'address_clean_differs', count(*) FILTER (WHERE public._mcp_clean(property_address, 300) IS DISTINCT FROM property_address),
      'max_per_owner', (SELECT max(c) FROM (SELECT count(*) c FROM public.cloud_deals GROUP BY owner_user_id) z)) FROM public.cloud_deals));
END
$measure$;

-- ================================================================ fixtures
DO $fxa$
DECLARE A uuid := pg_temp.ax(1); B uuid := pg_temp.ax(2); P uuid := pg_temp.ax(3); O uuid := pg_temp.ax(101);
        IA uuid := pg_temp.ax(301); IB uuid := pg_temp.ax(302); IP uuid := pg_temp.ax(303);
        st jsonb := '[]'; i_n int; L int; pre text; tag text;
BEGIN
  SET LOCAL session_replication_role = replica;
  INSERT INTO auth.users (id, email, aud, role, instance_id, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
  SELECT pg_temp.ax(n), 'p4263-' || substr(md5('addr-harness'), 1, 8) || '-' || n || '@example.test', 'authenticated', 'authenticated',
         '00000000-0000-0000-0000-000000000000', '{"provider":"email"}', '{}', now(), now() FROM generate_series(1, 3) n;
  INSERT INTO public.users (id, email, oauth_provider, oauth_id, display_name)
  SELECT pg_temp.ax(n), 'p4263-' || substr(md5('addr-harness'), 1, 8) || '-' || n || '@example.test', 'email', pg_temp.ax(n)::text, 'Fixture ' || n
    FROM generate_series(1, 3) n ON CONFLICT (id) DO NOTHING;
  INSERT INTO public.organizations (id, name, slug) VALUES (O, 'Fixture O', 'p4263-o-' || substr(md5('addr-harness'), 1, 8));
  INSERT INTO public.organization_members (id, organization_id, user_id, role, license_status) VALUES
    (pg_temp.ax(201), O, A, 'agent', 'active'), (pg_temp.ax(202), O, B, 'agent', 'active'), (pg_temp.ax(203), O, P, 'agent', 'active');
  INSERT INTO public.organization_plans (organization_id, plan_id, feature_overrides)
  SELECT O, (SELECT id FROM public.plans WHERE tier = 'team' ORDER BY sort_order, name LIMIT 1), '{"cloud_autosave_assignable":{"enabled":true}}'::jsonb;
  SET LOCAL session_replication_role = origin;
  PERFORM pg_temp.rec('fx_assign', jsonb_build_array(left(pg_temp.assign(O, A), 80), left(pg_temp.assign(O, B), 80), left(pg_temp.assign(O, P), 80)));
  PERFORM pg_temp.rec('fx_on', jsonb_build_array(pg_temp.onoff(A, true) -> 'success', pg_temp.onoff(B, true) -> 'success', pg_temp.onoff(P, true) -> 'success'));
  PERFORM pg_temp.put('A', A::text); PERFORM pg_temp.put('B', B::text); PERFORM pg_temp.put('P', P::text);
  PERFORM pg_temp.put('IA', IA::text); PERFORM pg_temp.put('IB', IB::text); PERFORM pg_temp.put('IP', IP::text);

  -- A: hidden numbers, the mask typed, invisible characters, %, _, \, case, both cut edges, a removed deal
  st := st || to_jsonb(pg_temp.mk(A, IA, 'AC', 'Lot 4111 1111 1111 1111 Invented Rd'));
  st := st || to_jsonb(pg_temp.mk(A, IA, 'AS', 'Unit 987-65-4321 Fixture Ct', 'pending'));
  st := st || to_jsonb(pg_temp.mk(A, IA, 'AP', 'Lot 4111-1111-1111-1111 Invented Rd, unit 987-65-4321', 'closed'));
  st := st || to_jsonb(pg_temp.mk(A, IA, 'AM', 'Fixture [number hidden by Keepr] Typed Way'));
  st := st || to_jsonb(pg_temp.mk(A, IA, 'AZ', 'Fixture Zero' || chr(8203) || 'Width Lane'));
  st := st || to_jsonb(pg_temp.mk(A, IA, 'APC', 'Fixture 50% Lane'));
  st := st || to_jsonb(pg_temp.mk(A, IA, 'AUS', 'Fixture a_b Row'));
  st := st || to_jsonb(pg_temp.mk(A, IA, 'AXB', 'Fixture aXb Row'));
  st := st || to_jsonb(pg_temp.mk(A, IA, 'ABS', 'Fixture back\slash Mews'));
  st := st || to_jsonb(pg_temp.mk(A, IA, 'ACS', 'MIXED Case Plaza 27', 'closed'));
  st := st || to_jsonb(pg_temp.mk(A, IA, 'ACUT', 'Fixture Long ' || repeat('road ', 47) || 'midmarker ' || repeat('lane ', 12) || 'tailmarker ' || repeat('end ', 4)));
  st := st || to_jsonb(pg_temp.mk(A, IA, 'AR', 'Removed Invented Rd 4111 1111 1111 1111'));
  -- lengths 298-303 and 338-343; each ends in a 4-letter tag
  FOREACH L IN ARRAY ARRAY[298, 299, 300, 301, 302, 303, 338, 339, 340, 341, 342, 343] LOOP
    tag := 'kq' || chr(97 + (L % 26)) || chr(97 + (L / 26 % 26));
    pre := 'Fixture Edge ';
    st := st || to_jsonb(pg_temp.mk(A, IA, 'AE' || L, pre || repeat('y', L - char_length(pre) - 5) || ' ' || tag));
  END LOOP;
  PERFORM pg_temp.rec('fx_remove_AR', pg_temp.deldeal(A, pg_temp.id('AR')) -> 'ok');

  -- B: ordinary addresses only (nothing the answer would mask, cut or strip)
  FOR i_n IN 1 .. 14 LOOP
    st := st || to_jsonb(pg_temp.mk(B, IB, 'B' || i_n,
      CASE i_n % 7 WHEN 0 THEN (20 + i_n) || ' Fixture Elm St, Springfield 98' || lpad(i_n::text, 3, '0')
                 WHEN 1 THEN (300 + i_n) || ' FIXTURE Oak Ave Apt ' || i_n
                 WHEN 2 THEN 'Fixture 10% Corner ' || i_n
                 WHEN 3 THEN 'Fixture under_score Ct ' || i_n
                 WHEN 4 THEN 'Fixture back\slash Way ' || i_n
                 WHEN 5 THEN 'Unit ' || i_n || '-' || (i_n + 2) || ' Fixture Pine Rd, ST 98' || lpad(i_n::text, 3, '0')
                 ELSE 'Fixture Birch ' || repeat('lane ', i_n) END,
      CASE i_n % 3 WHEN 0 THEN 'closed' WHEN 1 THEN 'active' ELSE 'pending' END));
  END LOOP;
  -- set directly: B's save times, distinct with ties (groups of 3 share one value)
  UPDATE public.cloud_deals d SET last_synced_at = now() - ((x.rn / 3) * interval '1 minute')
    FROM (SELECT id, row_number() OVER (ORDER BY id) AS rn FROM public.cloud_deals WHERE owner_user_id = B) x
   WHERE d.id = x.id;

  PERFORM pg_temp.rec('fx_statuses', (SELECT jsonb_object_agg(s, c) FROM (SELECT x AS s, count(*) c FROM jsonb_array_elements_text(st) x GROUP BY x) z));
  PERFORM pg_temp.rec('fx_counts', jsonb_build_object(
    'A_live', (SELECT count(*) FROM public.cloud_deals WHERE owner_user_id = A AND removed_at IS NULL AND is_confirmed),
    'B_live', (SELECT count(*) FROM public.cloud_deals WHERE owner_user_id = B AND removed_at IS NULL AND is_confirmed),
    'B_clean_differs', (SELECT count(*) FROM public.cloud_deals WHERE owner_user_id = B AND public._mcp_clean(property_address, 300) IS DISTINCT FROM property_address),
    'B_save_times', (SELECT count(DISTINCT last_synced_at) FROM public.cloud_deals WHERE owner_user_id = B),
    'A_lengths', (SELECT jsonb_agg(char_length(property_address) ORDER BY char_length(property_address)) FROM public.cloud_deals
                   WHERE owner_user_id = A AND char_length(property_address) > 290)));

  -- the portal secret (prev slot, this call only), MCP on, one read connection for A
  UPDATE public.mcp_settings SET portal_secret_prev_sha256 = sha256(convert_to(pg_temp.secret(), 'UTF8')), enabled = true WHERE id;
  INSERT INTO public.mcp_oauth_clients (client_id, client_name, redirect_uris, ip_sha256)
  VALUES (pg_temp.client(), 'Fixture app', ARRAY['https://claude.ai/api/mcp/auth_callback'], sha256(convert_to('pa-ip', 'UTF8')));
  PERFORM pg_temp.conn('KA', A, 1);
END
$fxa$;
