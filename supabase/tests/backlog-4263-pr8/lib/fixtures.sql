-- BACKLOG-4263 PR-8 harness: helpers and fixtures, loaded BEFORE the migration (inside the same rolled-back call).
-- Every id, name, address, email, phone and secret is invented and derived from 'pr8-harness'; phone numbers are in
-- the range reserved for fiction. Rows of the reserved account and of the live AI-app connection are never read or
-- written. The portal secret is a fixture value put in mcp_settings.portal_secret_prev_sha256 for this call only.
-- Deals, people, checklists and todos come from the real producers (cloud_upsert_deal, cloud_upsert_parties,
-- cloud_tombstone, cloud_todo_push, cloud_delete_deal). Set directly, each named where it is done:
--   cloud_deals.lock_reason (written by the desktop's deal upload; as PR-5's fixtures do);
--   the id of four people (any uuid is a value the producer can give; these are chosen to be the smallest ids so the
--   contact_ref rules are tested deterministically);
--   one todo's is_checked set to NULL: the column is nullable; the one-way item upload of 20261118110000
--   (cloud_upsert_checklist_items, dropped by 20261118120000) wrote (r ->> 'is_checked')::boolean, NULL when the field
--   was absent; no current producer writes NULL, and the test project holds no such row (measured below).

CREATE TEMP TABLE p8_out (o serial, k text, v jsonb);
CREATE FUNCTION pg_temp.rec(k text, v jsonb) RETURNS void LANGUAGE sql AS $h$ INSERT INTO pg_temp.p8_out (k, v) VALUES (k, v) $h$;
CREATE TEMP TABLE p8_fx (k text PRIMARY KEY, v text);
CREATE FUNCTION pg_temp.id(k text) RETURNS uuid LANGUAGE sql STABLE AS $h$ SELECT v::uuid FROM pg_temp.p8_fx WHERE p8_fx.k = id.k $h$;
CREATE FUNCTION pg_temp.fxv(k text) RETURNS text LANGUAGE sql STABLE AS $h$ SELECT v FROM pg_temp.p8_fx WHERE p8_fx.k = fxv.k $h$;
CREATE FUNCTION pg_temp.put(k text, v text) RETURNS void LANGUAGE sql AS $h$
  INSERT INTO pg_temp.p8_fx VALUES (k, v) ON CONFLICT (k) DO UPDATE SET v = excluded.v $h$;
