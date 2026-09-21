-- BACKLOG-3473 control fixtures and helpers.
--
-- Loaded by run.sh inside EVERY control's own transaction, which run.sh always
-- ends with ROLLBACK. Nothing here survives a control run. Load order, set by
-- run.sh (Addendum B R1):
--   migration 2 -> THIS FILE -> rpc "before" snapshot -> migration 1
--   -> migration 3 (unless the control is marked `harness: without-file3`)
--   -> [mutant] -> control
-- So every override below is written BEFORE migration 1's override trigger
-- exists, as in production, where overrides exist before migration 1 lands.
--
-- ALL IDENTIFIERS ARE INVENTED. UUIDs sit in the
-- 00000000-0000-4000-8000-00003473xxxx block, emails under the reserved
-- .example.test domain, slugs and license keys carry a fixture-3473 prefix.
-- Each id is published as a transaction-local setting (t3473.<name>) so no
-- control repeats a literal.
--
-- Producers, per Addendum B R3:
--   personal org I      public._ensure_personal_organization_for(u_i), status 'created'
--   T1, T2, E, C plans  public.admin_assign_org_plan as u_staff (holds plans.manage)
--   overrides           owner SQL (the only real writer of overrides is staff SQL)
--   submissions, copies owner INSERT, status set directly
-- Plans are transcribed from production's rows (name, slug, tier, is_default,
-- is_active, sort_order); only ids are invented, and ON CONFLICT leaves a
-- venue's own rows alone, so fixtures look plans up by slug.
-- The custom plan zz-test-custom-3473 is legal (plans_tier_check allows
-- 'custom', admin_assign_org_plan accepts it) but ABSENT in production.

