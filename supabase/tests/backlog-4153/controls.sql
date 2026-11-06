-- BACKLOG-4153 DB controls. Venue: keepr-test, ONE call, ONE transaction that ends in RAISE,
-- so nothing persists. Composed by compose.py (optionally after the migration, in the same call).
-- __MODES__ is replaced by the runner with a comma list of quoted mode names.
-- Each mode runs in its own subtransaction: apply the mutation (exact-once replace, raises on 0
-- or 2+ matches, md5 must change), build the fixtures, run every check, then roll back.
-- Output: RAISE 'P4153_RESULT {mode: {mutation, pass, fail, reds}}'. base also lists every check.
-- Fixtures: new auth users p4153-*@example.test, new organizations P4153 *; nothing existing is
-- read or written.
--
-- Run: compose.py <out.sql> <modes> [--migration N]; ~/.claude/bin/kt-sql <out.sql>; parse.py <output>.
-- Results: results-2026-11-06.txt.
--
-- Fixture writers (SR required change 3):
--   pending invite      client-session INSERT by the org admin, the shape the invite guard allows
--                       (broker-portal inviteUser); claimed by accept_invitation (real RPC).
--   unassigned          set_member_license(member, 'unassign') called by the org admin (real RPC).
--   second brokerage    jit_join_organization(tenant, 'azure_ad') (real RPC; it has no
--                       other-brokerage check). accept_invitation, SCIM and directory sync all
--                       refuse a person already in a brokerage (already_placed).
--   suspended           service UPDATE license_status='suspended' (deactivateUser.ts, SCIM,
--                       directory sync all write it this way).
--   personal org        _ensure_personal_organization_for (real writer; needs a licenses row).
--   expired (g2)        DEFENSIVE: no writer of member license_status 'expired' found in
--                       electron/, src/, broker-portal/, admin-portal/ or supabase/functions.
--   (h) personal active + brokerage unassigned: DEFENSIVE. retire_personal_membership removes
--                       every personal row when a non-deactivated brokerage row is written, and
--                       _ensure_personal_organization_for returns has_membership while one exists.
--                       Probe H0 records the real path (the personal row is gone); (h) is then
--                       built by a direct INSERT of the personal row.

DO $drv$
DECLARE
  v_modes text[] := ARRAY[__MODES__]::text[];
  v_m text;
  v_mut text;
  v_res jsonb := '{}'::jsonb;
  v_r jsonb;
  v_detail text;
