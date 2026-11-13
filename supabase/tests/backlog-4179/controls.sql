-- BACKLOG-4179 DB controls G1, G2, G4, G6 (+ R1 replica bypass, C1 catalog). G3/G5 (two sessions)
-- are concurrency.sh; G7 (pre-check) is compose.py mode G7; G8 is jest.
-- Venue: keepr-test via ~/.claude/bin/kt-sql. ONE call, one implicit transaction that always ends
-- in RAISE, so nothing persists. compose.py prepends the migration (or a mutant of it).
-- Own fixtures (keys bl4179:, domain k-4179.test); nothing outside them is read or written.
-- Each case runs in its own subtransaction rolled back by RAISE 'S_DONE'.
-- Output: RAISE 'P4179_RESULT {"mode":..., "pass":n, "fail":n, "reds":{case: got}}'.

CREATE FUNCTION pg_temp.id(t text) RETURNS uuid LANGUAGE sql IMMUTABLE AS $b$ SELECT md5('bl4179:' || t)::uuid $b$;

CREATE FUNCTION pg_temp.as_user(u uuid, r text) RETURNS void LANGUAGE plpgsql AS $b$
BEGIN
  PERFORM set_config('request.jwt.claims', json_build_object('sub', u, 'role', r)::text, true);
  PERFORM set_config('request.jwt.claim.sub', coalesce(u::text, ''), true);
  PERFORM set_config('request.jwt.claim.role', r, true);
END $b$;

-- Run q as role r (JWT sub u); returns its text value or 'ERR <sqlstate> <message>'.
CREATE FUNCTION pg_temp.q(u uuid, r text, q text) RETURNS text LANGUAGE plpgsql AS $b$
DECLARE v text;
BEGIN
  BEGIN
    PERFORM pg_temp.as_user(u, r);
    EXECUTE format('SET LOCAL ROLE %I', r);
    EXECUTE q INTO v;
    EXECUTE 'RESET ROLE';
    PERFORM pg_temp.as_user(NULL, 'postgres');
    RETURN coalesce(v, 'ok');
  EXCEPTION WHEN OTHERS THEN
    EXECUTE 'RESET ROLE';
    PERFORM pg_temp.as_user(NULL, 'postgres');
    RETURN 'ERR ' || SQLSTATE || ' ' || left(SQLERRM, 120);
  END;
END $b$;

