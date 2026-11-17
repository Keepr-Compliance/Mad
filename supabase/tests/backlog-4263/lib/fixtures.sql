-- BACKLOG-4263 fixtures (invented). Loaded after supabase/tests/backlog-4244/lib/helpers.sql, whose
-- pg_temp.fx(n) gives ids random per run.
--   users (one brokerage O, team plan with the assignable key on):
--     1 A Cloud on: A1 closed 2026-03-15 (full details, card number in the address), A2 on install I2
--       (hostile values: type, status and lock text over 20 characters with an invisible character;
--       sale_price, earnest_money_amount, commission_actual_rate as strings; listing_price,
--       commission_offered_rate, commission_gross_amount as 40-digit numbers; dates not dates),
--       A3 pending detection, A4 rejected, A5 deleted, A6 closed 2025-12-31 (the other half: the
--       string columns of A2 as 40-digit numbers and the reverse), A7 pending, found by Keepr, locked
--     2 B Cloud on: B1
--     4 D Cloud on, deal DD1, then settings.enabled false
--     6 F Cloud on: 420 deals with 78-character addresses (the byte bound binds)
--     7 G Cloud on: 600 deals with short addresses (the 500-row bound binds)
--   installs: 301 I1, 302 I2 (A), 303 (B), 306 (F), 307 (G)
--   AI-app tokens: a1 (A), ax (A, expired), b1, d1, f1, g1
CREATE TEMP TABLE p4263_fx (k text PRIMARY KEY, v text);
CREATE FUNCTION pg_temp.id(k text) RETURNS uuid LANGUAGE sql STABLE AS $h$ SELECT v::uuid FROM pg_temp.p4263_fx WHERE p4263_fx.k = id.k $h$;
CREATE FUNCTION pg_temp.put(k text, v text) RETURNS void LANGUAGE sql AS $h$
  INSERT INTO pg_temp.p4263_fx VALUES (k, v) ON CONFLICT (k) DO UPDATE SET v = excluded.v
$h$;
CREATE FUNCTION pg_temp.dp(inst uuid, lid text, extra jsonb DEFAULT '{}') RETURNS jsonb LANGUAGE sql IMMUTABLE AS $h$
  SELECT jsonb_build_object('source_install_id', inst, 'local_id', lid, 'content_hash', pg_temp.h(lid || extra::text),
                            'detection_status', 'confirmed', 'detection_source', 'manual', 'status', 'active') || extra
$h$;
-- list_all_deals as anon (counters cleared first, as pg_temp.anon does)
CREATE FUNCTION pg_temp.la(k text, st text DEFAULT NULL, cf text DEFAULT NULL, ct text DEFAULT NULL, cur text DEFAULT NULL,
                           s text DEFAULT '__SECRET__') RETURNS text LANGUAGE sql AS $h$
  SELECT pg_temp.anon(format('SELECT public.mcp_list_all_deals(%L, decode(%L, %L), %L, %L, %L, %L, %L)',
         s, encode(pg_temp.dg(k), 'hex'), 'hex', pg_temp.res(), st, cf, ct, cur))
$h$;
-- the same call without clearing the rate counters
CREATE FUNCTION pg_temp.la_raw(k text) RETURNS text LANGUAGE sql AS $h$
  SELECT pg_temp.call_as(NULL, format('SELECT public.mcp_list_all_deals(%L, decode(%L, %L), %L, NULL, NULL, NULL, NULL)',
         '__SECRET__', encode(pg_temp.dg(k), 'hex'), 'hex', pg_temp.res()), 'anon')
$h$;
-- deal ids in a list_all_deals result, in order
CREATE FUNCTION pg_temp.aids(t text) RETURNS uuid[] LANGUAGE sql IMMUTABLE AS $h$
  SELECT coalesce(array_agg((x ->> 0)::uuid ORDER BY o), ARRAY[]::uuid[])
    FROM jsonb_array_elements(coalesce(pg_temp.res_of(t) -> 'rows', '[]'::jsonb)) WITH ORDINALITY y(x, o)
$h$;
CREATE FUNCTION pg_temp.arow(t text, id uuid) RETURNS jsonb LANGUAGE sql IMMUTABLE AS $h$
  SELECT x FROM jsonb_array_elements(coalesce(pg_temp.res_of(t) -> 'rows', '[]'::jsonb)) x WHERE (x ->> 0)::uuid = id
$h$;
-- bytes the rows of a result count against the bound: sum of (octet_length(row::text) + 2)
CREATE FUNCTION pg_temp.rbytes(t text) RETURNS bigint LANGUAGE sql IMMUTABLE AS $h$
  SELECT coalesce(sum(octet_length(x::text) + 2), 0) FROM jsonb_array_elements(coalesce(pg_temp.res_of(t) -> 'rows', '[]'::jsonb)) x