-- a small id: 00000000-0000-4000-8000-<n, 12 digits>
CREATE FUNCTION pg_temp.small(n int) RETURNS uuid LANGUAGE sql IMMUTABLE AS $h$
  SELECT ('00000000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid $h$;

CREATE FUNCTION pg_temp.secret() RETURNS text LANGUAGE sql IMMUTABLE AS $h$ SELECT 'p8-fixture-portal-secret-' || md5('pr8-harness') $h$;
CREATE FUNCTION pg_temp.res() RETURNS text LANGUAGE sql IMMUTABLE AS $h$ SELECT 'https://p8-fixture.example.test/api/mcp' $h$;
CREATE FUNCTION pg_temp.dg(n int) RETURNS bytea LANGUAGE sql IMMUTABLE AS $h$ SELECT sha256(convert_to('p8-at-' || md5('pr8-harness') || n, 'UTF8')) $h$;
CREATE FUNCTION pg_temp.dgl(n int) RETURNS text LANGUAGE sql IMMUTABLE AS $h$ SELECT '\x' || encode(pg_temp.dg(n), 'hex') $h$;
CREATE FUNCTION pg_temp.client() RETURNS text LANGUAGE sql IMMUTABLE AS $h$ SELECT 'kpr_c_' || substr(md5('pr8-harness-client'), 1, 22) $h$;

-- a connection with an access token (digest n)
CREATE FUNCTION pg_temp.conn(k text, u uuid, n int) RETURNS uuid LANGUAGE plpgsql AS $h$
DECLARE v uuid := md5('pr8-harness-conn-' || k)::uuid;
BEGIN
  INSERT INTO public.mcp_connections (id, user_id, client_id, provider, client_name, redirect_uri, resource, scope, notice_version, status, activated_at)
  VALUES (v, u, pg_temp.client(), 'anthropic', 'Fixture app', 'https://claude.ai/api/mcp/auth_callback', pg_temp.res(), 'mcp:read', 1, 'active', now());
  INSERT INTO public.mcp_tokens (token_sha256, connection_id, kind, pepper_version, expires_at) VALUES
    (sha256(pg_temp.dg(n)), v, 'access', (SELECT pepper_version FROM public.mcp_settings WHERE id), now() + interval '1 hour');
  PERFORM pg_temp.put(k, v::text);
  RETURN v;
END $h$;

-- desktop ops (the shapes PR-4a's sender sends)
CREATE FUNCTION pg_temp.cc(dl uuid, lid text, tpl text, name text, so int) RETURNS jsonb LANGUAGE sql VOLATILE AS $h$
  SELECT jsonb_build_object('op_id', gen_random_uuid(), 'kind', 'create_checklist', 'deal_id', dl, 'local_id', lid, 'template_id', tpl,
    'template_name', name, 'sort_order', so, 'is_private', tpl = 'keepr:my-items', 'edited_at', pg_temp.nowt()) $h$;
CREATE FUNCTION pg_temp.ci(dl uuid, cl text, lid text, title text, so int, req boolean DEFAULT false, note text DEFAULT NULL,
                           due text DEFAULT NULL, done boolean DEFAULT false) RETURNS jsonb LANGUAGE sql VOLATILE AS $h$
  SELECT jsonb_build_object('op_id', gen_random_uuid(), 'kind', 'create_item', 'deal_id', dl, 'checklist_local_id', cl,
    'local_id', lid, 'title', title, 'is_required', req, 'done', jsonb_build_object('is_checked', done, 'checked_at', CASE WHEN done THEN pg_temp.nowt() END),
    'sort_order', so, 'edit_seq', 1, 'edited_at', pg_temp.nowt(), 'note', note, 'due_date', due) $h$;
CREATE FUNCTION pg_temp.op(kind text, ent text, id uuid) RETURNS jsonb LANGUAGE sql VOLATILE AS $h$
  SELECT jsonb_build_object('op_id', gen_random_uuid(), 'kind', kind, 'entity', ent, 'id', id, 'edited_at', pg_temp.nowt())
$h$;
CREATE FUNCTION pg_temp.item_of(dl uuid, lid text) RETURNS uuid LANGUAGE sql STABLE AS $h$
  SELECT id FROM public.cloud_deal_checklist_items WHERE cloud_deal_id = dl AND local_item_id = lid
$h$;
CREATE FUNCTION pg_temp.cl_of(dl uuid, lid text) RETURNS uuid LANGUAGE sql STABLE AS $h$
  SELECT id FROM public.cloud_deal_checklists WHERE cloud_deal_id = dl AND local_checklist_id = lid
$h$;
CREATE FUNCTION pg_temp.party_of(dl uuid, lid text) RETURNS uuid LANGUAGE sql STABLE AS $h$
  SELECT id FROM public.cloud_deal_parties WHERE cloud_deal_id = dl AND local_party_id = lid
$h$;
-- one party row as the desktop sends it (buildPartyDto): the 14 hashed fields; a withheld person has name, company,
-- emails and phones blanked
CREATE FUNCTION pg_temp.pty(lid text, contact text, name text, company text, role text, cat text, spec text,
                            emails jsonb DEFAULT '[]', phones jsonb DEFAULT '[]', notes text DEFAULT NULL, withheld boolean DEFAULT false,
                            prim boolean DEFAULT false) RETURNS jsonb LANGUAGE sql IMMUTABLE AS $h$
  SELECT pg_temp.rw(lid, jsonb_build_object(
    'local_contact_id', contact, 'role', role, 'role_category', cat, 'specific_role', spec, 'is_primary', prim, 'notes', notes,
    'display_name', CASE WHEN withheld THEN NULL ELSE name END, 'company', CASE WHEN withheld THEN NULL ELSE company END,
    'emails', CASE WHEN withheld THEN '[]'::jsonb ELSE emails END, 'phones', CASE WHEN withheld THEN '[]'::jsonb ELSE phones END,
    'contact_source', CASE WHEN withheld THEN 'google_contacts' ELSE 'manual' END, 'contact_deleted', false, 'removed_reason', NULL,
    'details_withheld', withheld))
$h$;
CREATE FUNCTION pg_temp.em(e text, prim boolean DEFAULT true) RETURNS jsonb LANGUAGE sql IMMUTABLE AS $h$
  SELECT jsonb_build_object('email', e, 'is_primary', prim, 'label', 'work') $h$;
CREATE FUNCTION pg_temp.ph(e text, disp text, prim boolean DEFAULT true) RETURNS jsonb LANGUAGE sql IMMUTABLE AS $h$
  SELECT jsonb_build_object('e164', e, 'display', disp, 'is_primary', prim, 'label', 'mobile') $h$;

-- ================================================================ what is stored on the test project (counts only)
DO $measure8$
BEGIN
  PERFORM pg_temp.rec('measure_ledger_4263', (SELECT coalesce(jsonb_agg(version ORDER BY version), '[]') FROM supabase_migrations.schema_migrations
                                               WHERE version IN ('20261118100000', '20261118110000', '20261118120000', '20261118130000', '20261118140000', '20261118150000')));
  PERFORM pg_temp.rec('measure_mcp_enabled', to_jsonb((SELECT enabled FROM public.mcp_settings WHERE id)));
  PERFORM pg_temp.rec('measure_parties', (SELECT jsonb_build_object(
      'rows', count(*),
      'local_contact_id_null', count(*) FILTER (WHERE local_contact_id IS NULL),
      'role_null', count(*) FILTER (WHERE role IS NULL),
      'role_snake', count(*) FILTER (WHERE role ~ '^[a-z_]{2,40}$'),
      'role_other', count(*) FILTER (WHERE role IS NOT NULL AND role !~ '^[a-z_]{2,40}$'),
      'role_category_snake', count(*) FILTER (WHERE role_category ~ '^[a-z_]{2,40}$'),
      'role_category_other', count(*) FILTER (WHERE role_category IS NOT NULL AND role_category !~ '^[a-z_]{2,40}$'),
      'specific_role_snake', count(*) FILTER (WHERE specific_role ~ '^[a-z_]{2,40}$'),
      'specific_role_other', count(*) FILTER (WHERE specific_role IS NOT NULL AND specific_role !~ '^[a-z_]{2,40}$'),
      'role_values_distinct', count(DISTINCT role)) FROM public.cloud_deal_parties));
  PERFORM pg_temp.rec('measure_phones', (SELECT jsonb_build_object(
      'elements', count(*),
      'e164_plus_digits', count(*) FILTER (WHERE jsonb_typeof(el -> 'e164') = 'string' AND el ->> 'e164' ~ '^\+[1-9][0-9]{7,14}$'),
      'e164_empty', count(*) FILTER (WHERE el ->> 'e164' = ''),
      'e164_other', count(*) FILTER (WHERE jsonb_typeof(el -> 'e164') = 'string' AND el ->> 'e164' <> '' AND el ->> 'e164' !~ '^\+[1-9][0-9]{7,14}$'),
      'e164_not_string', count(*) FILTER (WHERE jsonb_typeof(el -> 'e164') IS DISTINCT FROM 'string'))
    FROM public.cloud_deal_parties p, jsonb_array_elements(CASE WHEN jsonb_typeof(p.phones) = 'array' THEN p.phones ELSE '[]'::jsonb END) el));
  PERFORM pg_temp.rec('measure_emails', (SELECT jsonb_build_object(
      'elements', count(*),
      'one_at', count(*) FILTER (WHERE el ->> 'email' ~ '^[^@[:space:]]+@[^@[:space:]]+$'),
      'other', count(*) FILTER (WHERE el ->> 'email' IS NULL OR el ->> 'email' !~ '^[^@[:space:]]+@[^@[:space:]]+$'))
    FROM public.cloud_deal_parties p, jsonb_array_elements(CASE WHEN jsonb_typeof(p.emails) = 'array' THEN p.emails ELSE '[]'::jsonb END) el));
  PERFORM pg_temp.rec('measure_items', (SELECT jsonb_build_object('rows', count(*), 'is_checked_null', count(*) FILTER (WHERE is_checked IS NULL),
      'due_date_set', count(*) FILTER (WHERE due_date IS NOT NULL)) FROM public.cloud_deal_checklist_items));
  PERFORM pg_temp.rec('measure_call_log_rows', to_jsonb((SELECT count(*) FROM public.mcp_call_log)));
END
$measure8$;

-- ================================================================ fixtures
DO $fx8$
DECLARE A uuid := pg_temp.fx(1); B uuid := pg_temp.fx(2); C uuid := pg_temp.fx(3); O uuid := pg_temp.fx(101);
        IA uuid := pg_temp.fx(301); IB uuid := pg_temp.fx(302); IA2 uuid := pg_temp.fx(303);
        r jsonb; k text; i_n int; ops jsonb; worst text := repeat('"' || chr(119070), 150);
BEGIN
  SET LOCAL session_replication_role = replica;
  INSERT INTO auth.users (id, email, aud, role, instance_id, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
  SELECT pg_temp.fx(n), 'p4263-' || substr(md5('pr8-harness'), 1, 8) || '-' || n || '@example.test', 'authenticated', 'authenticated',
         '00000000-0000-0000-0000-000000000000', '{"provider":"email"}', '{}', now(), now() FROM generate_series(1, 3) n;
  INSERT INTO public.users (id, email, oauth_provider, oauth_id, display_name)
  SELECT pg_temp.fx(n), 'p4263-' || substr(md5('pr8-harness'), 1, 8) || '-' || n || '@example.test', 'email', pg_temp.fx(n)::text, 'Fixture ' || n
    FROM generate_series(1, 3) n ON CONFLICT (id) DO NOTHING;
  INSERT INTO public.organizations (id, name, slug) VALUES (O, 'Fixture O', 'p4263-o-' || substr(md5('pr8-harness'), 1, 8));
  INSERT INTO public.organization_members (id, organization_id, user_id, role, license_status) VALUES
    (pg_temp.fx(201), O, A, 'agent', 'active'), (pg_temp.fx(202), O, B, 'agent', 'active'), (pg_temp.fx(203), O, C, 'agent', 'active');
  INSERT INTO public.organization_plans (organization_id, plan_id, feature_overrides)
  SELECT O, (SELECT id FROM public.plans WHERE tier = 'team' ORDER BY sort_order, name LIMIT 1), '{"cloud_autosave_assignable":{"enabled":true}}'::jsonb;
  SET LOCAL session_replication_role = origin;
  PERFORM pg_temp.assign(O, A);
  PERFORM pg_temp.rec('fx_on_A', pg_temp.onoff(A, true) -> 'success');
  PERFORM pg_temp.assign(O, B);
  PERFORM pg_temp.rec('fx_on_B', pg_temp.onoff(B, true) -> 'success');
  PERFORM pg_temp.put('A', A::text); PERFORM pg_temp.put('B', B::text); PERFORM pg_temp.put('C', C::text);
  PERFORM pg_temp.put('IA', IA::text); PERFORM pg_temp.put('IB', IB::text); PERFORM pg_temp.put('IA2', IA2::text);

  -- deals of A: DA1 live, DA2 closed, DA3 locked later, DA4 not confirmed, DA5 removed later, DA8 many people,
  -- DA9 longest people, DT 31 checklists, DP many long todos, DW longest todo, DPH one person per stored phone form;
  -- DA7 from a second computer (IA2)
  FOREACH k IN ARRAY ARRAY['DA1', 'DA2', 'DA3', 'DA4', 'DA5', 'DA8', 'DA9', 'DT', 'DP', 'DW', 'DPH'] LOOP
    r := pg_temp.deal(A, pg_temp.dp(IA, lower(k), CASE k WHEN 'DA4' THEN '{"detection_status":"rejected"}'::jsonb
                                                        WHEN 'DA2' THEN '{"status":"closed"}'::jsonb
                                                        WHEN 'DW' THEN jsonb_build_object('property_address', worst || worst || worst)
                                                        ELSE '{}'::jsonb END));
    PERFORM pg_temp.put(k, r -> 'results' -> 0 ->> 'cloud_id');
  END LOOP;
  r := pg_temp.deal(A, pg_temp.dp(IA2, 'da7')); PERFORM pg_temp.put('DA7', r -> 'results' -> 0 ->> 'cloud_id');
  r := pg_temp.deal(B, pg_temp.dp(IB, 'db1')); PERFORM pg_temp.put('DB1', r -> 'results' -> 0 ->> 'cloud_id');
  PERFORM pg_temp.rec('fx_deals', to_jsonb((SELECT count(*) FROM pg_temp.p8_fx f WHERE f.k LIKE 'D%' AND f.v IS NOT NULL)));

  -- people
  r := pg_temp.up(A, 'cloud_upsert_parties', IA, pg_temp.id('DA1'), jsonb_build_array(
         pg_temp.pty('pat', 'c1', 'Pat fixture lender', 'First fixture bank', 'lender', 'lending', 'lender',
                     jsonb_build_array(pg_temp.em('Pat.Lender@Example.test')), jsonb_build_array(pg_temp.ph('+12125550101', '(212) 555-0101')), 'Prefers email', false, true),
         pg_temp.pty('sam', 'c2', 'Sam fixture agent', NULL, 'agent', 'agent', 'agent',
                     jsonb_build_array(pg_temp.em('sam@example.test')), jsonb_build_array(pg_temp.ph('+447700900123', '07700 900123'))),
         pg_temp.pty('wh', 'c3', NULL, NULL, 'client', 'client', 'client', '[]', '[]', 'Withheld note 123-45-6789', true),
         pg_temp.pty('card', 'c4', 'Casey fixture', 'Card 4111 1111 1111 1111 Ltd', 'inspector', 'inspection', 'inspector'),
         pg_temp.pty('pct', NULL, 'Ann 100%_Sure fixture', NULL, 'other', 'support', 'other'),
         pg_temp.pty('nul2', NULL, 'Nell fixture', NULL, 'other', 'support', 'other', '[]', jsonb_build_array(pg_temp.ph('2125550102', '212-555-0102'))),
         pg_temp.pty('many', 'c6', 'Mona fixture', NULL, 'appraiser', 'inspection', 'appraiser',
                     jsonb_build_array(to_jsonb('scalar@example.test'::text), jsonb_build_object('email', 5))
                       || (SELECT jsonb_agg(pg_temp.em('m' || g || '@example.test', false) ORDER BY g) FROM generate_series(3, 10) g)
                       || jsonb_build_array(pg_temp.em('eleventh@example.test', false)),
                     (SELECT jsonb_agg(pg_temp.ph('+1212555011' || (g % 10), NULL, false) ORDER BY g) FROM generate_series(1, 10) g)
                       || jsonb_build_array(pg_temp.ph('+12125550199', NULL, false))),
         pg_temp.pty('rm', 'c1', 'Pat fixture lender', NULL, 'lender', 'lending', 'lender')));
  PERFORM pg_temp.rec('fx_parties_DA1', (SELECT jsonb_agg(DISTINCT x ->> 'status') FROM jsonb_array_elements(r -> 'results') x));
  r := pg_temp.up(A, 'cloud_upsert_parties', IA, pg_temp.id('DA2'), jsonb_build_array(
         pg_temp.pty('pat2', 'c1', 'Pat fixture lender', 'First fixture bank', 'lender', 'lending', 'lender',
                     jsonb_build_array(pg_temp.em('pat.lender@example.test')), jsonb_build_array(pg_temp.ph('+12125550101', NULL)))));
  r := pg_temp.up(A, 'cloud_upsert_parties', IA, pg_temp.id('DA4'), jsonb_build_array(
         pg_temp.pty('pat4', 'c1', 'Pat fixture lender', NULL, 'lender', 'lending', 'lender', jsonb_build_array(pg_temp.em('pat.lender@example.test')))));
  r := pg_temp.up(A, 'cloud_upsert_parties', IA, pg_temp.id('DA5'), jsonb_build_array(
         pg_temp.pty('pat5', 'c1', 'Pat fixture lender', NULL, 'lender', 'lending', 'lender', jsonb_build_array(pg_temp.em('pat.lender@example.test')))));
  r := pg_temp.up(A, 'cloud_upsert_parties', IA2, pg_temp.id('DA7'), jsonb_build_array(
         pg_temp.pty('pat7', 'c1', 'Pat fixture lender', NULL, 'lender', 'lending', 'lender', jsonb_build_array(pg_temp.em('pat.lender@example.test')))));
  r := pg_temp.up(A, 'cloud_upsert_parties', IA, pg_temp.id('DA8'),
         (SELECT jsonb_agg(pg_temp.pty('pg' || lpad(g::text, 3, '0'), NULL, 'Page person ' || g, NULL, 'transaction_coordinator', 'support', 'transaction_coordinator') ORDER BY g)
            FROM generate_series(1, 110) g));
  PERFORM pg_temp.rec('fx_parties_DA8', (SELECT jsonb_build_object('n', jsonb_array_length(r -> 'results'), 'st', jsonb_agg(DISTINCT x ->> 'status')) FROM jsonb_array_elements(r -> 'results') x));
  r := pg_temp.up(A, 'cloud_upsert_parties', IA, pg_temp.id('DA9'),
         (SELECT jsonb_agg(pg_temp.pty('w' || g, 'cw' || g, worst || worst, worst || worst, repeat('"', 150), repeat('"', 150), repeat('"', 150),
                    (SELECT jsonb_agg(jsonb_build_object('email', repeat(chr(119070), 400), 'is_primary', false, 'label', repeat('"', 80))) FROM generate_series(1, 10)),
                    (SELECT jsonb_agg(jsonb_build_object('e164', repeat(chr(119070), 60), 'display', repeat(chr(119070), 60), 'is_primary', false, 'label', repeat('"', 80))) FROM generate_series(1, 10)),
                    repeat('"' || chr(119070), 800)) ORDER BY g) FROM generate_series(1, 3) g));
  -- one person per stored phone form: with or without +, 10, 11 or 12 digits
  r := pg_temp.up(A, 'cloud_upsert_parties', IA, pg_temp.id('DPH'), jsonb_build_array(
         pg_temp.pty('s1', NULL, 'Phone fixture one', NULL, 'other', 'support', 'other', '[]', jsonb_build_array(pg_temp.ph('+12125550121', NULL))),
         pg_temp.pty('s2', NULL, 'Phone fixture two', NULL, 'other', 'support', 'other', '[]', jsonb_build_array(pg_temp.ph('2125550122', NULL))),
         pg_temp.pty('s3', NULL, 'Phone fixture three', NULL, 'other', 'support', 'other', '[]', jsonb_build_array(pg_temp.ph('+2125550123', NULL))),
         pg_temp.pty('s4', NULL, 'Phone fixture four', NULL, 'other', 'support', 'other', '[]', jsonb_build_array(pg_temp.ph('12125550124', NULL))),
         pg_temp.pty('s5', NULL, 'Phone fixture five', NULL, 'other', 'support', 'other', '[]', jsonb_build_array(pg_temp.ph('+442125550125', NULL))),
         pg_temp.pty('s6', NULL, 'Phone fixture six', NULL, 'other', 'support', 'other', '[]', jsonb_build_array(pg_temp.ph('442125550126', NULL)))));
  PERFORM pg_temp.rec('fx_parties_DPH', (SELECT jsonb_agg(DISTINCT x ->> 'status') FROM jsonb_array_elements(r -> 'results') x));
  FOR k IN SELECT unnest(ARRAY['s1', 's2', 's3', 's4', 's5', 's6']) LOOP
    PERFORM pg_temp.put('p_' || k, pg_temp.party_of(pg_temp.id('DPH'), k)::text);
  END LOOP;
  PERFORM pg_temp.rec('fx_parties_DA9', (SELECT jsonb_agg(DISTINCT x ->> 'status') FROM jsonb_array_elements(r -> 'results') x));
  r := pg_temp.up(B, 'cloud_upsert_parties', IB, pg_temp.id('DB1'), jsonb_build_array(
         pg_temp.pty('patb', 'c1', 'Pat fixture lender', 'First fixture bank', 'lender', 'lending', 'lender',
                     jsonb_build_array(pg_temp.em('pat.lender@example.test')), jsonb_build_array(pg_temp.ph('+12125550101', NULL))),
         pg_temp.pty('whb', 'c3', NULL, NULL, 'client', 'client', 'client', '[]', '[]', NULL, true)));
  -- the smallest ids: pat (the expected contact_ref of c1 on IA), and three that must never be used
  UPDATE public.cloud_deal_parties SET id = pg_temp.small(10) WHERE cloud_deal_id = pg_temp.id('DA1') AND local_party_id = 'pat';
  UPDATE public.cloud_deal_parties SET id = pg_temp.small(1) WHERE cloud_deal_id = pg_temp.id('DA4') AND local_party_id = 'pat4';
  UPDATE public.cloud_deal_parties SET id = pg_temp.small(2) WHERE cloud_deal_id = pg_temp.id('DA1') AND local_party_id = 'rm';
  UPDATE public.cloud_deal_parties SET id = pg_temp.small(3) WHERE cloud_deal_id = pg_temp.id('DA5') AND local_party_id = 'pat5';
  FOR k, i_n IN SELECT x.k, 0 FROM (VALUES ('pat'), ('sam'), ('wh'), ('card'), ('pct'), ('nul2'), ('many'), ('rm')) x(k) LOOP
    PERFORM pg_temp.put('p_' || k, pg_temp.party_of(pg_temp.id('DA1'), k)::text);
  END LOOP;
  PERFORM pg_temp.put('p_pat2', pg_temp.party_of(pg_temp.id('DA2'), 'pat2')::text);
  PERFORM pg_temp.put('p_pat4', pg_temp.party_of(pg_temp.id('DA4'), 'pat4')::text);
  PERFORM pg_temp.put('p_pat5', pg_temp.party_of(pg_temp.id('DA5'), 'pat5')::text);
  PERFORM pg_temp.put('p_pat7', pg_temp.party_of(pg_temp.id('DA7'), 'pat7')::text);
  PERFORM pg_temp.put('p_patb', pg_temp.party_of(pg_temp.id('DB1'), 'patb')::text);
  PERFORM pg_temp.put('p_whb', pg_temp.party_of(pg_temp.id('DB1'), 'whb')::text);
  -- the desktop removes person rm from DA1
  r := pg_temp.j(pg_temp.call_as(A, format('SELECT public.cloud_tombstone(%L::uuid, %L::uuid, %L, %L::uuid[])', A, IA, 'party', ARRAY[pg_temp.id('p_rm')])));
  PERFORM pg_temp.rec('fx_tomb_rm', r -> 'results' -> 0 -> 'status');

  -- checklists and todos of A (desktop pushes, at most 200 ops each)
  r := pg_temp.push(A, IA, pg_temp.nowt(), jsonb_build_array(
         pg_temp.cc(pg_temp.id('DA1'), 'tpl', 'tpl-purchase', 'Purchase', 0),
         pg_temp.ci(pg_temp.id('DA1'), 'tpl', 't1', 'Inspection report', 0, true, NULL, '2026-12-05'),
         pg_temp.ci(pg_temp.id('DA1'), 'tpl', 't2', 'Appraisal', 1, false, NULL, '2026-12-01'),
         pg_temp.ci(pg_temp.id('DA1'), 'tpl', 't3', 'Final walk', 2, false, NULL, '2026-12-10'),
         pg_temp.ci(pg_temp.id('DA1'), 'tpl', 't4', 'Removed item', 3, false, NULL, '2026-12-05'),
         pg_temp.ci(pg_temp.id('DA1'), 'tpl', 't5', 'Done item', 4, false, NULL, '2026-11-20', true),
         pg_temp.ci(pg_temp.id('DA1'), 'tpl', 't6', 'Undated required', 5, true),
         pg_temp.ci(pg_temp.id('DA1'), 'tpl', 't7', 'Legacy unknown state', 6),
         pg_temp.cc(pg_temp.id('DA1'), 'my', 'keepr:my-items', 'My items', 1),
         pg_temp.ci(pg_temp.id('DA1'), 'my', 'm1', 'Call the lender', 0, false, 'Ask about rate 4111 1111 1111 1111'),
         pg_temp.ci(pg_temp.id('DA1'), 'my', 'm2', 'Order keys', 1, false, NULL, '2026-12-05'),
         pg_temp.cc(pg_temp.id('DA1'), 'old', 'tpl-old', 'Old list', 2),
         pg_temp.ci(pg_temp.id('DA1'), 'old', 'o1', 'Item of a removed list', 0, true, NULL, '2026-12-05'),
         pg_temp.cc(pg_temp.id('DA2'), 'tpl2', 'tpl-listing', 'Listing', 0),
         pg_temp.ci(pg_temp.id('DA2'), 'tpl2', 'c1', 'Closed deal item', 0, false, NULL, '2026-11-30'),
         pg_temp.cc(pg_temp.id('DA3'), 'my3', 'keepr:my-items', 'My items', 0),
         pg_temp.ci(pg_temp.id('DA3'), 'my3', 'l1', 'Locked item', 0, false, NULL, '2026-12-05'),
         pg_temp.cc(pg_temp.id('DA4'), 'my4', 'keepr:my-items', 'My items', 0),
         pg_temp.ci(pg_temp.id('DA4'), 'my4', 'n1', 'Unconfirmed item', 0, false, NULL, '2026-12-05'),
         pg_temp.cc(pg_temp.id('DA5'), 'my5', 'keepr:my-items', 'My items', 0),
         pg_temp.ci(pg_temp.id('DA5'), 'my5', 'r5', 'Removed deal item', 0, false, NULL, '2026-12-05'),
         pg_temp.cc(pg_temp.id('DW'), 'w', 'tpl-long', repeat('"' || chr(119070), 100), 0),
         pg_temp.ci(pg_temp.id('DW'), 'w', 'w1', repeat('"' || chr(119070), 150), 0, true, repeat('x', 4000), '2026-12-31')));
  PERFORM pg_temp.rec('fx_push_A1', (SELECT jsonb_agg(DISTINCT x ->> 'status') FROM jsonb_array_elements(r -> 'results') x));
  PERFORM pg_temp.rec('fx_push_A1_not_added', (SELECT coalesce(jsonb_agg(x - 'parts'), '[]') FROM jsonb_array_elements(r -> 'results') x WHERE x ->> 'status' <> 'added'));
  ops := '[]';
  FOR i_n IN 1 .. 31 LOOP
    ops := ops || jsonb_build_array(pg_temp.cc(pg_temp.id('DT'), 'k' || lpad(i_n::text, 2, '0'), 'tpl-k' || i_n, 'List ' || i_n, i_n - 1),
                                    pg_temp.ci(pg_temp.id('DT'), 'k' || lpad(i_n::text, 2, '0'), 'kt' || lpad(i_n::text, 2, '0'), 'K item ' || i_n, 0));
  END LOOP;
  r := pg_temp.push(A, IA, pg_temp.nowt(), ops);
  PERFORM pg_temp.rec('fx_push_DT', (SELECT jsonb_agg(DISTINCT x ->> 'status') FROM jsonb_array_elements(r -> 'results') x));
  ops := jsonb_build_array(pg_temp.cc(pg_temp.id('DP'), 'pg', 'tpl-page', 'Paging list', 0));
  FOR i_n IN 1 .. 100 LOOP
    ops := ops || jsonb_build_array(pg_temp.ci(pg_temp.id('DP'), 'pg', 'pi' || lpad(i_n::text, 3, '0'), repeat(chr(119070), 150) || ' ' || i_n, i_n, false, NULL,
                                               CASE WHEN i_n % 2 = 0 THEN to_char(DATE '2027-01-01' + (i_n % 20), 'YYYY-MM-DD') END));
  END LOOP;
  r := pg_temp.push(A, IA, pg_temp.nowt(), ops);
  PERFORM pg_temp.rec('fx_push_DP', (SELECT jsonb_agg(DISTINCT x ->> 'status') FROM jsonb_array_elements(r -> 'results') x));
  r := pg_temp.push(B, IB, pg_temp.nowt(), jsonb_build_array(
         pg_temp.cc(pg_temp.id('DB1'), 'myb', 'keepr:my-items', 'My items', 0),
         pg_temp.ci(pg_temp.id('DB1'), 'myb', 'b1', 'Inspection report', 0, true, NULL, '2026-12-05')));
  PERFORM pg_temp.rec('fx_push_B', (SELECT jsonb_agg(DISTINCT x ->> 'status') FROM jsonb_array_elements(r -> 'results') x));
  FOR k IN SELECT unnest(ARRAY['t1', 't2', 't3', 't4', 't5', 't6', 't7', 'm1', 'm2', 'o1']) LOOP
    PERFORM pg_temp.put(k, pg_temp.item_of(pg_temp.id('DA1'), k)::text);
  END LOOP;
  PERFORM pg_temp.put('c1', pg_temp.item_of(pg_temp.id('DA2'), 'c1')::text);
  PERFORM pg_temp.put('l1', pg_temp.item_of(pg_temp.id('DA3'), 'l1')::text);
  PERFORM pg_temp.put('n1', pg_temp.item_of(pg_temp.id('DA4'), 'n1')::text);
  PERFORM pg_temp.put('r5', pg_temp.item_of(pg_temp.id('DA5'), 'r5')::text);
  PERFORM pg_temp.put('w1', pg_temp.item_of(pg_temp.id('DW'), 'w1')::text);
  PERFORM pg_temp.put('kt31', pg_temp.item_of(pg_temp.id('DT'), 'kt31')::text);
  PERFORM pg_temp.put('b1', pg_temp.item_of(pg_temp.id('DB1'), 'b1')::text);
  PERFORM pg_temp.put('cl_old', pg_temp.cl_of(pg_temp.id('DA1'), 'old')::text);
  -- the desktop removes todo t4 and the list 'Old list' (its todo o1 stays live in the removed list)
  r := pg_temp.push(A, IA, pg_temp.nowt(), jsonb_build_array(pg_temp.op('remove', 'item', pg_temp.id('t4')), pg_temp.op('remove', 'checklist', pg_temp.id('cl_old'))));
  PERFORM pg_temp.rec('fx_removals', (SELECT jsonb_agg(x ->> 'status') FROM jsonb_array_elements(r -> 'results') x));
  PERFORM pg_temp.rec('fx_o1_live_in_removed_list', to_jsonb((SELECT t.removed_at IS NULL AND c.removed_at IS NOT NULL
      FROM public.cloud_deal_checklist_items t JOIN public.cloud_deal_checklists c ON c.id = t.cloud_checklist_id WHERE t.id = pg_temp.id('o1'))));
  UPDATE public.cloud_deal_checklist_items SET is_checked = NULL WHERE id = pg_temp.id('t7');
  PERFORM pg_temp.rec('fx_remove_DA5', pg_temp.deldeal(A, pg_temp.id('DA5')) -> 'ok');
  UPDATE public.cloud_deals SET lock_reason = 'submitted' WHERE id = pg_temp.id('DA3');

  -- the portal secret (prev slot, this call only), MCP on, and one read connection per user
  UPDATE public.mcp_settings SET portal_secret_prev_sha256 = sha256(convert_to(pg_temp.secret(), 'UTF8')), enabled = true WHERE id;
  INSERT INTO public.mcp_oauth_clients (client_id, client_name, redirect_uris, ip_sha256)
  VALUES (pg_temp.client(), 'Fixture app', ARRAY['https://claude.ai/api/mcp/auth_callback'], sha256(convert_to('p8-ip', 'UTF8')));
  PERFORM pg_temp.conn('KA', A, 1);
  PERFORM pg_temp.conn('KB', B, 2);
  PERFORM pg_temp.conn('KC', C, 3);
  PERFORM pg_temp.rec('fx_counts', jsonb_build_object(
    'A_parties_live', (SELECT count(*) FROM public.cloud_deal_parties WHERE owner_user_id = A AND removed_at IS NULL),
    'A_items_live', (SELECT count(*) FROM public.cloud_deal_checklist_items WHERE owner_user_id = A AND removed_at IS NULL),
    'A_lists_live', (SELECT count(*) FROM public.cloud_deal_checklists WHERE owner_user_id = A AND removed_at IS NULL),
    'B_parties', (SELECT count(*) FROM public.cloud_deal_parties WHERE owner_user_id = B)));
END
$fx8$;