-- A person with a confirmed email at k-4179.test. p_personal: a personal organization + membership
-- + licence (a solo Agent). p_modes: one stripe_customers row per payer mode.
CREATE FUNCTION pg_temp.mk_user(k text, p_personal boolean, p_modes text[]) RETURNS uuid
LANGUAGE plpgsql AS $b$
DECLARE u uuid := pg_temp.id(k); e text := replace(k, '_', '-') || '@k-4179.test'; m text;
BEGIN
  INSERT INTO auth.users (id, email, instance_id, aud, role, email_confirmed_at)
  VALUES (u, e, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', now());
  INSERT INTO public.users (id, email, oauth_provider, oauth_id) VALUES (u, e, 'google', k || '4179')
    ON CONFLICT DO NOTHING;
  INSERT INTO auth.identities (provider_id, user_id, identity_data, provider)
  VALUES (k || '-pid-4179', u, jsonb_build_object('sub', u, 'email', e), 'email');
  IF p_personal THEN
    INSERT INTO public.licenses (user_id, license_key, license_type, status) VALUES (u, 'lk-4179-' || k, 'individual', 'active');
    INSERT INTO public.organizations (id, name, slug, personal_owner_user_id, is_test, max_seats)
    VALUES (pg_temp.id('po_' || k), 'Personal', 'po-4179-' || replace(k, '_', '-'), u, true, 1);
    INSERT INTO public.organization_members (organization_id, user_id, role, license_status)
    VALUES (pg_temp.id('po_' || k), u, 'admin', 'active');
  END IF;
  FOREACH m IN ARRAY p_modes LOOP
    INSERT INTO public.stripe_customers (user_id, stripe_customer_id, stripe_mode) VALUES (u, 'cus_4179_' || k || '_' || m, m);
  END LOOP;
  RETURN u;
END $b$;

CREATE FUNCTION pg_temp.mk_brok(k text) RETURNS uuid LANGUAGE plpgsql AS $b$
BEGIN
  INSERT INTO public.organizations (id, name, slug, is_test, max_seats)
  VALUES (pg_temp.id(k), 'Brokerage ' || k || ' 4179', 'b4179-' || replace(lower(k), '_', '-'), true, 10);
  RETURN pg_temp.id(k);
END $b$;

-- An open invitation at o for u's email; returns its token.
CREATE FUNCTION pg_temp.mk_invite(o uuid, u uuid, st text) RETURNS text LANGUAGE plpgsql AS $b$
DECLARE t text := 'tok4179' || md5(o::text || u::text);
BEGIN
  INSERT INTO public.organization_members (organization_id, user_id, role, license_status, invited_email, invitation_token, invitation_expires_at)
  VALUES (o, NULL, 'agent', st, (SELECT email FROM auth.users WHERE id = u), t, now() + interval '7 days');
  RETURN t;
END $b$;

CREATE FUNCTION pg_temp.personal(u uuid) RETURNS int LANGUAGE sql AS $b$
  SELECT count(*)::int FROM public.organization_members m JOIN public.organizations o ON o.id = m.organization_id
   WHERE m.user_id = u AND o.personal_owner_user_id IS NOT NULL $b$;
CREATE FUNCTION pg_temp.brok(u uuid) RETURNS int LANGUAGE sql AS $b$
  SELECT count(*)::int FROM public.organization_members m JOIN public.organizations o ON o.id = m.organization_id
   WHERE m.user_id = u AND o.personal_owner_user_id IS NULL $b$;
CREATE FUNCTION pg_temp.ob(u uuid) RETURNS text LANGUAGE sql AS $b$
  SELECT count(*)::text || ':' || coalesce(string_agg(stripe_mode, ',' ORDER BY stripe_mode), '')
    FROM public.billing_outbox WHERE user_id = u AND kind = 'cancel_agent_on_brokerage_join' $b$;

-- Capture fixtures: brokerage K with a verified, freshly checked claim on k-4179.test.
INSERT INTO public.organizations (id, name, slug, is_test, max_seats)
  VALUES (pg_temp.id('oK'), 'Capture K 4179', 'cap-k-4179', true, 10);
INSERT INTO public.domain_claims (id, organization_id, domain, token, status, verified_at, last_checked_at, last_check_result)
  VALUES (pg_temp.id('cK'), pg_temp.id('oK'), 'k-4179.test',
          'keepr-domain-verification=' || substr(md5('t4179') || md5('u4179'), 1, 48),
          'verified', now() - interval '20 days', now(), 'verified');

CREATE FUNCTION pg_temp.mk_switch(u uuid) RETURNS uuid LANGUAGE plpgsql AS $b$
DECLARE s uuid;
BEGIN
  INSERT INTO public.domain_capture_switches
    (organization_id, claim_id, user_id, email_at_start, attestation, status, notice_sent_at, notice_delivered, switch_at)
  VALUES (pg_temp.id('oK'), pg_temp.id('cK'), u, (SELECT email FROM auth.users WHERE id = u), 'email_confirmed',
          'scheduled', now() - interval '14 days', true, now() - interval '1 minute')
  RETURNING id INTO s;
  RETURN s;
END $b$;

-- One result, kept in a PL/pgSQL variable: the case's subtransaction is rolled back.
CREATE FUNCTION pg_temp.rec(k text, ok boolean, got text) RETURNS jsonb LANGUAGE sql IMMUTABLE AS $b$
  SELECT jsonb_build_object(k, jsonb_build_array(coalesce(ok, false), got)) $b$;

-- __MODE__

DO $drv$
DECLARE
  u uuid; a uuid; b uuid; mid uuid; inv uuid; s uuid; tok text; st text; g text; k record;
  v_pass int := 0; v_fail int := 0; reds jsonb := '{}'::jsonb; res jsonb := '{}'::jsonb;
BEGIN
  CREATE TEMP TABLE r4179 (k text, ok boolean, got text) ON COMMIT DROP;

  -- ---- G1: a row at A in ANY status refuses a second brokerage row at B ---------------------------
  FOREACH st IN ARRAY ARRAY['active', 'pending', 'unassigned', 'suspended', 'expired'] LOOP
    BEGIN
      u := pg_temp.mk_user('g1_' || st, false, ARRAY[]::text[]);
      a := pg_temp.mk_brok('A_g1_' || st); b := pg_temp.mk_brok('B_g1_' || st);
      INSERT INTO public.organization_members (organization_id, user_id, role, license_status) VALUES (a, u, 'agent', st);
      BEGIN
        INSERT INTO public.organization_members (organization_id, user_id, role, license_status, joined_at)
        VALUES (b, u, 'agent', 'active', now());
        g := 'allowed rows=' || pg_temp.brok(u);
      EXCEPTION WHEN OTHERS THEN g := 'ERR ' || SQLSTATE || ' ' || SQLERRM;
      END;
      res := res || pg_temp.rec('G1_' || st, g = 'ERR P0001 already_placed', g);
      RAISE EXCEPTION 'S_DONE';
    EXCEPTION WHEN OTHERS THEN
      IF SQLERRM <> 'S_DONE' THEN res := res || pg_temp.rec('G1_' || st, false, 'SETUP ' || SQLSTATE || ' ' || left(SQLERRM, 120)); END IF;
    END;
  END LOOP;

  -- ---- G2: the server role claiming an invitation at B (UPDATE user_id) is refused ------------------
  BEGIN
    u := pg_temp.mk_user('g2', false, ARRAY[]::text[]);
    a := pg_temp.mk_brok('A_g2'); b := pg_temp.mk_brok('B_g2');
    INSERT INTO public.organization_members (organization_id, user_id, role, license_status) VALUES (a, u, 'agent', 'active');
    tok := pg_temp.mk_invite(b, u, 'pending');
    g := pg_temp.q(NULL, 'service_role', format(
      'UPDATE public.organization_members SET user_id = %L::uuid, license_status = ''active'' WHERE invitation_token = %L RETURNING ''allowed''', u, tok));
    res := res || pg_temp.rec('G2_service_update_user_id', g = 'ERR P0001 already_placed', g || ' rows=' || pg_temp.brok(u));
    RAISE EXCEPTION 'S_DONE';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM <> 'S_DONE' THEN res := res || pg_temp.rec('G2_service_update_user_id', false, 'SETUP ' || SQLSTATE || ' ' || left(SQLERRM, 120)); END IF;
  END;

  -- ---- G4: what must stay allowed --------------------------------------------------------------
  -- G4a: the person's only brokerage row moves A -> B.
  BEGIN
    u := pg_temp.mk_user('g4a', false, ARRAY[]::text[]);
    a := pg_temp.mk_brok('A_g4a'); b := pg_temp.mk_brok('B_g4a');
    INSERT INTO public.organization_members (organization_id, user_id, role, license_status) VALUES (a, u, 'agent', 'active') RETURNING id INTO mid;
    BEGIN
      UPDATE public.organization_members SET organization_id = b WHERE id = mid;
      g := 'allowed at_b=' || (SELECT count(*) FROM public.organization_members WHERE organization_id = b AND user_id = u);
    EXCEPTION WHEN OTHERS THEN g := 'ERR ' || SQLSTATE || ' ' || SQLERRM;
    END;
    res := res || pg_temp.rec('G4a_move_only_row', g = 'allowed at_b=1', g);
    RAISE EXCEPTION 'S_DONE';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM <> 'S_DONE' THEN res := res || pg_temp.rec('G4a_move_only_row', false, 'SETUP ' || SQLSTATE || ' ' || left(SQLERRM, 120)); END IF;
  END;

  -- G4b: suspended at A, reactivated at A; and an UPDATE that names user_id/organization_id unchanged.
  BEGIN
    u := pg_temp.mk_user('g4b', false, ARRAY[]::text[]);
    a := pg_temp.mk_brok('A_g4b');
    INSERT INTO public.organization_members (organization_id, user_id, role, license_status) VALUES (a, u, 'agent', 'suspended') RETURNING id INTO mid;
    BEGIN
      UPDATE public.organization_members SET license_status = 'active' WHERE id = mid;
      UPDATE public.organization_members SET user_id = user_id, organization_id = organization_id WHERE id = mid;
      g := 'allowed ' || (SELECT license_status FROM public.organization_members WHERE id = mid);
    EXCEPTION WHEN OTHERS THEN g := 'ERR ' || SQLSTATE || ' ' || SQLERRM;
    END;
    res := res || pg_temp.rec('G4b_reactivate_same_row', g = 'allowed active', g);
    RAISE EXCEPTION 'S_DONE';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM <> 'S_DONE' THEN res := res || pg_temp.rec('G4b_reactivate_same_row', false, 'SETUP ' || SQLSTATE || ' ' || left(SQLERRM, 120)); END IF;
  END;

  -- G4c: a placed solo Agent is suspended; the revert trigger writes their personal membership.
  BEGIN
    u := pg_temp.mk_user('g4c', true, ARRAY[]::text[]);
    a := pg_temp.mk_brok('A_g4c');
    INSERT INTO public.organization_members (organization_id, user_id, role, license_status, joined_at) VALUES (a, u, 'agent', 'active', now()) RETURNING id INTO mid;
    g := 'joined personal=' || pg_temp.personal(u);
    BEGIN
      UPDATE public.organization_members SET license_status = 'suspended' WHERE id = mid;
      g := g || ' suspended personal=' || pg_temp.personal(u);
    EXCEPTION WHEN OTHERS THEN g := g || ' ERR ' || SQLSTATE || ' ' || SQLERRM;
    END;
    res := res || pg_temp.rec('G4c_personal_revert', g = 'joined personal=0 suspended personal=1', g);
    RAISE EXCEPTION 'S_DONE';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM <> 'S_DONE' THEN res := res || pg_temp.rec('G4c_personal_revert', false, 'SETUP ' || SQLSTATE || ' ' || left(SQLERRM, 120)); END IF;
  END;

  -- ---- G6: each join path retires the personal membership and queues one plan cancel per mode ----
  -- Every person here is a solo Agent (personal org + licence) who pays in both modes.
  FOR k IN SELECT * FROM (VALUES ('accept'), ('jit_write'), ('scim_insert'), ('scim_claim'), ('switch'), ('join_now')) v(p) LOOP
    BEGIN
      u := pg_temp.mk_user('g6_' || k.p, true, ARRAY['live', 'test']);
      b := pg_temp.mk_brok('B_g6_' || k.p);
      IF k.p = 'accept' THEN
        tok := pg_temp.mk_invite(b, u, 'pending');
        g := pg_temp.q(u, 'authenticated', format('SELECT (public.accept_invitation(%L)) ->> ''success''', tok));
      ELSIF k.p = 'jit_write' THEN
        -- jit_join_organization refuses anyone with a licence or a membership (existing_account,
        -- 3962 PR4a), so it never moves a solo Agent; this is its INSERT, as the server role.
        g := pg_temp.q(NULL, 'service_role', format(
          'INSERT INTO public.organization_members (organization_id, user_id, role, joined_at, license_status, provisioned_by, provisioned_at) VALUES (%L, %L, ''agent'', now(), ''active'', ''jit'', now()) RETURNING ''true''', b, u));
      ELSIF k.p = 'scim_insert' THEN
        -- SCIM refuses a person whose only membership is personal (users.ts personal_account) before
        -- writing; this is writeScimMembership's INSERT, as the server role.
        g := pg_temp.q(NULL, 'service_role', format(
          'INSERT INTO public.organization_members (organization_id, user_id, role, license_status, joined_at, provisioned_by) VALUES (%L, %L, ''agent'', ''active'', now(), ''scim'') RETURNING ''true''', b, u));
      ELSIF k.p = 'scim_claim' THEN
        tok := pg_temp.mk_invite(b, u, 'pending');
        g := pg_temp.q(NULL, 'service_role', format(
          'UPDATE public.organization_members SET user_id = %L::uuid, license_status = ''active'', joined_at = now(), provisioned_by = ''scim'' WHERE invitation_token = %L RETURNING ''true''', u, tok));
      ELSIF k.p = 'switch' THEN
        s := pg_temp.mk_switch(u);
        g := pg_temp.q(NULL, 'service_role', format('SELECT public._domain_capture_switch(%L::uuid) ->> ''outcome''', s));
        g := CASE WHEN g = 'switched' THEN 'true' ELSE g END;
      ELSE
        s := pg_temp.mk_switch(u);
        g := pg_temp.q(NULL, 'service_role', format('SELECT public._domain_capture_join_now(%L::uuid, %L::uuid) ->> ''outcome''', s, u));
        g := CASE WHEN g = 'switched' THEN 'true' ELSE g END;
      END IF;
      g := 'joined=' || g || ' personal=' || pg_temp.personal(u) || ' outbox=' || pg_temp.ob(u);
      res := res || pg_temp.rec('G6_' || k.p, g = 'joined=true personal=0 outbox=2:live,test', g);
      RAISE EXCEPTION 'S_DONE';
    EXCEPTION WHEN OTHERS THEN
      IF SQLERRM <> 'S_DONE' THEN res := res || pg_temp.rec('G6_' || k.p, false, 'SETUP ' || SQLSTATE || ' ' || left(SQLERRM, 120)); END IF;
    END;
  END LOOP;

  -- ---- R1: under session_replication_role = replica the guard does not fire (another lane's harness)
  BEGIN
    u := pg_temp.mk_user('r1', false, ARRAY[]::text[]);
    a := pg_temp.mk_brok('A_r1'); b := pg_temp.mk_brok('B_r1');
    INSERT INTO public.organization_members (organization_id, user_id, role, license_status) VALUES (a, u, 'agent', 'active');
    BEGIN
      SET LOCAL session_replication_role = replica;
      INSERT INTO public.organization_members (organization_id, user_id, role, license_status) VALUES (b, u, 'agent', 'active');
      SET LOCAL session_replication_role = origin;
      g := 'allowed rows=' || pg_temp.brok(u);
    EXCEPTION WHEN OTHERS THEN
      SET LOCAL session_replication_role = origin;
      g := 'ERR ' || SQLSTATE || ' ' || SQLERRM;
    END;
    res := res || pg_temp.rec('R1_replica_bypass', g = 'allowed rows=2', g);
    RAISE EXCEPTION 'S_DONE';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM <> 'S_DONE' THEN res := res || pg_temp.rec('R1_replica_bypass', false, 'SETUP ' || SQLSTATE || ' ' || left(SQLERRM, 120)); END IF;
  END;

  INSERT INTO r4179 SELECT e.key, (e.value ->> 0)::boolean, e.value ->> 1 FROM jsonb_each(res) e;

  -- ---- C1: catalog -------------------------------------------------------------------------------
  INSERT INTO r4179 SELECT 'C1_catalog',
      t.tgenabled = 'O' AND p.provolatile = 'v' AND p.prosecdef
      AND NOT has_function_privilege('anon', p.oid, 'EXECUTE')
      AND NOT has_function_privilege('authenticated', p.oid, 'EXECUTE'),
      t.tgenabled::text || ':' || p.provolatile::text || ':' || p.prosecdef::text
    FROM pg_trigger t JOIN pg_proc p ON p.oid = t.tgfoid
   WHERE t.tgrelid = 'public.organization_members'::regclass AND t.tgname = 'single_brokerage_guard';
  IF NOT EXISTS (SELECT 1 FROM r4179 WHERE r4179.k = 'C1_catalog') THEN
    INSERT INTO r4179 VALUES ('C1_catalog', false, 'trigger missing');
  END IF;

  SELECT count(*) FILTER (WHERE ok), count(*) FILTER (WHERE NOT ok),
         coalesce(jsonb_object_agg(r4179.k, got) FILTER (WHERE NOT ok), '{}'::jsonb)
    INTO v_pass, v_fail, reds FROM r4179;
  RAISE EXCEPTION 'P4179_RESULT %', jsonb_build_object('mode', current_setting('p4179.mode', true),
    'pass', v_pass, 'fail', v_fail, 'reds', reds,
    'all', (SELECT jsonb_object_agg(r4179.k, got) FROM r4179));
END
$drv$;