$h$;
CREATE FUNCTION pg_temp.ncur(t text) RETURNS text LANGUAGE sql IMMUTABLE AS $h$
  SELECT pg_temp.res_of(t) -> 'page' ->> 'next_cursor'
$h$;
-- confirmed deal ids of user u, in id order (the expected set)
CREATE FUNCTION pg_temp.owned(u uuid) RETURNS uuid[] LANGUAGE sql STABLE AS $h$
  SELECT coalesce(array_agg(d.id ORDER BY d.id), ARRAY[]::uuid[]) FROM public.cloud_deals d WHERE d.owner_user_id = u AND d.is_confirmed
$h$;
-- every page from the start: {ids (in order, repeats kept), pages, max_frame, max_rows_bytes, min_rows, err}
CREATE FUNCTION pg_temp.walk(k text) RETURNS jsonb LANGUAGE plpgsql AS $h$
DECLARE t text; cur text := NULL; ids uuid[] := ARRAY[]::uuid[]; n int := 0; mf int := 0; mb bigint := 0; mr int := 1000000;
BEGIN
  LOOP
    t := pg_temp.la(k, NULL, NULL, NULL, cur);
    n := n + 1;
    IF pg_temp.err(t) <> 'OK' THEN RETURN jsonb_build_object('err', pg_temp.err(t), 'pages', n); END IF;
    ids := ids || pg_temp.aids(t);
    mf := greatest(mf, octet_length((pg_temp.res_of(t))::text));
    mb := greatest(mb, pg_temp.rbytes(t));
    mr := least(mr, cardinality(pg_temp.aids(t)));
    cur := pg_temp.ncur(t);
    EXIT WHEN cur IS NULL OR n >= 20;
  END LOOP;
  RETURN jsonb_build_object('ids', to_jsonb(ids), 'pages', n, 'max_frame', mf, 'max_rows_bytes', mb, 'min_rows', mr, 'err', 'OK');
END $h$;

CREATE FUNCTION pg_temp.base4263() RETURNS jsonb LANGUAGE plpgsql AS $h$
DECLARE A uuid := pg_temp.fx(1); B uuid := pg_temp.fx(2); D uuid := pg_temp.fx(4); F uuid := pg_temp.fx(6); G uuid := pg_temp.fx(7);
        O uuid := pg_temp.fx(101); I1 uuid := pg_temp.fx(301); I2 uuid := pg_temp.fx(302);
        t text; dd uuid; out jsonb := '{}';