BEGIN
  EXECUTE $f$CREATE FUNCTION pg_temp.as_user(u uuid, e text, sid text DEFAULT NULL) RETURNS void LANGUAGE plpgsql AS $b$
  BEGIN
    PERFORM set_config('request.jwt.claims', json_build_object('sub', u, 'role', 'authenticated', 'email', e, 'session_id', sid)::text, true);
    PERFORM set_config('request.jwt.claim.sub', u::text, true);
    PERFORM set_config('request.jwt.claim.role', 'authenticated', true);
  END $b$$f$;

  EXECUTE $f$CREATE FUNCTION pg_temp.mut_fn(p_sig text, p_from text, p_to text) RETURNS text LANGUAGE plpgsql AS $b$
  DECLARE d text; n int; d2 text; m1 text; m2 text; s1 text; s2 text;
  BEGIN
    d := pg_get_functiondef(to_regprocedure(p_sig));
    n := (length(d) - length(replace(d, p_from, ''))) / length(p_from);
    IF n <> 1 THEN RAISE EXCEPTION 'MUTATION NOT APPLIED: % matches in %', n, p_sig; END IF;
    m1 := md5(d);
    SELECT md5(prosrc) INTO s1 FROM pg_proc WHERE oid = to_regprocedure(p_sig);
    EXECUTE replace(d, p_from, p_to);
    d2 := pg_get_functiondef(to_regprocedure(p_sig)); m2 := md5(d2);
    SELECT md5(prosrc) INTO s2 FROM pg_proc WHERE oid = to_regprocedure(p_sig);
    IF m1 = m2 OR s1 = s2 THEN RAISE EXCEPTION 'MUTATION NOT APPLIED: md5 unchanged for %', p_sig; END IF;
    RETURN 'MUTATION APPLIED ' || p_sig || ' prosrc ' || left(s1, 8) || '->' || left(s2, 8);
  END $b$$f$;

  -- GUARD text (from the migration) is injected by compose.py as $g$...$g$.
  EXECUTE $f$CREATE FUNCTION pg_temp.apply_mode(m text) RETURNS text LANGUAGE plpgsql AS $b$
  DECLARE g text := __GUARD__;
  BEGIN
    CASE m
    WHEN 'base' THEN RETURN 'none';
    WHEN 'M1_guard_off' THEN RETURN pg_temp.mut_fn('public.unlock_transaction(text)',
      '  IF EXISTS (SELECT 1', '  IF false AND EXISTS (SELECT 1');
    WHEN 'M2_any_unassigned_refuses' THEN RETURN pg_temp.mut_fn('public.unlock_transaction(text)',
      'AND public.member_status_grants_access(m2.license_status)) THEN', 'AND false) THEN');
    WHEN 'M3_any_non_active_counts' THEN RETURN pg_temp.mut_fn('public.unlock_transaction(text)',
      $q$AND m.license_status = 'unassigned')$q$, $q$AND m.license_status <> 'active')$q$);
    -- the first EXISTS (the unassigned row) replaced by true: refuse whenever no brokerage grants access
    WHEN 'M4_no_active_brokerage_refuses' THEN RETURN pg_temp.mut_fn('public.unlock_transaction(text)',
      $q$  IF EXISTS (SELECT 1
               FROM public.organization_members m
               JOIN public.organizations o ON o.id = m.organization_id
              WHERE m.user_id = v_uid
                AND o.personal_owner_user_id IS NULL
                AND m.license_status = 'unassigned')$q$, '  IF true');
    WHEN 'M5_guard_above_already' THEN RETURN pg_temp.mut_fn('public.unlock_transaction(text)',
      '  SELECT * INTO v_existing', g || '  SELECT * INTO v_existing');
    WHEN 'M6_message_changed' THEN RETURN pg_temp.mut_fn('public.unlock_transaction(text)',
      $q$RAISE EXCEPTION 'not_licensed'$q$, $q$RAISE EXCEPTION 'unlicensed'$q$);
    WHEN 'M7_personal_counts_as_active' THEN RETURN pg_temp.mut_fn('public.unlock_transaction(text)',
      '                AND o2.personal_owner_user_id IS NULL
', '');
    WHEN 'M8_first_brokerage_row_decides' THEN RETURN pg_temp.mut_fn('public.unlock_transaction(text)', g,
      $q$  IF (SELECT m.license_status
        FROM public.organization_members m
        JOIN public.organizations o ON o.id = m.organization_id
       WHERE m.user_id = v_uid AND o.personal_owner_user_id IS NULL
       ORDER BY m.created_at, m.id LIMIT 1) = 'unassigned' THEN
    RAISE EXCEPTION 'not_licensed' USING ERRCODE = 'P0001';
  END IF;

$q$);
    -- regression: the 3853 suspension gate (same mutation as backlog-3853 no_unlock_gate)
    WHEN 'R_no_suspension_gate' THEN RETURN pg_temp.mut_fn('public.unlock_transaction(text)',
      'IF public.org_billing_suspended(public.billing_deciding_org(v_uid)) THEN', 'IF false THEN');
    ELSE RAISE EXCEPTION 'unknown mode %', m;
    END CASE;
  END $b$$f$;

  -- unlock as user u; returns 'unlocked=true' / 'already=true' / '<SQLSTATE>:<message>'
  EXECUTE $f$CREATE FUNCTION pg_temp.try_unlock(u uuid, e text, deal text) RETURNS text LANGUAGE plpgsql AS $b$
  DECLARE v jsonb; s text;
  BEGIN
    BEGIN
      PERFORM pg_temp.as_user(u, e); EXECUTE 'SET LOCAL ROLE authenticated';
      v := public.unlock_transaction(deal);
      EXECUTE 'RESET ROLE';
      s := CASE WHEN v->>'already' = 'true' THEN 'already=true' ELSE 'unlocked=' || coalesce(v->>'unlocked', 'null') END;
    EXCEPTION WHEN OTHERS THEN EXECUTE 'RESET ROLE'; s := SQLSTATE || ':' || SQLERRM; END;
    RETURN s;
  END $b$$f$;

  -- admin of org o invites email e as a licensed ('pending') invite, from a client session
  EXECUTE $f$CREATE FUNCTION pg_temp.invite(adm uuid, adm_e text, o uuid, e text, tok text, created timestamptz) RETURNS void LANGUAGE plpgsql AS $b$
  BEGIN
    PERFORM pg_temp.as_user(adm, adm_e); EXECUTE 'SET LOCAL ROLE authenticated';
    INSERT INTO public.organization_members (organization_id, invited_email, role, license_status,
        invitation_token, invitation_expires_at, invited_by, invited_at, provisioned_by, created_at)
      VALUES (o, e, 'agent', 'pending', tok, now() + interval '7 days', adm, now(), 'invite', created);
    EXECUTE 'RESET ROLE';
  END $b$$f$;

  EXECUTE $f$CREATE FUNCTION pg_temp.accept(u uuid, e text, tok text) RETURNS text LANGUAGE plpgsql AS $b$
  DECLARE v jsonb;
  BEGIN
    PERFORM pg_temp.as_user(u, e); EXECUTE 'SET LOCAL ROLE authenticated';
    v := public.accept_invitation(tok, NULL);
    EXECUTE 'RESET ROLE';
    RETURN coalesce(v->>'success', 'null') || '/' || coalesce(v->>'error', v->>'license_status', '');
  END $b$$f$;

  EXECUTE $f$CREATE FUNCTION pg_temp.unassign(adm uuid, adm_e text, o uuid, u uuid) RETURNS text LANGUAGE plpgsql AS $b$
  DECLARE v jsonb; mid uuid;
  BEGIN
    SELECT id INTO mid FROM public.organization_members WHERE organization_id = o AND user_id = u;
    PERFORM pg_temp.as_user(adm, adm_e); EXECUTE 'SET LOCAL ROLE authenticated';
    v := public.set_member_license(mid, 'unassign');
    EXECUTE 'RESET ROLE';
    RETURN coalesce(v->>'success', 'null') || '/' || coalesce(v->>'error', v->>'license_status', '');
  END $b$$f$;

  -- JIT join of user u into the org whose microsoft_tenant_id is tid, through a fresh OAuth session
  EXECUTE $f$CREATE FUNCTION pg_temp.jit(u uuid, e text, tid text) RETURNS text LANGUAGE plpgsql AS $b$
  DECLARE v jsonb; sid uuid := gen_random_uuid();
  BEGIN
    INSERT INTO auth.identities (provider_id, user_id, identity_data, provider, created_at, updated_at)
      VALUES ('p4153-' || u::text || '-' || tid, u, jsonb_build_object('sub', u::text, 'email', e, 'custom_claims', jsonb_build_object('tid', tid)),
              'azure', now(), now());
    INSERT INTO auth.sessions (id, user_id, created_at, updated_at) VALUES (sid, u, now(), now());
    INSERT INTO auth.mfa_amr_claims (session_id, created_at, updated_at, authentication_method, id)
      VALUES (sid, now(), now(), 'oauth', gen_random_uuid());
    PERFORM pg_temp.as_user(u, e, sid::text); EXECUTE 'SET LOCAL ROLE authenticated';
    v := public.jit_join_organization('azure_ad', tid);
    EXECUTE 'RESET ROLE';
    RETURN coalesce(v->>'success', 'null') || '/' || coalesce(v->>'error', v->>'already_member', '');
  END $b$$f$;

  -- brokerage rows of u as 'status@org-label' ordered by (created_at, id); personal rows as 'personal:status'
  EXECUTE $f$CREATE FUNCTION pg_temp.rows_of(u uuid, oa uuid, ob uuid) RETURNS text LANGUAGE sql AS $b$
    SELECT coalesce(string_agg(CASE WHEN o.personal_owner_user_id IS NOT NULL THEN 'personal:' || m.license_status
                                    WHEN o.id = oa THEN 'A:' || m.license_status
                                    WHEN o.id = ob THEN 'B:' || m.license_status
                                    ELSE 'other:' || m.license_status END, ',' ORDER BY m.created_at, m.id), '')
      FROM public.organization_members m JOIN public.organizations o ON o.id = m.organization_id
     WHERE m.user_id = u
  $b$$f$;

  EXECUTE $f$CREATE FUNCTION pg_temp.run() RETURNS jsonb LANGUAGE plpgsql AS $b$
  DECLARE
    r jsonb := '{}'::jsonb;
    o_a uuid := gen_random_uuid(); o_b uuid := gen_random_uuid();
    t_a text := 'p4153-tid-a-' || left(gen_random_uuid()::text, 8);
    t_b text := 'p4153-tid-b-' || left(gen_random_uuid()::text, 8);
    adm_a uuid := gen_random_uuid(); adm_b uuid := gen_random_uuid();
    u_a uuid := gen_random_uuid(); u_b uuid := gen_random_uuid(); u_c uuid := gen_random_uuid();
    u_d uuid := gen_random_uuid(); u_f uuid := gen_random_uuid(); u_g uuid := gen_random_uuid();
    u_g2 uuid := gen_random_uuid(); u_h uuid := gen_random_uuid(); u_i1 uuid := gen_random_uuid();
    u_i2 uuid := gen_random_uuid(); u_j uuid := gen_random_uuid(); o_s uuid := gen_random_uuid();
    v_team uuid; v_pers uuid; v_hpers uuid;
    s text; s2 text; st text; n1 int; n2 int; k1 int; k2 int; b1 int; b2 int;
    old timestamptz := now() - interval '2 days';
  BEGIN
    SELECT id INTO v_team FROM public.plans WHERE name = 'Team';

    INSERT INTO auth.users (id, email, aud, role, instance_id, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
    SELECT x.id, 'p4153-' || x.n || '@example.test', 'authenticated', 'authenticated', '00000000-0000-0000-0000-000000000000', '{"provider":"email"}', '{}', now(), now()
    FROM (VALUES (adm_a, 'adm-a'), (adm_b, 'adm-b'), (u_a, 'a'), (u_b, 'b'), (u_c, 'c'), (u_d, 'd'), (u_f, 'f'),
                 (u_g, 'g'), (u_g2, 'g2'), (u_h, 'h'), (u_i1, 'i1'), (u_i2, 'i2'), (u_j, 'j')) x(id, n);
    INSERT INTO public.users (id, email, oauth_provider, oauth_id)
    SELECT x.id, 'p4153-' || x.n || '@example.test', 'email', x.id::text
    FROM (VALUES (adm_a, 'adm-a'), (adm_b, 'adm-b'), (u_a, 'a'), (u_b, 'b'), (u_c, 'c'), (u_d, 'd'), (u_f, 'f'),
                 (u_g, 'g'), (u_g2, 'g2'), (u_h, 'h'), (u_i1, 'i1'), (u_i2, 'i2'), (u_j, 'j')) x(id, n)
    ON CONFLICT (id) DO NOTHING;

    INSERT INTO public.organizations (id, name, slug, max_seats, is_test, microsoft_tenant_id, jit_provisioning_enabled, default_member_role) VALUES
      (o_a, 'P4153 A', 'p4153-a-' || left(o_a::text, 8), 50, true, t_a, true, 'agent'),
      (o_b, 'P4153 B', 'p4153-b-' || left(o_b::text, 8), 50, true, t_b, true, 'agent'),
      (o_s, 'P4153 S', 'p4153-s-' || left(o_s::text, 8), 50, true, NULL, false, 'agent');
    INSERT INTO public.organization_plans (organization_id, plan_id, feature_overrides)
    SELECT x, v_team, '{"jit_provisioning":{"enabled":true,"source":"support"}}'::jsonb FROM unnest(ARRAY[o_a, o_b, o_s]) x;
    INSERT INTO public.organization_members (organization_id, user_id, role, license_status, joined_at, provisioned_by) VALUES
      (o_s, u_j, 'agent', 'active', now(), 'manual'),
      (o_a, adm_a, 'admin', 'active', now(), 'manual'),
      (o_b, adm_b, 'admin', 'active', now(), 'manual');
    r := r || jsonb_build_object('P0_jit_allowed', CASE WHEN public._org_feature_allowed(o_a, 'jit_provisioning') AND public._org_feature_allowed(o_b, 'jit_provisioning') THEN 'PASS' ELSE 'FAIL' END);

    -- credit for every fixture user (u_f gets 2: one earlier unlock, one retry)
    INSERT INTO public.credit_ledger (user_id, entry_type, amount)
    SELECT x, 'adjustment', CASE WHEN x = u_f THEN 2 ELSE 1 END
      FROM unnest(ARRAY[u_a, u_b, u_c, u_d, u_f, u_g, u_g2, u_h, u_i1, u_i2, u_j]) x;

    -- (j) regression for the 3853 gate: an active member of a suspended brokerage. The deal row is
    -- written directly (DEFENSIVE shortcut: the real writer admin_suspend_org is what the 3853
    -- harness drives, and that harness currently stops on billing_outbox.dedupe_key, see results).
    INSERT INTO public.org_deals (organization_id, stripe_mode, seats, status, suspended_at, suspended_reason)
      VALUES (o_s, 'test', 10, 'suspended', now(), 'other');
    r := r || jsonb_build_object('Pj_state', CASE WHEN public.org_billing_suspended(o_s) AND public.billing_deciding_org(u_j) = o_s THEN 'PASS' ELSE 'FAIL' END);

    -- (a) unassigned-only: invite A -> accept -> admin unassigns
    PERFORM pg_temp.invite(adm_a, 'p4153-adm-a@example.test', o_a, 'p4153-a@example.test', 'p4153-tok-a', now());
    s := pg_temp.accept(u_a, 'p4153-a@example.test', 'p4153-tok-a');
    s2 := pg_temp.unassign(adm_a, 'p4153-adm-a@example.test', o_a, u_a);
    st := pg_temp.rows_of(u_a, o_a, o_b);
    r := r || jsonb_build_object('Pa_state', CASE WHEN s = 'true/active' AND s2 = 'true/unassigned' AND st = 'A:unassigned' THEN 'PASS' ELSE 'FAIL ' || s || ' ' || s2 || ' ' || st END);

    -- (b) unassigned at A + active at B: invite A (older) -> accept; JIT into B; admin A unassigns
    PERFORM pg_temp.invite(adm_a, 'p4153-adm-a@example.test', o_a, 'p4153-b@example.test', 'p4153-tok-b', old);
    s := pg_temp.accept(u_b, 'p4153-b@example.test', 'p4153-tok-b');
    s := s || ' ' || pg_temp.jit(u_b, 'p4153-b@example.test', t_b);
    s2 := pg_temp.unassign(adm_a, 'p4153-adm-a@example.test', o_a, u_b);
    st := pg_temp.rows_of(u_b, o_a, o_b);
    r := r || jsonb_build_object('Pb_state', CASE WHEN s = 'true/active true/false' AND s2 = 'true/unassigned' AND st = 'A:unassigned,B:active' THEN 'PASS' ELSE 'FAIL ' || s || ' ' || s2 || ' ' || st END);

    -- (c) active member
    PERFORM pg_temp.invite(adm_a, 'p4153-adm-a@example.test', o_a, 'p4153-c@example.test', 'p4153-tok-c', now());
    s := pg_temp.accept(u_c, 'p4153-c@example.test', 'p4153-tok-c');
    st := pg_temp.rows_of(u_c, o_a, o_b);
    r := r || jsonb_build_object('Pc_state', CASE WHEN s = 'true/active' AND st = 'A:active' THEN 'PASS' ELSE 'FAIL ' || s || ' ' || st END);

    -- (d) solo user, personal organization only
    INSERT INTO public.licenses (user_id, license_key) VALUES (u_d, 'p4153-lic-d');
    s := (public._ensure_personal_organization_for(u_d))->>'status';
    st := pg_temp.rows_of(u_d, o_a, o_b);
    r := r || jsonb_build_object('Pd_state', CASE WHEN s = 'created' AND st = 'personal:active' THEN 'PASS' ELSE 'FAIL ' || coalesce(s, 'null') || ' ' || st END);

    -- (f) active member unlocks a deal, is then unassigned, retries the same deal
    PERFORM pg_temp.invite(adm_a, 'p4153-adm-a@example.test', o_a, 'p4153-f@example.test', 'p4153-tok-f', now());
    s := pg_temp.accept(u_f, 'p4153-f@example.test', 'p4153-tok-f');
    s := s || ' ' || pg_temp.try_unlock(u_f, 'p4153-f@example.test', 'p4153-deal-f');
    s2 := pg_temp.unassign(adm_a, 'p4153-adm-a@example.test', o_a, u_f);
    st := pg_temp.rows_of(u_f, o_a, o_b);
    r := r || jsonb_build_object('Pf_state', CASE WHEN s = 'true/active unlocked=true' AND s2 = 'true/unassigned' AND st = 'A:unassigned' THEN 'PASS' ELSE 'FAIL ' || s || ' ' || s2 || ' ' || st END);

    -- (g) suspended-only (no licenses row, so deactivation attaches no personal org)
    PERFORM pg_temp.invite(adm_a, 'p4153-adm-a@example.test', o_a, 'p4153-g@example.test', 'p4153-tok-g', now());
    s := pg_temp.accept(u_g, 'p4153-g@example.test', 'p4153-tok-g');
    UPDATE public.organization_members SET license_status = 'suspended', updated_at = now() WHERE organization_id = o_a AND user_id = u_g;
    st := pg_temp.rows_of(u_g, o_a, o_b);
    r := r || jsonb_build_object('Pg_state', CASE WHEN s = 'true/active' AND st = 'A:suspended' THEN 'PASS' ELSE 'FAIL ' || s || ' ' || st END);

    -- (g2) expired-only: DEFENSIVE (no writer of 'expired' found)
    PERFORM pg_temp.invite(adm_a, 'p4153-adm-a@example.test', o_a, 'p4153-g2@example.test', 'p4153-tok-g2', now());
    s := pg_temp.accept(u_g2, 'p4153-g2@example.test', 'p4153-tok-g2');
    UPDATE public.organization_members SET license_status = 'expired', updated_at = now() WHERE organization_id = o_a AND user_id = u_g2;
    st := pg_temp.rows_of(u_g2, o_a, o_b);
    r := r || jsonb_build_object('Pg2_state', CASE WHEN s = 'true/active' AND st = 'A:expired' THEN 'PASS' ELSE 'FAIL ' || s || ' ' || st END);

    -- (h) DEFENSIVE. H0: the real path - personal org first, then an unlicensed brokerage invite
    -- accepted - leaves no personal row (retire_personal_membership).
    INSERT INTO public.licenses (user_id, license_key) VALUES (u_h, 'p4153-lic-h');
    s := (public._ensure_personal_organization_for(u_h))->>'status';
    SELECT organization_id INTO v_hpers FROM public.organization_members m JOIN public.organizations o ON o.id = m.organization_id
     WHERE m.user_id = u_h AND o.personal_owner_user_id IS NOT NULL;
    PERFORM pg_temp.as_user(adm_a, 'p4153-adm-a@example.test'); EXECUTE 'SET LOCAL ROLE authenticated';
    INSERT INTO public.organization_members (organization_id, invited_email, role, license_status,
        invitation_token, invitation_expires_at, invited_by, invited_at, provisioned_by)
      VALUES (o_a, 'p4153-h@example.test', 'agent', 'unassigned', 'p4153-tok-h', now() + interval '7 days', adm_a, now(), 'invite');
    EXECUTE 'RESET ROLE';
    s := s || ' ' || pg_temp.accept(u_h, 'p4153-h@example.test', 'p4153-tok-h');
    st := pg_temp.rows_of(u_h, o_a, o_b);
    r := r || jsonb_build_object('H0_real_path_retires_personal', CASE WHEN s = 'created true/unassigned' AND st = 'A:unassigned' THEN 'PASS' ELSE 'FAIL ' || s || ' ' || st END);
    INSERT INTO public.organization_members (organization_id, user_id, role, license_status, joined_at)
      VALUES (v_hpers, u_h, 'agent', 'active', now());
    st := pg_temp.rows_of(u_h, o_a, o_b);
    r := r || jsonb_build_object('Ph_state', CASE WHEN st IN ('A:unassigned,personal:active', 'personal:active,A:unassigned') THEN 'PASS' ELSE 'FAIL ' || st END);

    -- (i1) suspended at A (older) + unassigned at B (newer)
    PERFORM pg_temp.invite(adm_a, 'p4153-adm-a@example.test', o_a, 'p4153-i1@example.test', 'p4153-tok-i1', old);
    s := pg_temp.accept(u_i1, 'p4153-i1@example.test', 'p4153-tok-i1');
    UPDATE public.organization_members SET license_status = 'suspended', updated_at = now() WHERE organization_id = o_a AND user_id = u_i1;
    s := s || ' ' || pg_temp.jit(u_i1, 'p4153-i1@example.test', t_b);
    s2 := pg_temp.unassign(adm_b, 'p4153-adm-b@example.test', o_b, u_i1);
    st := pg_temp.rows_of(u_i1, o_a, o_b);
    r := r || jsonb_build_object('Pi1_state', CASE WHEN s = 'true/active true/false' AND s2 = 'true/unassigned' AND st = 'A:suspended,B:unassigned' THEN 'PASS' ELSE 'FAIL ' || s || ' ' || s2 || ' ' || st END);

    -- (i2) unassigned at B (older) + suspended at A (newer)
    PERFORM pg_temp.invite(adm_b, 'p4153-adm-b@example.test', o_b, 'p4153-i2@example.test', 'p4153-tok-i2', old);
    s := pg_temp.accept(u_i2, 'p4153-i2@example.test', 'p4153-tok-i2');
    s2 := pg_temp.unassign(adm_b, 'p4153-adm-b@example.test', o_b, u_i2);
    s := s || ' ' || pg_temp.jit(u_i2, 'p4153-i2@example.test', t_a);
    UPDATE public.organization_members SET license_status = 'suspended', updated_at = now() WHERE organization_id = o_a AND user_id = u_i2;
    st := pg_temp.rows_of(u_i2, o_a, o_b);
    r := r || jsonb_build_object('Pi2_state', CASE WHEN s = 'true/active true/false' AND s2 = 'true/unassigned' AND st = 'B:unassigned,A:suspended' THEN 'PASS' ELSE 'FAIL ' || s || ' ' || s2 || ' ' || st END);

    -- ===== checks =====
    -- (a) + (e)
    SELECT count(*) INTO n1 FROM public.credit_ledger WHERE user_id = u_a AND entry_type = 'debit';
    SELECT count(*) INTO k1 FROM public.transaction_unlocks WHERE user_id = u_a;
    PERFORM pg_temp.as_user(u_a, 'p4153-a@example.test');
    b1 := public.get_credit_balance(u_a);
    s := pg_temp.try_unlock(u_a, 'p4153-a@example.test', 'p4153-deal-a');
    SELECT count(*) INTO n2 FROM public.credit_ledger WHERE user_id = u_a AND entry_type = 'debit';
    SELECT count(*) INTO k2 FROM public.transaction_unlocks WHERE user_id = u_a;
    PERFORM pg_temp.as_user(u_a, 'p4153-a@example.test');
    b2 := public.get_credit_balance(u_a);
    r := r || jsonb_build_object('a_unassigned_only_refused', CASE WHEN s = 'P0001:not_licensed' THEN 'PASS' ELSE 'FAIL ' || s END);
    r := r || jsonb_build_object('e_nothing_spent', CASE WHEN n1 = n2 AND k1 = k2 AND b1 = b2 AND b1 = 1 THEN 'PASS'
      ELSE 'FAIL debits ' || n1 || '->' || n2 || ' unlocks ' || k1 || '->' || k2 || ' balance ' || b1 || '->' || b2 END);

    s := pg_temp.try_unlock(u_b, 'p4153-b@example.test', 'p4153-deal-b');
    r := r || jsonb_build_object('b_unassigned_A_active_B_allowed', CASE WHEN s = 'unlocked=true' THEN 'PASS' ELSE 'FAIL ' || s END);
    s := pg_temp.try_unlock(u_c, 'p4153-c@example.test', 'p4153-deal-c');
    r := r || jsonb_build_object('c_active_allowed', CASE WHEN s = 'unlocked=true' THEN 'PASS' ELSE 'FAIL ' || s END);
    s := pg_temp.try_unlock(u_d, 'p4153-d@example.test', 'p4153-deal-d');
    r := r || jsonb_build_object('d_personal_only_allowed', CASE WHEN s = 'unlocked=true' THEN 'PASS' ELSE 'FAIL ' || s END);
    s := pg_temp.try_unlock(u_f, 'p4153-f@example.test', 'p4153-deal-f');
    r := r || jsonb_build_object('f_earlier_unlock_returns_already', CASE WHEN s = 'already=true' THEN 'PASS' ELSE 'FAIL ' || s END);
    s := pg_temp.try_unlock(u_g, 'p4153-g@example.test', 'p4153-deal-g');
    r := r || jsonb_build_object('g_suspended_only_allowed', CASE WHEN s = 'unlocked=true' THEN 'PASS' ELSE 'FAIL ' || s END);
    s := pg_temp.try_unlock(u_g2, 'p4153-g2@example.test', 'p4153-deal-g2');
    r := r || jsonb_build_object('g2_expired_only_allowed', CASE WHEN s = 'unlocked=true' THEN 'PASS' ELSE 'FAIL ' || s END);
    s := pg_temp.try_unlock(u_h, 'p4153-h@example.test', 'p4153-deal-h');
    r := r || jsonb_build_object('h_unassigned_plus_personal_refused', CASE WHEN s = 'P0001:not_licensed' THEN 'PASS' ELSE 'FAIL ' || s END);
    s := pg_temp.try_unlock(u_i1, 'p4153-i1@example.test', 'p4153-deal-i1');
    r := r || jsonb_build_object('i1_suspended_older_unassigned_newer_refused', CASE WHEN s = 'P0001:not_licensed' THEN 'PASS' ELSE 'FAIL ' || s END);
    s := pg_temp.try_unlock(u_i2, 'p4153-i2@example.test', 'p4153-deal-i2');
    r := r || jsonb_build_object('i2_unassigned_older_suspended_newer_refused', CASE WHEN s = 'P0001:not_licensed' THEN 'PASS' ELSE 'FAIL ' || s END);

    s := pg_temp.try_unlock(u_j, 'p4153-j@example.test', 'p4153-deal-j');
    r := r || jsonb_build_object('j_suspended_brokerage_still_account_suspended', CASE WHEN s = 'P0001:account_suspended' THEN 'PASS' ELSE 'FAIL ' || s END);

    RETURN r;
  END $b$$f$;

  FOREACH v_m IN ARRAY v_modes LOOP
    BEGIN
      v_mut := pg_temp.apply_mode(v_m);
      v_r := pg_temp.run();
      RAISE EXCEPTION 'MODE_DONE' USING DETAIL = (jsonb_build_object('mutation', v_mut, 'checks', v_r))::text;
    EXCEPTION WHEN OTHERS THEN
      IF SQLERRM = 'MODE_DONE' THEN
        GET STACKED DIAGNOSTICS v_detail = PG_EXCEPTION_DETAIL;
        v_r := v_detail::jsonb;
        v_res := v_res || jsonb_build_object(v_m, jsonb_build_object(
          'mutation', v_r->'mutation',
          'checks', (SELECT count(*) FROM jsonb_each_text(v_r->'checks')),
          'pass', (SELECT count(*) FROM jsonb_each_text(v_r->'checks') e WHERE e.value = 'PASS'),
          'fail', (SELECT count(*) FROM jsonb_each_text(v_r->'checks') e WHERE e.value <> 'PASS'),
          'reds', (SELECT coalesce(jsonb_object_agg(e.key, e.value), '{}'::jsonb) FROM jsonb_each_text(v_r->'checks') e WHERE e.value <> 'PASS')));
      ELSE
        v_res := v_res || jsonb_build_object(v_m, 'ERROR ' || SQLSTATE || ' ' || left(SQLERRM, 300));
      END IF;
    END;
  END LOOP;
  RAISE EXCEPTION 'P4153_RESULT %', v_res;
END
$drv$;