-- ---------------------------------------------------------------------------
-- Helpers (created in the control's transaction, rolled back with it). A
-- temporary schema is usable by every role in its own session, so
-- `authenticated` and `anon` can call them.
-- ---------------------------------------------------------------------------

-- check(ok, label): raises unless ok IS TRUE, and counts. run.sh refuses a
-- GREEN with zero assertions.
CREATE FUNCTION pg_temp.check(ok boolean, label text) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  IF ok IS NOT TRUE THEN
    RAISE EXCEPTION 'CONTROL FAILED: %', label;
  END IF;
  PERFORM set_config('t3473.asserts', (current_setting('t3473.asserts')::int + 1)::text, true);
END
$$;

-- act_as(uid): the PostgREST request shape for a signed-in user.
CREATE FUNCTION pg_temp.act_as(uid uuid) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM set_config('request.jwt.claim.sub', coalesce(uid::text, ''), true);
  PERFORM set_config('request.jwt.claim.role', 'authenticated', true);
  PERFORM set_config('request.jwt.claims',
                     jsonb_build_object('sub', uid, 'role', 'authenticated', 'aud', 'authenticated')::text, true);
  PERFORM set_config('role', 'authenticated', true);
END
$$;

-- act_anon(): the PostgREST request shape with only the anon key.
CREATE FUNCTION pg_temp.act_anon() RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM set_config('request.jwt.claim.sub', '', true);
  PERFORM set_config('request.jwt.claim.role', 'anon', true);
  PERFORM set_config('request.jwt.claims', '{"role": "anon"}', true);
  PERFORM set_config('role', 'anon', true);
END
$$;

-- act_owner(): back to the connecting role (postgres), no JWT.
CREATE FUNCTION pg_temp.act_owner() RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM set_config('role', 'none', true);
  PERFORM set_config('request.jwt.claim.sub', '', true);
  PERFORM set_config('request.jwt.claim.role', '', true);
  PERFORM set_config('request.jwt.claims', '', true);
END
$$;

-- outcome(sql): runs sql in a subtransaction as the CURRENT role. Returns
-- 'rows:<n>' (ROW_COUNT; for a SELECT, rows returned) or '<SQLSTATE>:<message>'.
-- An error rolls back only the subtransaction.
CREATE FUNCTION pg_temp.outcome(p_sql text) RETURNS text
LANGUAGE plpgsql AS $$
DECLARE
  n bigint;
BEGIN
  EXECUTE p_sql;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN 'rows:' || n;
EXCEPTION WHEN OTHERS THEN
  RETURN SQLSTATE || ':' || SQLERRM;
END
$$;

-- id(name): a published fixture id.
CREATE FUNCTION pg_temp.id(p_name text) RETURNS uuid
LANGUAGE sql STABLE AS $$ SELECT current_setting('t3473.' || p_name)::uuid $$;

-- n(sql): the single bigint a query returns, run as the CURRENT role.
CREATE FUNCTION pg_temp.n(p_sql text) RETURNS bigint
LANGUAGE plpgsql AS $$
DECLARE
  v bigint;
BEGIN
  EXECUTE p_sql INTO v;
  RETURN v;
END
$$;

-- expect(label, sql, want): the Addendum B R2 vocabulary.
--   PRIV  42501 "permission denied for table|function"
--   RLS   42501 "violates row-level security policy"
--   CHK   23514    FK 23503    UNQ 23505
--   '~<regex>'  outcome() must match the regex
--   anything else is compared literally with outcome(): 'rows:1', 'rows:0'
-- A different SQLSTATE is a failure even when the statement "failed".
CREATE FUNCTION pg_temp.expect(p_label text, p_sql text, p_want text) RETURNS text
LANGUAGE plpgsql AS $$
DECLARE
  got text := pg_temp.outcome(p_sql);
  ok  boolean;
BEGIN
  ok := CASE p_want
          WHEN 'PRIV' THEN got ~ '^42501:permission denied for (table|function) '
          WHEN 'RLS'  THEN got ~ '^42501:.*violates row-level security policy'
          WHEN 'CHK'  THEN got LIKE '23514:%'
          WHEN 'FK'   THEN got LIKE '23503:%'
          WHEN 'UNQ'  THEN got LIKE '23505:%'
          ELSE CASE WHEN p_want LIKE '~%' THEN got ~ substr(p_want, 2) ELSE got = p_want END
        END;
  PERFORM pg_temp.check(ok, format('%s: expected %s, got %s', p_label, p_want, got));
  RETURN got;
END
$$;

-- try_exec(sql): like outcome(), for whole migration texts (multi-statement,
-- no parameters). 'ok' or '<SQLSTATE>:<message>'. An error rolls the whole
-- text back, as a failed migration transaction would.
CREATE FUNCTION pg_temp.try_exec(p_sql text) RETURNS text
LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE p_sql;
  RETURN 'ok';
EXCEPTION WHEN OTHERS THEN
  RETURN SQLSTATE || ':' || SQLERRM;
END
$$;

-- cell(rpc, org, key, uid): one feature cell as `uid` sees it, normalised to
-- {enabled, value, source[, override_ignored][, error]}. check_feature_access's
-- `allowed` is renamed `enabled`. A response error is carried as `error`.
CREATE FUNCTION pg_temp.cell(p_rpc text, p_org uuid, p_key text, p_uid uuid) RETURNS jsonb
LANGUAGE plpgsql AS $$
DECLARE
  resp jsonb;
  c    jsonb;
BEGIN
  PERFORM pg_temp.act_as(p_uid);
  IF p_rpc = 'check_feature_access' THEN
    resp := public.check_feature_access(p_org, p_key);
    c := (resp - 'allowed') || jsonb_build_object('enabled', resp -> 'allowed');
  ELSIF p_rpc = 'get_org_features' THEN
    resp := public.get_org_features(p_org);
    c := coalesce(resp -> 'features' -> p_key,
                  jsonb_build_object('error', coalesce(resp ->> 'error', 'key_absent')));
  ELSIF p_rpc = 'broker_get_org_features' THEN
    resp := public.broker_get_org_features(p_org);
    c := coalesce(resp -> 'features' -> p_key,
                  jsonb_build_object('error', coalesce(resp ->> 'error', 'key_absent')));
  ELSE
    RAISE EXCEPTION 'cell: unknown rpc %', p_rpc;
  END IF;
  PERFORM pg_temp.act_owner();
  RETURN jsonb_strip_nulls(jsonb_build_object(
    'enabled', c -> 'enabled', 'value', c -> 'value', 'source', c -> 'source',
    'override_ignored', c -> 'override_ignored', 'error', c -> 'error'));
END
$$;

-- rpc_snapshot(): every cell of the three read functions (Addendum B R1).
--   rows (rpc, caller_kind, org, key, cell)
--   counted callers: one member per org (T1 u_t1_agent, T2 u_t2_agent,
--     E u_e_agent, I u_i, C u_c_member); broker_get_org_features also as the
--     non-member u_outsider. key = feature key, cell = the raw cell object
--     (check_feature_access: its whole response).
--   pinned callers: non-member and anon for check_feature_access and
--     get_org_features, anon for broker_get_org_features. key = '*',
--     cell = the whole response.
--   meta rows: key = '#meta' per (rpc, caller, org) with has_error and
--     features_type, and rpc = '#fn' rows with each function's proacl,
--     prosecdef, provolatile and proconfig.
CREATE FUNCTION pg_temp.rpc_snapshot()
RETURNS TABLE (rpc text, caller_kind text, org text, key text, cell jsonb)
LANGUAGE plpgsql AS $$
DECLARE
  keys    text[];
  o       record;
  k       text;
  resp    jsonb;
  f       record;
BEGIN
  SELECT array_agg(fd.key ORDER BY fd.key) INTO keys FROM public.feature_definitions fd;

  FOR f IN
    SELECT p.proname, p.proacl::text AS acl, p.prosecdef, p.provolatile, p.proconfig::text AS cfg
      FROM pg_proc p
     WHERE p.pronamespace = 'public'::regnamespace
       AND p.proname IN ('check_feature_access', 'get_org_features', 'broker_get_org_features')
  LOOP
    rpc := '#fn'; caller_kind := '-'; org := '-'; key := f.proname;
    cell := jsonb_build_object('acl', f.acl, 'secdef', f.prosecdef, 'volatile', f.provolatile::text, 'config', f.cfg);
    RETURN NEXT;
  END LOOP;

  FOR o IN
    SELECT * FROM (VALUES
      ('T1', current_setting('t3473.o_t1')::uuid, current_setting('t3473.u_t1_agent')::uuid),
      ('T2', current_setting('t3473.o_t2')::uuid, current_setting('t3473.u_t2_agent')::uuid),
      ('E',  current_setting('t3473.o_e')::uuid,  current_setting('t3473.u_e_agent')::uuid),
      ('I',  current_setting('t3473.o_i')::uuid,  current_setting('t3473.u_i')::uuid),
      ('C',  current_setting('t3473.o_c')::uuid,  current_setting('t3473.u_c_member')::uuid)
    ) v(label, id, member)
  LOOP
    -- member: check_feature_access, one call per key
    PERFORM pg_temp.act_as(o.member);
    FOREACH k IN ARRAY keys LOOP
      resp := public.check_feature_access(o.id, k);
      rpc := 'check_feature_access'; caller_kind := 'member'; org := o.label; key := k; cell := resp;
      RETURN NEXT;
    END LOOP;

    -- member: get_org_features and broker_get_org_features, exploded per key
    resp := public.get_org_features(o.id);
    rpc := 'get_org_features'; caller_kind := 'member'; org := o.label; key := '#meta';
    cell := jsonb_build_object('has_error', resp ? 'error', 'features_type', jsonb_typeof(resp -> 'features'));
    RETURN NEXT;
    FOR key, cell IN SELECT e.key, e.value FROM jsonb_each(CASE WHEN jsonb_typeof(resp -> 'features') = 'object' THEN resp -> 'features' ELSE '{}'::jsonb END) e LOOP
      RETURN NEXT;
    END LOOP;

    resp := public.broker_get_org_features(o.id);
    rpc := 'broker_get_org_features'; caller_kind := 'member'; org := o.label; key := '#meta';
    cell := jsonb_build_object('has_error', resp ? 'error', 'features_type', jsonb_typeof(resp -> 'features'));
    RETURN NEXT;
    FOR key, cell IN SELECT e.key, e.value FROM jsonb_each(CASE WHEN jsonb_typeof(resp -> 'features') = 'object' THEN resp -> 'features' ELSE '{}'::jsonb END) e LOOP
      RETURN NEXT;
    END LOOP;

    -- non-member
    PERFORM pg_temp.act_as(current_setting('t3473.u_outsider')::uuid);
    resp := public.broker_get_org_features(o.id);
    rpc := 'broker_get_org_features'; caller_kind := 'non_member'; org := o.label; key := '#meta';
    cell := jsonb_build_object('has_error', resp ? 'error', 'features_type', jsonb_typeof(resp -> 'features'));
    RETURN NEXT;
    FOR key, cell IN SELECT e.key, e.value FROM jsonb_each(CASE WHEN jsonb_typeof(resp -> 'features') = 'object' THEN resp -> 'features' ELSE '{}'::jsonb END) e LOOP
      RETURN NEXT;
    END LOOP;
    rpc := 'check_feature_access'; caller_kind := 'non_member'; org := o.label; key := '*';
    cell := public.check_feature_access(o.id, 'transaction_checklists');
    RETURN NEXT;
    rpc := 'get_org_features'; caller_kind := 'non_member'; org := o.label; key := '*';
    cell := public.get_org_features(o.id);
    RETURN NEXT;

    -- anon
    PERFORM pg_temp.act_anon();
    rpc := 'check_feature_access'; caller_kind := 'anon'; org := o.label; key := '*';
    cell := public.check_feature_access(o.id, 'transaction_checklists');
    RETURN NEXT;
    rpc := 'get_org_features'; caller_kind := 'anon'; org := o.label; key := '*';
    cell := public.get_org_features(o.id);
    RETURN NEXT;
    rpc := 'broker_get_org_features'; caller_kind := 'anon'; org := o.label; key := '*';
    cell := public.broker_get_org_features(o.id);
    RETURN NEXT;

    PERFORM pg_temp.act_owner();
  END LOOP;
END
$$;

SELECT set_config('t3473.asserts', '0', true) IS NOT NULL AS counter_ready;
SELECT set_config('t3473.scope', :'scope', true) AS declared_scope;

-- ---------------------------------------------------------------------------
-- Fixtures
-- ---------------------------------------------------------------------------
DO $fixtures$
DECLARE
  -- users
  u_t1_agent   uuid := '00000000-0000-4000-8000-000034730001'; -- pii-allow-uuid: invented fixture id (submitter; C8-C14, C9p)
  u_t1_agent2  uuid := '00000000-0000-4000-8000-000034730002'; -- pii-allow-uuid: invented fixture id (C8, C9)
  u_t1_broker  uuid := '00000000-0000-4000-8000-000034730003'; -- pii-allow-uuid: invented fixture id (C4-C8, C17)
  u_t1_admin   uuid := '00000000-0000-4000-8000-000034730004'; -- pii-allow-uuid: invented fixture id (C4, C8)
  u_t1_itadmin uuid := '00000000-0000-4000-8000-000034730005'; -- pii-allow-uuid: invented fixture id (C4, C8)
  u_t2_broker  uuid := '00000000-0000-4000-8000-000034730006'; -- pii-allow-uuid: invented fixture id (C5)
  u_t2_agent   uuid := '00000000-0000-4000-8000-000034730007'; -- pii-allow-uuid: invented fixture id (C9b, C16)
  u_e_broker   uuid := '00000000-0000-4000-8000-000034730008'; -- pii-allow-uuid: invented fixture id (C1, C8)
  u_e_agent    uuid := '00000000-0000-4000-8000-000034730009'; -- pii-allow-uuid: invented fixture id (C1, C16)
  u_x          uuid := '00000000-0000-4000-8000-00003473000a'; -- pii-allow-uuid: invented fixture id (C3: T1 broker, E agent)
  u_y          uuid := '00000000-0000-4000-8000-00003473000b'; -- pii-allow-uuid: invented fixture id (C7: T1 broker, E broker)
  u_i          uuid := '00000000-0000-4000-8000-00003473000c'; -- pii-allow-uuid: invented fixture id (owner of personal org I)
  u_c_member   uuid := '00000000-0000-4000-8000-00003473000d'; -- pii-allow-uuid: invented fixture id (agent in C)
  u_p          uuid := '00000000-0000-4000-8000-00003473000e'; -- pii-allow-uuid: invented fixture id (C18, C25a, C25d: no membership)
  u_outsider   uuid := '00000000-0000-4000-8000-00003473000f'; -- pii-allow-uuid: invented fixture id (C16 non-member)
  u_staff      uuid := '00000000-0000-4000-8000-000034730010'; -- pii-allow-uuid: invented fixture id (holds plans.manage)
  u_d          uuid := '00000000-0000-4000-8000-000034730011'; -- pii-allow-uuid: invented fixture id (C25c: agent in D, added in-control)
  -- organizations
  o_t1         uuid := '00000000-0000-4000-8000-00003473a001'; -- pii-allow-uuid: invented fixture id
  o_t2         uuid := '00000000-0000-4000-8000-00003473a002'; -- pii-allow-uuid: invented fixture id
  o_e          uuid := '00000000-0000-4000-8000-00003473a003'; -- pii-allow-uuid: invented fixture id
  o_c          uuid := '00000000-0000-4000-8000-00003473a004'; -- pii-allow-uuid: invented fixture id
  o_d          uuid := '00000000-0000-4000-8000-00003473a005'; -- pii-allow-uuid: invented fixture id (created in-control by C25c)
  o_i          uuid;
  -- plans
  p_individual uuid := '00000000-0000-4000-8000-00003473f010'; -- pii-allow-uuid: invented fixture id
  p_team       uuid := '00000000-0000-4000-8000-00003473f020'; -- pii-allow-uuid: invented fixture id
  p_enterprise uuid := '00000000-0000-4000-8000-00003473f030'; -- pii-allow-uuid: invented fixture id
  p_custom     uuid := '00000000-0000-4000-8000-00003473f040'; -- pii-allow-uuid: invented fixture id
  r_staff      uuid := '00000000-0000-4000-8000-00003473e001'; -- pii-allow-uuid: invented fixture id
  -- submissions
  s_up         uuid := '00000000-0000-4000-8000-00003473b001'; -- pii-allow-uuid: invented fixture id
  s_sub        uuid := '00000000-0000-4000-8000-00003473b002'; -- pii-allow-uuid: invented fixture id
  s_fin        uuid := '00000000-0000-4000-8000-00003473b003'; -- pii-allow-uuid: invented fixture id
  s_nc         uuid := '00000000-0000-4000-8000-00003473b004'; -- pii-allow-uuid: invented fixture id
  s_t2         uuid := '00000000-0000-4000-8000-00003473b005'; -- pii-allow-uuid: invented fixture id
  -- attachments (A5: on S_fin, uploaded, not linked -- Addendum B.1)
  a1           uuid := '00000000-0000-4000-8000-00003473c001'; -- pii-allow-uuid: invented fixture id (S_up)
  a2           uuid := '00000000-0000-4000-8000-00003473c002'; -- pii-allow-uuid: invented fixture id (S_up)
  a3           uuid := '00000000-0000-4000-8000-00003473c003'; -- pii-allow-uuid: invented fixture id (S_sub)
  a4           uuid := '00000000-0000-4000-8000-00003473c004'; -- pii-allow-uuid: invented fixture id (S_fin, linked)
  a5           uuid := '00000000-0000-4000-8000-00003473c005'; -- pii-allow-uuid: invented fixture id (S_fin, not linked)
  -- messages
  m1           uuid := '00000000-0000-4000-8000-00003473d001'; -- pii-allow-uuid: invented fixture id (S_up email)
  m2           uuid := '00000000-0000-4000-8000-00003473d002'; -- pii-allow-uuid: invented fixture id (S_up email)
  m3           uuid := '00000000-0000-4000-8000-00003473d003'; -- pii-allow-uuid: invented fixture id (S_up sms)
  m4           uuid := '00000000-0000-4000-8000-00003473d004'; -- pii-allow-uuid: invented fixture id (S_sub email)
  m5           uuid := '00000000-0000-4000-8000-00003473d005'; -- pii-allow-uuid: invented fixture id (S_fin email, linked)
  -- the S_fin copy tree and the S_nc header
  h_fin        uuid := '00000000-0000-4000-8000-00003473e101'; -- pii-allow-uuid: invented fixture id
  i_fin        uuid := '00000000-0000-4000-8000-00003473e102'; -- pii-allow-uuid: invented fixture id
  l_fin_a      uuid := '00000000-0000-4000-8000-00003473e103'; -- pii-allow-uuid: invented fixture id
  l_fin_e      uuid := '00000000-0000-4000-8000-00003473e104'; -- pii-allow-uuid: invented fixture id
  mem_fin_a    uuid := '00000000-0000-4000-8000-00003473e105'; -- pii-allow-uuid: invented fixture id
  mem_fin_e    uuid := '00000000-0000-4000-8000-00003473e106'; -- pii-allow-uuid: invented fixture id
  h_nc         uuid := '00000000-0000-4000-8000-00003473e201'; -- pii-allow-uuid: invented fixture id
  i_nc         uuid := '00000000-0000-4000-8000-00003473e202'; -- pii-allow-uuid: invented fixture id
  v_perm       uuid;
  v_res        jsonb;
  r            record;
BEGIN
  -- Publish every id.
  FOR r IN SELECT * FROM (VALUES
    ('u_t1_agent', u_t1_agent), ('u_t1_agent2', u_t1_agent2), ('u_t1_broker', u_t1_broker),
    ('u_t1_admin', u_t1_admin), ('u_t1_itadmin', u_t1_itadmin), ('u_t2_broker', u_t2_broker),
    ('u_t2_agent', u_t2_agent), ('u_e_broker', u_e_broker), ('u_e_agent', u_e_agent),
    ('u_x', u_x), ('u_y', u_y), ('u_i', u_i), ('u_c_member', u_c_member), ('u_p', u_p),
    ('u_outsider', u_outsider), ('u_staff', u_staff), ('u_d', u_d),
    ('o_t1', o_t1), ('o_t2', o_t2), ('o_e', o_e), ('o_c', o_c), ('o_d', o_d),
    ('s_up', s_up), ('s_sub', s_sub), ('s_fin', s_fin), ('s_nc', s_nc), ('s_t2', s_t2),
    ('a1', a1), ('a2', a2), ('a3', a3), ('a4', a4), ('a5', a5),
    ('m1', m1), ('m2', m2), ('m3', m3), ('m4', m4), ('m5', m5),
    ('h_fin', h_fin), ('i_fin', i_fin), ('l_fin_a', l_fin_a), ('l_fin_e', l_fin_e),
    ('mem_fin_a', mem_fin_a), ('mem_fin_e', mem_fin_e), ('h_nc', h_nc), ('i_nc', i_nc)
  ) v(name, id) LOOP
    PERFORM set_config('t3473.' || r.name, r.id::text, true);
  END LOOP;

  -- Plans (transcribed; ids invented; a venue's own rows win).
  INSERT INTO public.plans (id, name, slug, tier, description, is_default, is_active, sort_order) VALUES
    (p_individual, 'Individual', 'individual', 'individual', 'fixture-3473', true,  true, 10),
    (p_team,       'Team',       'team',       'team',       'fixture-3473', false, true, 20),
    (p_enterprise, 'Enterprise', 'enterprise', 'enterprise', 'fixture-3473', false, true, 30)
  ON CONFLICT DO NOTHING;
  INSERT INTO public.plans (id, name, slug, tier, description, is_default, is_active, sort_order) VALUES
    (p_custom, 'zz Test Custom 3473', 'zz-test-custom-3473', 'custom', 'fixture-3473', false, true, 90);
  PERFORM set_config('t3473.p_individual', (SELECT id FROM public.plans WHERE slug = 'individual')::text, true);
  PERFORM set_config('t3473.p_team',       (SELECT id FROM public.plans WHERE slug = 'team')::text, true);
  PERFORM set_config('t3473.p_enterprise', (SELECT id FROM public.plans WHERE slug = 'enterprise')::text, true);
  PERFORM set_config('t3473.p_custom',     p_custom::text, true);

  -- Catalogue, BEFORE any plan row is written, so the seed trigger copies it.
  INSERT INTO public.checklist_seed_templates (seed_key, name, description, sort_order, items) VALUES
    ('zz_test_a', 'Fixture starter A', 'fixture-3473', 10,
     '[{"title": "Fixture item A1", "description": null, "is_required": true, "expected_document_type": "contract"},
       {"title": "Fixture item A2", "is_required": false}]'::jsonb),
    ('zz_test_b', 'Fixture starter B', NULL, 20,
     '[{"title": "Fixture item B1", "expected_document_type": "inspection"}]'::jsonb);

  -- auth.users, public.users, licenses. public.users is seeded explicitly (the
  -- venue has no on_auth_user_created trigger).
  FOR r IN SELECT * FROM (VALUES
    (u_t1_agent, 't1-agent'), (u_t1_agent2, 't1-agent2'), (u_t1_broker, 't1-broker'),
    (u_t1_admin, 't1-admin'), (u_t1_itadmin, 't1-itadmin'), (u_t2_broker, 't2-broker'),
    (u_t2_agent, 't2-agent'), (u_e_broker, 'e-broker'), (u_e_agent, 'e-agent'),
    (u_x, 'x'), (u_y, 'y'), (u_i, 'i'), (u_c_member, 'c-member'), (u_p, 'p'),
    (u_outsider, 'outsider'), (u_staff, 'staff'), (u_d, 'd')
  ) v(id, label) LOOP
    INSERT INTO auth.users (id, email, aud, role, raw_app_meta_data, raw_user_meta_data)
    VALUES (r.id, r.label || '@fixture-3473.example.test', 'authenticated', 'authenticated',
            jsonb_build_object('provider', 'email'), '{}'::jsonb);
    INSERT INTO public.users (id, email, oauth_provider, oauth_id)
    VALUES (r.id, r.label || '@fixture-3473.example.test', 'email', 'fixture-3473-' || r.label);
    INSERT INTO public.licenses (user_id, license_key, license_type, status)
    VALUES (r.id, 'fixture-3473-' || r.label, 'individual', 'active');
  END LOOP;

  -- Staff: an internal role holding plans.manage (has_permission joins
  -- internal_roles -> admin_role_permissions -> admin_permissions).
  SELECT id INTO v_perm FROM public.admin_permissions WHERE key = 'plans.manage';
  IF v_perm IS NULL THEN
    RAISE EXCEPTION 'fixture: admin_permissions has no plans.manage on this venue';
  END IF;
  INSERT INTO public.admin_roles (id, name, slug, description) VALUES
    (r_staff, 'fixture-3473 plans', 'fixture-3473-plans', 'fixture-3473');
  INSERT INTO public.admin_role_permissions (role_id, permission_id) VALUES (r_staff, v_perm);
  INSERT INTO public.internal_roles (user_id, role_id) VALUES (u_staff, r_staff);

  -- Organizations T1, T2, E, C (owner INSERT), plans via the real producer.
  INSERT INTO public.organizations (id, name, slug, max_seats) VALUES
    (o_t1, 'Fixture Brokerage 3473 T1', 'fixture-3473-t1', 20),
    (o_t2, 'Fixture Brokerage 3473 T2', 'fixture-3473-t2', 20),
    (o_e,  'Fixture Brokerage 3473 E',  'fixture-3473-e',  20),
    (o_c,  'Fixture Brokerage 3473 C',  'fixture-3473-c',  20);

  FOR r IN SELECT v.org, v.slug, p.id AS plan_id FROM (VALUES
    (o_t1, 'team'), (o_t2, 'team'), (o_e, 'enterprise'), (o_c, 'zz-test-custom-3473')
  ) v(org, slug) JOIN public.plans p ON p.slug = v.slug LOOP
    PERFORM pg_temp.act_as(u_staff);
    v_res := public.admin_assign_org_plan(r.org, r.plan_id);
    PERFORM pg_temp.act_owner();
    IF (v_res ->> 'success')::boolean IS NOT TRUE THEN
      RAISE EXCEPTION 'fixture: admin_assign_org_plan(%, %) returned %', r.org, r.slug, v_res;
    END IF;
  END LOOP;

  -- Personal org I, through its only producer.
  v_res := public._ensure_personal_organization_for(u_i);
  IF v_res ->> 'status' IS DISTINCT FROM 'created' THEN
    RAISE EXCEPTION 'fixture: personal org for u_i returned %', v_res;
  END IF;
  o_i := (v_res ->> 'organization_id')::uuid;
  PERFORM set_config('t3473.o_i', o_i::text, true);

  -- Memberships.
  INSERT INTO public.organization_members (organization_id, user_id, role, license_status, joined_at) VALUES
    (o_t1, u_t1_agent,   'agent',    'active', now()),
    (o_t1, u_t1_agent2,  'agent',    'active', now()),
    (o_t1, u_t1_broker,  'broker',   'active', now()),
    (o_t1, u_t1_admin,   'admin',    'active', now()),
    (o_t1, u_t1_itadmin, 'it_admin', 'active', now()),
    (o_t1, u_x,          'broker',   'active', now()),
    (o_t1, u_y,          'broker',   'active', now()),
    (o_t2, u_t2_broker,  'broker',   'active', now()),
    (o_t2, u_t2_agent,   'agent',    'active', now()),
    (o_e,  u_e_broker,   'broker',   'active', now()),
    (o_e,  u_e_agent,    'agent',    'active', now()),
    (o_e,  u_x,          'agent',    'active', now()),
    (o_e,  u_y,          'broker',   'active', now()),
    (o_c,  u_c_member,   'agent',    'active', now());

  -- Overrides (owner SQL, before migration 1).
  UPDATE public.organization_plans
     SET feature_overrides = '{"transaction_checklists": {"enabled": true}, "call_log": {"enabled": true}, "sso_login": {"enabled": true}}'::jsonb
   WHERE organization_id = o_t1;
  UPDATE public.organization_plans
     SET feature_overrides = '{"transaction_checklists": {"enabled": true}, "call_log": {"enabled": true}, "desktop_hide_from_export": {"enabled": true}, "voice_transcription": {"enabled": false}}'::jsonb
   WHERE organization_id = o_i;
  UPDATE public.organization_plans
     SET feature_overrides = '{"sso_login": {"enabled": true}}'::jsonb
   WHERE organization_id = o_c;

  -- Submissions.
  INSERT INTO public.transaction_submissions
    (id, organization_id, submitted_by, local_transaction_id, property_address, status) VALUES
    (s_up,  o_t1, u_t1_agent, 'fixture-3473-s-up',  '1 Fixture Way', 'uploading'),
    (s_sub, o_t1, u_t1_agent, 'fixture-3473-s-sub', '2 Fixture Way', 'submitted'),
    (s_fin, o_t1, u_t1_agent, 'fixture-3473-s-fin', '3 Fixture Way', 'submitted'),
    (s_nc,  o_t1, u_t1_agent, 'fixture-3473-s-nc',  '4 Fixture Way', 'needs_changes'),
    (s_t2,  o_t2, u_t2_agent, 'fixture-3473-s-t2',  '5 Fixture Way', 'uploading');

  INSERT INTO public.submission_attachments (id, submission_id, filename, storage_path, document_type) VALUES
    (a1, s_up,  'fixture-a1.pdf', 'fixture-3473/a1.pdf', 'contract'),
    (a2, s_up,  'fixture-a2.pdf', 'fixture-3473/a2.pdf', 'other'),
    (a3, s_sub, 'fixture-a3.pdf', 'fixture-3473/a3.pdf', 'other'),
    (a4, s_fin, 'fixture-a4.pdf', 'fixture-3473/a4.pdf', 'contract'),
    (a5, s_fin, 'fixture-a5.pdf', 'fixture-3473/a5.pdf', 'other');

  INSERT INTO public.submission_messages (id, submission_id, local_message_id, channel, subject) VALUES
    (m1, s_up,  'fixture-3473-m1', 'email', 'Fixture thread'),
    (m2, s_up,  'fixture-3473-m2', 'email', 'Fixture thread'),
    (m3, s_up,  'fixture-3473-m3', 'sms',   NULL),
    (m4, s_sub, 'fixture-3473-m4', 'email', 'Fixture thread'),
    (m5, s_fin, 'fixture-3473-m5', 'email', 'Fixture thread');

  -- S_fin's full copy tree and S_nc's header + item (owner INSERT).
  INSERT INTO public.submission_checklists (id, submission_id, template_name) VALUES
    (h_fin, s_fin, 'Fixture starter A'),
    (h_nc,  s_nc,  'Fixture starter A');
  INSERT INTO public.submission_checklist_items
    (id, submission_id, submission_checklist_id, title, is_required, is_checked, sort_order) VALUES
    (i_fin, s_fin, h_fin, 'Fixture item A1', true, true, 10),
    (i_nc,  s_nc,  h_nc,  'Fixture item A1', true, false, 10);
  INSERT INTO public.submission_checklist_links
    (id, submission_id, submission_checklist_item_id, kind, label, sort_order) VALUES
    (l_fin_a, s_fin, i_fin, 'attachment', 'fixture-a4.pdf', 10),
    (l_fin_e, s_fin, i_fin, 'email',      'Fixture thread', 20);
  INSERT INTO public.submission_checklist_link_members
    (id, submission_id, link_id, kind, submission_attachment_id, submission_message_id) VALUES
    (mem_fin_a, s_fin, l_fin_a, 'attachment', a4,   NULL),
    (mem_fin_e, s_fin, l_fin_e, 'email',      NULL, m5);

  -- Publish the seeded copies the plan assignments above produced.
  FOR r IN SELECT * FROM (VALUES ('t1', o_t1), ('t2', o_t2), ('e', o_e), ('c', o_c)) v(label, org) LOOP
    PERFORM set_config('t3473.tpl_' || r.label || '_a',
      coalesce((SELECT id FROM public.checklist_templates WHERE organization_id = r.org AND seed_key = 'zz_test_a')::text, ''), true);
    PERFORM set_config('t3473.tpl_' || r.label || '_b',
      coalesce((SELECT id FROM public.checklist_templates WHERE organization_id = r.org AND seed_key = 'zz_test_b')::text, ''), true);
  END LOOP;
  PERFORM set_config('t3473.item_t1_a1',
    coalesce((SELECT i.id FROM public.checklist_template_items i
               JOIN public.checklist_templates t ON t.id = i.template_id
              WHERE t.organization_id = o_t1 AND t.seed_key = 'zz_test_a' AND i.title = 'Fixture item A1')::text, ''), true);
END
$fixtures$;

SELECT 'fixtures loaded: scope=' || current_setting('t3473.scope') AS fixtures;