BEGIN
  UPDATE public.mcp_settings SET enabled = true, portal_secret_sha256 = sha256(convert_to(pg_temp.sec(), 'UTF8')), portal_secret_prev_sha256 = NULL WHERE id;
  SET LOCAL session_replication_role = replica;
  INSERT INTO auth.users (id, email, aud, role, instance_id, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
  SELECT pg_temp.fx(x), 'p4263-' || substr(md5('__RUN__'), 1, 8) || '-' || x || '@example.test', 'authenticated', 'authenticated',
         '00000000-0000-0000-0000-000000000000', '{"provider":"email"}', '{}', now(), now()
    FROM unnest(ARRAY[1, 2, 4, 6, 7]) x;
  INSERT INTO public.users (id, email, oauth_provider, oauth_id, display_name)
  SELECT pg_temp.fx(x), 'p4263-' || substr(md5('__RUN__'), 1, 8) || '-' || x || '@example.test', 'email', pg_temp.fx(x)::text, 'Fixture user ' || x
    FROM unnest(ARRAY[1, 2, 4, 6, 7]) x ON CONFLICT (id) DO NOTHING;
  INSERT INTO public.organizations (id, name, slug, personal_owner_user_id) VALUES
    (O, 'Fixture O', 'p4263-o-' || substr(md5('__RUN__'), 1, 8), NULL);
  INSERT INTO public.organization_members (id, organization_id, user_id, role, license_status)
  SELECT pg_temp.fx(200 + x), O, pg_temp.fx(x), 'agent', 'active' FROM unnest(ARRAY[1, 2, 4, 6, 7]) x;
  INSERT INTO public.organization_plans (organization_id, plan_id, feature_overrides)
  SELECT O, (SELECT id FROM public.plans WHERE tier = 'team' ORDER BY sort_order, name LIMIT 1), '{"cloud_autosave_assignable":{"enabled":true}}'::jsonb;
  SET LOCAL session_replication_role = origin;

  FOREACH dd IN ARRAY ARRAY[A, B, D, F, G] LOOP
    out := out || jsonb_build_object('assign_' || dd, pg_temp.err(pg_temp.assign(O, dd, true)), 'on_' || dd, pg_temp.err(pg_temp.onoff(dd, true)));
  END LOOP;

  t := pg_temp.deal(A, pg_temp.dp(I1, 'a1', jsonb_build_object(
         'property_address', '1847 Alder Ridge Ln Unit 4111 1111 1111 1111, Fernhollow, WA 98999', 'transaction_type', 'purchase',
         'status', 'closed', 'started_at', '2026-01-05T00:00:00.000Z', 'closed_at', '2026-03-15T18:00:00.000Z', 'organization_id', O,
         'details', jsonb_build_object('v', 1, 'listing_price', 625000, 'sale_price', 612000, 'earnest_money_amount', 10000,
           'commission_offered_rate', 2.5, 'commission_actual_rate', 2.75, 'commission_gross_amount', 16830.5,
           'mutual_acceptance_date', '2026-02-01', 'closing_deadline', '2026-03-14', 'inspection_deadline', '2026-02-10',
           'stage', 'closed', 'zz_extra_key', 'not returned'))));
  PERFORM pg_temp.put('A1', pg_temp.cid(t)::text); out := out || jsonb_build_object('A1', pg_temp.st(t));
  t := pg_temp.deal(A, pg_temp.dp(I2, 'a2', jsonb_build_object('property_address', '52 Cobble Wren Ct, Larchmont Bay, WA 98998',
         'transaction_type', 'sa' || chr(8203) || 'le-' || repeat('t', 60), 'status', 'act' || chr(8238) || 'ive-' || repeat('s', 60),
         'lock_reason', 'sub' || chr(173) || 'mitted-' || repeat('l', 60),
         'details', jsonb_build_object('v', 1, 'sale_price', '4111 1111 1111 1111', 'listing_price', 1234567890123456789012345678901234567890::numeric,
           'earnest_money_amount', '5000', 'commission_offered_rate', 1234567890123456789012345678901234567890::numeric,
           'commission_actual_rate', '2.5', 'commission_gross_amount', 1234567890123456789012345678901234567890::numeric,
           'closing_deadline', 'soon', 'mutual_acceptance_date', 20261201))));
  PERFORM pg_temp.put('A2', pg_temp.cid(t)::text); out := out || jsonb_build_object('A2', pg_temp.st(t));
  t := pg_temp.deal(A, pg_temp.dp(I1, 'a3', jsonb_build_object('property_address', '77 Heron Spit Way, Fernhollow, WA 98999',
         'detection_status', 'pending', 'detection_source', 'auto')));
  PERFORM pg_temp.put('A3', pg_temp.cid(t)::text); out := out || jsonb_build_object('A3', pg_temp.st(t));
  t := pg_temp.deal(A, pg_temp.dp(I1, 'a4', jsonb_build_object('property_address', '410 Gull Point Rd, Larchmont Bay, WA 98998', 'status', 'rejected')));
  PERFORM pg_temp.put('A4', pg_temp.cid(t)::text); out := out || jsonb_build_object('A4', pg_temp.st(t));
  t := pg_temp.deal(A, pg_temp.dp(I1, 'a5', jsonb_build_object('property_address', '15 Old Mill Cut, Larchmont Bay, WA 98998')));
  PERFORM pg_temp.put('A5', pg_temp.cid(t)::text);
  out := out || jsonb_build_object('A5', pg_temp.st(t), 'del_A5', pg_temp.err(pg_temp.deldeal(A, pg_temp.id('A5'))));
  t := pg_temp.deal(A, pg_temp.dp(I1, 'a6', jsonb_build_object('property_address', '9 Thistle Gap Rd, Fernhollow, WA 98999', 'status', 'closed',
         'transaction_type', 'purchase', 'closed_at', '2025-12-31T23:30:00.000Z', 'details', jsonb_build_object('v', 1,
           'sale_price', 1234567890123456789012345678901234567890::numeric, 'listing_price', '480000', 'earnest_money_amount', 1234567890123456789012345678901234567890::numeric,
           'commission_offered_rate', '2.5', 'commission_actual_rate', 1234567890123456789012345678901234567890::numeric, 'commission_gross_amount', '12000'))));
  PERFORM pg_temp.put('A6', pg_temp.cid(t)::text); out := out || jsonb_build_object('A6', pg_temp.st(t));
  t := pg_temp.deal(A, pg_temp.dp(I1, 'a7', jsonb_build_object('property_address', '300 Quarry Bend Ave, Larchmont Bay, WA 98998', 'status', 'pending',
         'detection_source', 'auto', 'lock_reason', 'submitted')));
  PERFORM pg_temp.put('A7', pg_temp.cid(t)::text); out := out || jsonb_build_object('A7', pg_temp.st(t));
  -- creation order of A's installs: I1 first, then I2 (saved_from numbering)
  UPDATE public.cloud_deals x SET created_at = now() - CASE WHEN x.source_install_id = I1 THEN interval '2 days' ELSE interval '1 day' END
   WHERE x.owner_user_id = A;

  t := pg_temp.deal(B, pg_temp.dp(pg_temp.fx(303), 'b1', jsonb_build_object('property_address', '8 Fixture Lane, Larchmont Bay, WA 98998', 'status', 'closed',
         'closed_at', '2026-03-15T12:00:00.000Z', 'details', jsonb_build_object('v', 1, 'sale_price', 999999))));
  PERFORM pg_temp.put('B1', pg_temp.cid(t)::text); out := out || jsonb_build_object('B1', pg_temp.st(t));

  t := pg_temp.deal(D, pg_temp.dp(I1, 'dd1', jsonb_build_object('property_address', '6 Switched Off Ct, Fernhollow, WA 98999')));
  out := out || jsonb_build_object('DD1', pg_temp.st(t));
  UPDATE public.cloud_autosave_settings SET enabled = false WHERE user_id = D;

  -- F and G: one deal through the write function, then copies of its row (set-based) with new ids
  t := pg_temp.deal(F, pg_temp.dp(pg_temp.fx(306), 'f0', jsonb_build_object('property_address', '1000 Northwest Longfellow Avenue Unit 10, Bellevue, WA 98004',
         'transaction_type', 'purchase', 'status', 'closed', 'started_at', '2025-01-02T00:00:00.000Z', 'closed_at', '2025-03-04T00:00:00.000Z',
         'detection_source', 'auto', 'details', jsonb_build_object('v', 1, 'listing_price', 650000, 'sale_price', 645000, 'earnest_money_amount', 10000,
           'commission_offered_rate', 2.5, 'commission_actual_rate', 2.75, 'commission_gross_amount', 16125.5,
           'mutual_acceptance_date', '2025-01-10', 'closing_deadline', '2025-03-01'))));
  out := out || jsonb_build_object('F0', pg_temp.st(t));
  INSERT INTO public.cloud_deals (owner_user_id, source_install_id, local_transaction_id, property_address, transaction_type, status, started_at, closed_at,
                                  detection_status, detection_source, details, is_confirmed, content_hash, last_synced_at, created_at)
  SELECT d.owner_user_id, d.source_install_id, 'f' || gs, (1000 + gs)::text || ' Northwest Longfellow Avenue Unit ' || lpad((gs % 40)::text, 2, '0') || ', Bellevue, WA 98004',
         d.transaction_type, d.status, d.started_at, d.closed_at, d.detection_status, d.detection_source,
         d.details || jsonb_build_object('sale_price', 645000 + gs * 131), true, d.content_hash, d.last_synced_at, d.created_at
    FROM public.cloud_deals d, generate_series(1, 419) gs WHERE d.owner_user_id = F;
  t := pg_temp.deal(G, pg_temp.dp(pg_temp.fx(307), 'g0', jsonb_build_object('property_address', '1 A St')));
  out := out || jsonb_build_object('G0', pg_temp.st(t));
  INSERT INTO public.cloud_deals (owner_user_id, source_install_id, local_transaction_id, property_address, status, detection_status, detection_source,
                                  details, is_confirmed, content_hash, last_synced_at, created_at)
  SELECT d.owner_user_id, d.source_install_id, 'g' || gs, gs || ' A St', d.status, d.detection_status, d.detection_source, d.details, true,
         d.content_hash, d.last_synced_at, d.created_at
    FROM public.cloud_deals d, generate_series(1, 599) gs WHERE d.owner_user_id = G;
  out := out || jsonb_build_object('F_n', (SELECT count(*) FROM public.cloud_deals WHERE owner_user_id = F),
                                   'G_n', (SELECT count(*) FROM public.cloud_deals WHERE owner_user_id = G));

  PERFORM pg_temp.put('CONN_A1', pg_temp.conn(A, 'a1')::text);
  PERFORM pg_temp.conn(A, 'ax', 'anthropic', true);
  PERFORM pg_temp.conn(B, 'b1'); PERFORM pg_temp.conn(D, 'd1'); PERFORM pg_temp.conn(F, 'f1'); PERFORM pg_temp.conn(G, 'g1');
  RETURN out;
END $h$;
