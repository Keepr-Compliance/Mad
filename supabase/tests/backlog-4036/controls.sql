-- BACKLOG-4036 DB controls (organization activity log: member / phone triggers, the reader).
-- Venue: keepr-test, ONE call, ONE transaction ending in RAISE, so nothing persists. Run after
-- 20261021060000 is applied, or compose it in front (compose.py --with-migration).
-- __MODES__ is replaced with a comma list of quoted mode names. Each mode runs in its own
-- subtransaction: apply the mutation (exact-once replace that raises on 0 or 2+ matches; the md5
-- of pg_get_functiondef must change, else MUTATION NOT APPLIED), build fixtures, run every check,
-- roll back. 'base' = no mutation (every check must PASS).
-- One kt-sql call is one transaction, so every row shares one txid. pg_temp.step() stands in for
-- a transaction boundary: it returns the rows written since the last step and re-keys them to a
-- step-unique txid, which is what the reader's dedupe compares.
-- Write shapes are transcribed from the TS writers (file:line next to each check).
-- Output: RAISE 'P4036_RESULT {mode: {mutation, pass, fail, reds}}'.
-- Fixtures: auth users p4036-*@example.test, organizations "P4036 *" (is_test), phones 555-01xx.
-- Every id is generated at run time.

DO $drv$
DECLARE
  v_modes text[] := ARRAY[__MODES__]::text[];
  v_m text;
  v_mut text;
  v_res jsonb := '{}'::jsonb;
  v_r jsonb;
  v_detail text;
BEGIN
  EXECUTE $f$CREATE FUNCTION pg_temp.as_user(u uuid, hdr text) RETURNS void LANGUAGE plpgsql AS $b$
  BEGIN
    PERFORM set_config('request.jwt.claims', json_build_object('sub', u, 'role', 'authenticated')::text, true);
    PERFORM set_config('request.jwt.claim.sub', u::text, true);
    PERFORM set_config('request.jwt.claim.role', 'authenticated', true);
    PERFORM set_config('request.headers', coalesce(hdr, '{}'), true);
  END $b$$f$;

  -- a statement as an authenticated user (optional request headers json): 'ok:<rows>' or 'ERR ...'
  EXECUTE $f$CREATE FUNCTION pg_temp.exec_as(u uuid, q text, hdr text DEFAULT NULL) RETURNS text LANGUAGE plpgsql AS $b$
  DECLARE n int;
  BEGIN
    BEGIN
      PERFORM pg_temp.as_user(u, hdr);
      EXECUTE 'SET LOCAL ROLE authenticated';
      EXECUTE q;
      GET DIAGNOSTICS n = ROW_COUNT;
      EXECUTE 'RESET ROLE';
      PERFORM pg_temp.clear_claims();
      RETURN 'ok:' || n;
    EXCEPTION WHEN OTHERS THEN
      EXECUTE 'RESET ROLE';
      PERFORM pg_temp.clear_claims();
      RETURN 'ERR ' || SQLSTATE || ' ' || left(SQLERRM, 80);
    END;
  END $b$$f$;

  -- a query returning one jsonb value as an authenticated user
  EXECUTE $f$CREATE FUNCTION pg_temp.call_as(u uuid, q text) RETURNS text LANGUAGE plpgsql AS $b$
  DECLARE v jsonb;
  BEGIN
    BEGIN
      PERFORM pg_temp.as_user(u, NULL);
      EXECUTE 'SET LOCAL ROLE authenticated';
      EXECUTE q INTO v;
      EXECUTE 'RESET ROLE';
      PERFORM pg_temp.clear_claims();
      RETURN coalesce(v::text, 'null');
    EXCEPTION WHEN OTHERS THEN
      EXECUTE 'RESET ROLE';
      PERFORM pg_temp.clear_claims();
      RETURN 'ERR ' || SQLSTATE || ' ' || left(SQLERRM, 80);
    END;
  END $b$$f$;

  -- a statement as the service role, with the request headers PostgREST would set
  EXECUTE $f$CREATE FUNCTION pg_temp.as_service(q text, hdr text DEFAULT NULL) RETURNS text LANGUAGE plpgsql AS $b$
  DECLARE n int;
  BEGIN
    BEGIN
      PERFORM set_config('request.jwt.claims', '{"role":"service_role"}', true);
      PERFORM set_config('request.jwt.claim.sub', '', true);
      PERFORM set_config('request.headers', coalesce(hdr, '{}'), true);
      EXECUTE 'SET LOCAL ROLE service_role';
      EXECUTE q;
      GET DIAGNOSTICS n = ROW_COUNT;
      EXECUTE 'RESET ROLE';
      PERFORM pg_temp.clear_claims();
      RETURN 'ok:' || n;
    EXCEPTION WHEN OTHERS THEN
      EXECUTE 'RESET ROLE';
      PERFORM pg_temp.clear_claims();
      RETURN 'ERR ' || SQLSTATE || ' ' || left(SQLERRM, 80);
    END;
  END $b$$f$;

  EXECUTE $f$CREATE FUNCTION pg_temp.clear_claims() RETURNS void LANGUAGE plpgsql AS $b$
  BEGIN
    PERFORM set_config('request.jwt.claims', '', true);
    PERFORM set_config('request.jwt.claim.sub', '', true);
    PERFORM set_config('request.jwt.claim.role', '', true);
    PERFORM set_config('request.headers', '', true);
  END $b$$f$;

  EXECUTE $f$CREATE FUNCTION pg_temp.hdr(u uuid) RETURNS text LANGUAGE sql AS $b$
    SELECT json_build_object('x-keepr-actor', u)::text
  $b$$f$;

  -- rows written since the last step (all organizations), then re-keyed to a step-unique txid
  EXECUTE $f$CREATE FUNCTION pg_temp.step() RETURNS jsonb LANGUAGE plpgsql AS $b$
  DECLARE v jsonb; k bigint;
  BEGIN
    SELECT coalesce(jsonb_agg(jsonb_build_object('a', c.action, 'by', c.actor_id, 'org', c.organization_id,
                                                 'd', c.detail, 'src', c.source) ORDER BY c.action), '[]'::jsonb)
      INTO v FROM public.billing_change_log c WHERE c.txid = txid_current();
    k := nextval('pg_temp.p4036_step');
    UPDATE public.billing_change_log c SET txid = -k WHERE c.txid = txid_current();
    RETURN v;
  END $b$$f$;
  -- the actions of a step, sorted, as text: 'a,b'
  EXECUTE $f$CREATE FUNCTION pg_temp.acts(v jsonb) RETURNS text LANGUAGE sql AS $b$
    SELECT coalesce(string_agg(e ->> 'a', ',' ORDER BY e ->> 'a'), '') FROM jsonb_array_elements(v) e
  $b$$f$;
  -- the single row of a step is <action> by <actor>
  EXECUTE $f$CREATE FUNCTION pg_temp.one(v jsonb, a text, by uuid) RETURNS boolean LANGUAGE sql AS $b$
    SELECT jsonb_array_length(v) = 1 AND v -> 0 ->> 'a' = a AND (v -> 0 ->> 'by') IS NOT DISTINCT FROM by::text
  $b$$f$;

  EXECUTE $f$CREATE FUNCTION pg_temp.mut_fn(p_sig text, p_from text, p_to text) RETURNS text LANGUAGE plpgsql AS $b$
  DECLARE d text; n int; d2 text; m1 text; m2 text;
  BEGIN
    d := pg_get_functiondef(to_regprocedure(p_sig));
    n := (length(d) - length(replace(d, p_from, ''))) / length(p_from);
    IF n <> 1 THEN RAISE EXCEPTION 'MUTATION NOT APPLIED: % matches in %', n, p_sig; END IF;
    m1 := md5(d);
    EXECUTE replace(d, p_from, p_to);
    d2 := pg_get_functiondef(to_regprocedure(p_sig)); m2 := md5(d2);
    IF m1 = m2 THEN RAISE EXCEPTION 'MUTATION NOT APPLIED: md5 unchanged for %', p_sig; END IF;
    RETURN 'MUTATION APPLIED ' || p_sig || ' ' || left(m1, 8) || '->' || left(m2, 8) || ' [' || left(p_to, 90) || ']';
  END $b$$f$;

  EXECUTE $f$CREATE FUNCTION pg_temp.pass(ok boolean, info text) RETURNS text LANGUAGE sql AS $b$
    SELECT CASE WHEN coalesce(ok, false) THEN 'PASS' ELSE 'FAIL ' || coalesce(left(info, 220), '') END
  $b$$f$;
  EXECUTE $f$CREATE FUNCTION pg_temp.mem(o uuid, u uuid) RETURNS uuid LANGUAGE sql AS $b$
    SELECT m.id FROM public.organization_members m WHERE m.organization_id = o AND m.user_id = u
  $b$$f$;
  -- the reader as a user, as jsonb (an error text becomes {"err": ...})
  EXECUTE $f$CREATE FUNCTION pg_temp.feed(u uuid, o uuid) RETURNS jsonb LANGUAGE plpgsql AS $b$
  DECLARE s text;
  BEGIN
    s := pg_temp.call_as(u, format('SELECT public.admin_get_org_activity(%L::uuid)', o));
    IF s LIKE 'ERR%' THEN RETURN jsonb_build_object('err', s); END IF;
    RETURN s::jsonb;
  END $b$$f$;
  EXECUTE $f$CREATE FUNCTION pg_temp.feed_count(f jsonb, a text) RETURNS int LANGUAGE sql AS $b$
    SELECT count(*)::int FROM jsonb_array_elements(CASE WHEN jsonb_typeof(f) = 'array' THEN f ELSE '[]'::jsonb END) e WHERE e ->> 'action' = a
  $b$$f$;

  EXECUTE $f$CREATE FUNCTION pg_temp.feed_acts(f jsonb) RETURNS text LANGUAGE sql AS $b$
    SELECT coalesce(string_agg(e ->> 'action', ',' ORDER BY e ->> 'action'), coalesce(f ->> 'err', ''))
      FROM jsonb_array_elements(CASE WHEN jsonb_typeof(f) = 'array' THEN f ELSE '[]'::jsonb END) e
  $b$$f$;

  EXECUTE $f$CREATE FUNCTION pg_temp.apply_mode(m text) RETURNS text LANGUAGE plpgsql AS $b$
  DECLARE
    mt text := 'public._org_member_change_log()';
    pt text := 'public._user_phone_change_log()';
    ac text := 'public._activity_actor()';
    rd text := 'public.admin_get_org_activity(uuid,integer)';
    s1 text;
  BEGIN
    CASE m
    WHEN 'base' THEN RETURN 'none';
    -- wrong build #1: the role row is written on every UPDATE
    WHEN 'm1_role_every_update' THEN RETURN pg_temp.mut_fn(mt,
      $q$IF NEW.role IS DISTINCT FROM OLD.role THEN$q$, $q$IF true THEN$q$);
    -- the role branch taken out
    WHEN 'm1b_no_role_branch' THEN RETURN pg_temp.mut_fn(mt,
      $q$IF NEW.role IS DISTINCT FROM OLD.role THEN$q$, $q$IF false THEN$q$);
    -- the licence row is written on every UPDATE
    WHEN 'm1c_license_every_update' THEN RETURN pg_temp.mut_fn(mt,
      $q$IF NEW.license_status IS DISTINCT FROM OLD.license_status THEN$q$, $q$IF true THEN$q$);
    -- accepting does not short-circuit (the token clear and licence flip also log)
    WHEN 'm1d_accept_not_exclusive' THEN RETURN pg_temp.mut_fn(mt,
      $q$ELSIF OLD.user_id IS NULL AND NEW.user_id IS NOT NULL THEN$q$, $q$ELSIF false THEN$q$);
    -- the phone trigger logs a re-save of the same number
    WHEN 'm2_phone_same_value' THEN RETURN pg_temp.mut_fn(pt,
      $q$IF TG_OP = 'UPDATE' AND NEW.phone IS NOT DISTINCT FROM OLD.phone THEN$q$, $q$IF false THEN$q$);
    -- SR change 8: pending-row removals log phone_changed
    WHEN 'm2b_log_pending_removal' THEN RETURN pg_temp.mut_fn(pt,
      $q$IF TG_OP = 'DELETE' AND OLD.pending_member_id IS NOT NULL THEN$q$, $q$IF false THEN$q$);
    -- wrong build #2: no dedupe
    WHEN 'm3_no_dedupe' THEN RETURN pg_temp.mut_fn(rd,
      $q$AND NOT (c.source IS NOT DISTINCT FROM 'trigger' AND EXISTS ($q$, $q$AND NOT (false AND EXISTS ($q$);
    -- SR change 2: old_member_id not mapped
    WHEN 'm3b_no_old_member_id' THEN RETURN pg_temp.mut_fn(rd,
      $q$IN (e.detail ->> 'member_id', e.detail ->> 'old_member_id')$q$, $q$IN (e.detail ->> 'member_id')$q$);
    -- the staff twin let through
    WHEN 'm3c_aal_twin' THEN RETURN pg_temp.mut_fn(rd,
      $q$a.action IN ('organization.created', 'org_plan.assigned')$q$, $q$a.action IN ('organization.created', 'org_plan.assigned', 'billing.deal_saved')$q$);
    -- wrong build #3: the header is read first (whenever present)
    WHEN 'm4_header_first' THEN RETURN pg_temp.mut_fn(ac,
      $q$IF v_role IS DISTINCT FROM 'service_role' THEN$q$,
      $q$IF v_role IS DISTINCT FROM 'service_role' AND coalesce(current_setting('request.headers', true), '') NOT LIKE '%x-keepr-actor%' THEN$q$);
    -- the billing.view filter taken out
    WHEN 'm5_no_billing_filter' THEN RETURN pg_temp.mut_fn(rd,
      $q$AND (v_billing OR c.action NOT IN$q$, $q$AND (true OR c.action NOT IN$q$);
    -- the detail whitelist taken out
    WHEN 'm5b_no_whitelist' THEN RETURN pg_temp.mut_fn(rd,
      $q$WHERE k.key IN ('from', 'to',$q$, $q$WHERE true OR k.key IN ('from', 'to',$q$);
    -- the reader's permission gate taken out
    WHEN 'm5c_no_gate' THEN RETURN pg_temp.mut_fn(rd,
      $q$IF NOT public.has_permission(v_uid, 'organizations.view') THEN$q$, $q$IF false THEN$q$);
    -- the organization-gone skip taken out (SR change 5)
    WHEN 'm6_no_org_gone_skip' THEN RETURN pg_temp.mut_fn(mt,
      $q$IF NOT FOUND OR v_personal IS NOT NULL THEN$q$, $q$IF v_personal IS NOT NULL THEN$q$);
    -- the personal-organization skip taken out
    WHEN 'm6b_no_personal_skip' THEN RETURN pg_temp.mut_fn(mt,
      $q$IF NOT FOUND OR v_personal IS NOT NULL THEN$q$, $q$IF NOT FOUND THEN$q$);
    -- the phone trigger raises when no organization resolves, with the pending skip gone too
    -- (the shape SR measured: an invite cancel with a phone then fails)
    WHEN 'm6c_phone_raises_no_org' THEN
      s1 := pg_temp.mut_fn(pt, $q$IF TG_OP = 'DELETE' AND OLD.pending_member_id IS NOT NULL THEN$q$, $q$IF false THEN$q$);
      RETURN s1 || ' + ' || pg_temp.mut_fn(pt,
        $q$      OR (r.pending_member_id IS NULL AND r.user_id IS NOT NULL AND m.user_id = r.user_id);$q$,
        $q$      OR (r.pending_member_id IS NULL AND r.user_id IS NOT NULL AND m.user_id = r.user_id);
  IF NOT FOUND AND TG_OP = 'DELETE' THEN RAISE EXCEPTION 'no org'; END IF;$q$);
    ELSE RAISE EXCEPTION 'unknown mode %', m;
    END CASE;
  END $b$$f$;

  EXECUTE $f$CREATE FUNCTION pg_temp.run() RETURNS jsonb LANGUAGE plpgsql AS $b$
  DECLARE
    r jsonb := '{}'::jsonb;
    o1 uuid := gen_random_uuid();  -- the main brokerage
    o2 uuid := gen_random_uuid();  -- one admin, IdP-provisioned (last-admin refusal)
    o3 uuid := gen_random_uuid();  -- org_contact_save it_admin path (dedupe)
    o4 uuid := gen_random_uuid();  -- billing-login rekey shape (old_member_id)
    o5 uuid := gen_random_uuid();  -- removed organization
    op uuid := gen_random_uuid();  -- personal organization of u_p
    u_a uuid := gen_random_uuid(); u_g1 uuid := gen_random_uuid(); u_g2 uuid := gen_random_uuid();
    u_g3 uuid := gen_random_uuid(); u_s uuid := gen_random_uuid(); u_new uuid := gen_random_uuid();
    u_c1 uuid := gen_random_uuid(); u_c2 uuid := gen_random_uuid();
    u_a2 uuid := gen_random_uuid(); u_a3 uuid := gen_random_uuid(); u_g4 uuid := gen_random_uuid();
    u_a5 uuid := gen_random_uuid(); u_g5 uuid := gen_random_uuid(); u_p uuid := gen_random_uuid();
    u_sup uuid := gen_random_uuid(); u_sales uuid := gen_random_uuid();
    s text; v jsonb; f jsonb; i1 uuid; i2 uuid; i3 uuid; i4 uuid; i5 uuid; i6 uuid; i7 uuid;
  BEGIN
    EXECUTE 'CREATE TEMP SEQUENCE IF NOT EXISTS p4036_step';
    INSERT INTO auth.users (id, email, aud, role, instance_id, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
    SELECT x, 'p4036-' || left(x::text, 8) || '@example.test', 'authenticated', 'authenticated',
           '00000000-0000-0000-0000-000000000000', '{"provider":"email"}', '{}', now(), now()
      FROM unnest(ARRAY[u_a, u_g1, u_g2, u_g3, u_s, u_new, u_c1, u_c2, u_a2, u_a3, u_g4, u_a5, u_g5, u_p, u_sup, u_sales]) x;
    INSERT INTO public.users (id, email, oauth_provider, oauth_id, display_name)
    SELECT x, (SELECT a.email FROM auth.users a WHERE a.id = x), 'email', x::text, 'P4036 ' || left(x::text, 4)
      FROM unnest(ARRAY[u_a, u_g1, u_g2, u_g3, u_s, u_new, u_c1, u_c2, u_a2, u_a3, u_g4, u_a5, u_g5, u_p, u_sup, u_sales]) x
    ON CONFLICT (id) DO NOTHING;
    INSERT INTO public.internal_roles (user_id, role_id) SELECT u_sup, ar.id FROM public.admin_roles ar WHERE ar.slug = 'support-agent';
    INSERT INTO public.internal_roles (user_id, role_id) SELECT u_sales, ar.id FROM public.admin_roles ar WHERE ar.slug = 'sales';
    INSERT INTO public.organizations (id, name, slug, max_seats, is_test)
    SELECT x, 'P4036 ' || left(x::text, 8), 'p4036-' || left(x::text, 8), 20, true FROM unnest(ARRAY[o1, o2, o3, o4, o5]) x;
    INSERT INTO public.organizations (id, name, slug, max_seats, is_test, personal_owner_user_id)
    VALUES (op, 'P4036 personal', 'p4036-p-' || left(op::text, 8), 1, true, u_p);
    INSERT INTO public.organization_members (organization_id, user_id, role, license_status, joined_at, provisioned_by) VALUES
      (o1, u_a,  'admin', 'active', now(), 'invite'),
      (o1, u_g1, 'agent', 'active', now(), 'invite'),
      (o1, u_g2, 'agent', 'active', now(), 'invite'),
      (o1, u_g3, 'agent', 'active', now(), 'invite'),
      (o1, u_s,  'agent', 'active', now(), 'scim'),
      (o2, u_a2, 'admin', 'active', now(), 'scim'),
      (o3, u_a3, 'admin', 'active', now(), 'invite'),
      (o3, u_g4, 'agent', 'active', now(), 'invite'),
      (o5, u_a5, 'admin', 'active', now(), 'invite'),
      (o5, u_g5, 'agent', 'active', now(), 'invite');
    -- pending invites: i2 (admin cancel), i3 (admin resend), i4 (accept, claim removal), i5 (accept,
    -- claim update), i6 (broker removal of an invite with a phone), i7 (accept_invitation)
    INSERT INTO public.organization_members (organization_id, role, license_status, invited_email, invitation_token, invitation_expires_at, provisioned_by)
    VALUES (o1, 'agent', 'pending', 'p4036-i2@example.test', md5(random()::text), now() + interval '7 days', 'invite') RETURNING id INTO i2;
    INSERT INTO public.organization_members (organization_id, role, license_status, invited_email, invitation_token, invitation_expires_at, provisioned_by)
    VALUES (o1, 'agent', 'pending', 'p4036-i3@example.test', md5(random()::text), now() + interval '7 days', 'invite') RETURNING id INTO i3;
    INSERT INTO public.organization_members (organization_id, role, license_status, invited_email, invitation_token, invitation_expires_at, provisioned_by)
    VALUES (o1, 'agent', 'pending', (SELECT email FROM auth.users WHERE id = u_c1), md5(random()::text), now() + interval '7 days', 'invite') RETURNING id INTO i4;
    INSERT INTO public.organization_members (organization_id, role, license_status, invited_email, invitation_token, invitation_expires_at, provisioned_by)
    VALUES (o1, 'agent', 'pending', (SELECT email FROM auth.users WHERE id = u_c2), md5(random()::text), now() + interval '7 days', 'invite') RETURNING id INTO i5;
    INSERT INTO public.organization_members (organization_id, role, license_status, invited_email, invitation_token, invitation_expires_at, provisioned_by)
    VALUES (o1, 'agent', 'pending', 'p4036-i6@example.test', md5(random()::text), now() + interval '7 days', 'invite') RETURNING id INTO i6;
    INSERT INTO public.organization_members (organization_id, role, license_status, invited_email, invitation_token, invitation_expires_at, provisioned_by)
    VALUES (o1, 'agent', 'pending', (SELECT email FROM auth.users WHERE id = u_new), md5(random()::text), now() + interval '7 days', 'invite') RETURNING id INTO i7;
    INSERT INTO public.user_phones (pending_member_id, phone) VALUES (i4, '+12065550111'), (i5, '+12065550112'), (i6, '+12065550113');
    INSERT INTO public.user_phones (user_id, phone) VALUES (u_c1, '+12065550114');
    v := pg_temp.step();  -- the fixture rows
    r := r || jsonb_build_object('F0_fixtures_logged', pg_temp.pass(
      pg_temp.acts(v) LIKE '%member_added%' AND pg_temp.acts(v) LIKE '%member_invited%'
      AND (SELECT count(*) FROM jsonb_array_elements(v) e WHERE e ->> 'org' = op::text) = 0, pg_temp.acts(v)));

    -- ===== C1: one row per writer =====
    -- inviteUser.ts:205-219
    s := pg_temp.exec_as(u_a, format($q$INSERT INTO public.organization_members (organization_id, invited_email, role, license_status,
      invitation_token, invitation_expires_at, invited_by, invited_at, provisioned_by, invited_first_name, invited_last_name)
      VALUES (%L, 'p4036-i1@example.test', 'agent', 'pending', %L, now() + interval '7 days', %L, now(), 'invite', 'Pat', 'Doe')$q$,
      o1, md5(random()::text), u_a));
    SELECT m.id INTO i1 FROM public.organization_members m WHERE m.organization_id = o1 AND m.invited_email = 'p4036-i1@example.test';
    v := pg_temp.step();
    r := r || jsonb_build_object('C1a_invite', pg_temp.pass(s = 'ok:1' AND pg_temp.one(v, 'member_invited', u_a)
      AND v -> 0 -> 'd' ->> 'name' = 'Pat Doe', s || ' ' || v::text));
    -- resendInvite.ts:71-77
    s := pg_temp.exec_as(u_a, format('UPDATE public.organization_members SET invitation_token = %L, invitation_expires_at = now() + interval %L WHERE id = %L',
      md5(random()::text), '7 days', i1));
    v := pg_temp.step();
    r := r || jsonb_build_object('C1b_resend', pg_temp.pass(s = 'ok:1' AND pg_temp.one(v, 'invite_resent', u_a), s || ' ' || v::text));
    -- updateUserRole.ts:123-128
    s := pg_temp.exec_as(u_a, format('UPDATE public.organization_members SET role = %L, updated_at = now() WHERE id = %L', 'broker', pg_temp.mem(o1, u_g1)));
    v := pg_temp.step();
    r := r || jsonb_build_object('C1c_update_role', pg_temp.pass(s = 'ok:1' AND pg_temp.one(v, 'member_role_changed', u_a)
      AND v -> 0 -> 'd' ->> 'from' = 'agent' AND v -> 0 -> 'd' ->> 'to' = 'broker', s || ' ' || v::text));
    -- bulkUpdateRole.ts:73-78 (two members, one statement): one row each
    s := pg_temp.exec_as(u_a, format('UPDATE public.organization_members SET role = %L, updated_at = now() WHERE organization_id = %L AND id IN (%L, %L) AND user_id <> %L',
      'broker', o1, pg_temp.mem(o1, u_g2), pg_temp.mem(o1, u_g3), u_a));
    v := pg_temp.step();
    r := r || jsonb_build_object('C1d_bulk_role', pg_temp.pass(s = 'ok:2' AND pg_temp.acts(v) = 'member_role_changed,member_role_changed', s || ' ' || v::text));
    -- deactivateUser.ts:129-136 (service client + x-keepr-actor)
    s := pg_temp.as_service(format('UPDATE public.organization_members SET license_status = %L, updated_at = now() WHERE id = %L AND organization_id = %L',
      'suspended', pg_temp.mem(o1, u_g1), o1), pg_temp.hdr(u_a));
    v := pg_temp.step();
    r := r || jsonb_build_object('C1e_deactivate_service_actor', pg_temp.pass(s = 'ok:1' AND pg_temp.one(v, 'member_license_changed', u_a)
      AND v -> 0 -> 'd' ->> 'to' = 'suspended', s || ' ' || v::text));
    -- memberLicense.ts:67 set_member_license reactivate / unassign / assign
    s := pg_temp.call_as(u_a, format('SELECT public.set_member_license(%L::uuid, %L)', pg_temp.mem(o1, u_g1), 'reactivate'));
    v := pg_temp.step();
    r := r || jsonb_build_object('C1f_reactivate', pg_temp.pass(s LIKE '%"success": true%' AND pg_temp.one(v, 'member_license_changed', u_a), s || ' ' || v::text));
    s := pg_temp.call_as(u_a, format('SELECT public.set_member_license(%L::uuid, %L)', pg_temp.mem(o1, u_g2), 'unassign'));
    v := pg_temp.step();
    r := r || jsonb_build_object('C1g_unassign', pg_temp.pass(s LIKE '%"success": true%' AND pg_temp.one(v, 'member_license_changed', u_a)
      AND v -> 0 -> 'd' ->> 'to' = 'unassigned', s || ' ' || v::text));
    s := pg_temp.call_as(u_a, format('SELECT public.set_member_license(%L::uuid, %L)', pg_temp.mem(o1, u_g2), 'assign'));
    v := pg_temp.step();
    r := r || jsonb_build_object('C1h_assign', pg_temp.pass(s LIKE '%"success": true%' AND pg_temp.one(v, 'member_license_changed', u_a), s || ' ' || v::text));
    -- removeUser.ts:112-115
    s := pg_temp.exec_as(u_a, format('DELETE FROM public.organization_members WHERE id = %L', pg_temp.mem(o1, u_g3)));
    v := pg_temp.step();
    r := r || jsonb_build_object('C1i_remove', pg_temp.pass(s = 'ok:1' AND pg_temp.one(v, 'member_removed', u_a)
      AND v -> 0 -> 'd' ->> 'email' LIKE 'p4036-%@example.test', s || ' ' || v::text));
    -- myPhone.ts:26 my_phone_set
    s := pg_temp.call_as(u_g2, $q$SELECT public.my_phone_set('+1 206 555 0101')$q$);
    v := pg_temp.step();
    r := r || jsonb_build_object('C1j_my_phone', pg_temp.pass(s LIKE '%"success": true%' AND pg_temp.one(v, 'phone_changed', u_g2)
      AND v -> 0 -> 'd' ->> 'member_id' = pg_temp.mem(o1, u_g2)::text AND v -> 0 -> 'd' ->> 'cleared' = 'false', s || ' ' || v::text));
    -- admin cancel-invite/route.ts:97-99 (service client + x-keepr-actor of the staff user)
    s := pg_temp.as_service(format('DELETE FROM public.organization_members WHERE id = %L', i2), pg_temp.hdr(u_sup));
    v := pg_temp.step();
    r := r || jsonb_build_object('C1k_admin_cancel', pg_temp.pass(s = 'ok:1' AND pg_temp.one(v, 'invite_cancelled', u_sup), s || ' ' || v::text));
    -- admin resend-invite/route.ts:120-126
    s := pg_temp.as_service(format('UPDATE public.organization_members SET invitation_token = %L, invitation_expires_at = now() + interval %L WHERE id = %L',
      md5(random()::text), '7 days', i3), pg_temp.hdr(u_sup));
    v := pg_temp.step();
    r := r || jsonb_build_object('C1l_admin_resend', pg_temp.pass(s = 'ok:1' AND pg_temp.one(v, 'invite_resent', u_sup), s || ' ' || v::text));
    -- SCIM users.ts:238 shape (service, no header): role + scim_synced_at
    s := pg_temp.as_service(format('UPDATE public.organization_members SET role = %L, scim_synced_at = now() + interval %L WHERE id = %L',
      'broker', '1 second', pg_temp.mem(o1, u_s)));
    v := pg_temp.step();
    r := r || jsonb_build_object('C1m_scim_role', pg_temp.pass(s = 'ok:1' AND pg_temp.one(v, 'member_role_changed', NULL)
      AND v -> 0 -> 'd' ->> 'via' = 'directory', s || ' ' || v::text));
    -- accept_invitation (the real function, as the invited user)
    s := pg_temp.call_as(u_new, format('SELECT public.accept_invitation(%L)', (SELECT invitation_token FROM public.organization_members WHERE id = i7)));
    v := pg_temp.step();
    r := r || jsonb_build_object('C1n_accept', pg_temp.pass(s LIKE '%"success": true%' AND pg_temp.one(v, 'invite_accepted', u_new), s || ' ' || v::text));

    -- ===== C2: writes that change nothing the log tracks =====
    s := pg_temp.call_as(u_a, format('SELECT public.set_member_name(%L::uuid, %L, %L)', pg_temp.mem(o1, u_g2), 'Sam', 'Roe'));
    v := pg_temp.step();
    r := r || jsonb_build_object('C2a_set_name', pg_temp.pass(s LIKE '%"success": true%' AND v = '[]'::jsonb, s || ' ' || v::text));
    s := pg_temp.exec_as(u_a, format('UPDATE public.organization_members SET updated_at = now() WHERE id = %L', pg_temp.mem(o1, u_g2)));
    v := pg_temp.step();
    r := r || jsonb_build_object('C2b_updated_at_only', pg_temp.pass(s = 'ok:1' AND v = '[]'::jsonb, s || ' ' || v::text));
    s := pg_temp.as_service(format('UPDATE public.organization_members SET scim_synced_at = now() + interval %L WHERE id = %L', '2 seconds', pg_temp.mem(o1, u_s)));
    v := pg_temp.step();
    r := r || jsonb_build_object('C2c_scim_synced_only', pg_temp.pass(s = 'ok:1' AND v = '[]'::jsonb, s || ' ' || v::text));
    -- a sync that writes the same role and licence (UPDATE OF role fires; nothing changed)
    s := pg_temp.as_service(format('UPDATE public.organization_members SET role = role, license_status = license_status, scim_synced_at = now() + interval %L WHERE id = %L',
      '3 seconds', pg_temp.mem(o1, u_s)));
    v := pg_temp.step();
    r := r || jsonb_build_object('C2d_sync_same_values', pg_temp.pass(s = 'ok:1' AND v = '[]'::jsonb, s || ' ' || v::text));
    -- MyPhoneCard re-save of the same number
    s := pg_temp.call_as(u_g2, $q$SELECT public.my_phone_set('+1 206 555 0101')$q$);
    v := pg_temp.step();
    r := r || jsonb_build_object('C2e_phone_same_value', pg_temp.pass(s LIKE '%"success": true%' AND v = '[]'::jsonb, s || ' ' || v::text));
    -- the IdP demotes the last admin: _guard_last_admin keeps the role; only its own row
    s := pg_temp.as_service(format('UPDATE public.organization_members SET role = %L, scim_synced_at = now() + interval %L WHERE id = %L',
      'agent', '4 seconds', pg_temp.mem(o2, u_a2)));
    v := pg_temp.step();
    r := r || jsonb_build_object('C2f_last_admin_refusal', pg_temp.pass(s = 'ok:1' AND pg_temp.acts(v) = 'sync_change_skipped_last_admin', s || ' ' || v::text));
    -- claim path 1: the accepting user already has a phone -> the pending row is removed
    s := pg_temp.call_as(u_c1, format('SELECT public.accept_invitation(%L)', (SELECT invitation_token FROM public.organization_members WHERE id = i4)));
    v := pg_temp.step();
    r := r || jsonb_build_object('C2g_claim_removal', pg_temp.pass(s LIKE '%"success": true%' AND pg_temp.acts(v) = 'invite_accepted'
      AND NOT EXISTS (SELECT 1 FROM public.user_phones p WHERE p.pending_member_id = i4), s || ' ' || v::text));
    -- claim path 2: no phone yet -> the pending row moves to the user (UPDATE, phone unchanged)
    s := pg_temp.call_as(u_c2, format('SELECT public.accept_invitation(%L)', (SELECT invitation_token FROM public.organization_members WHERE id = i5)));
    v := pg_temp.step();
    r := r || jsonb_build_object('C2h_claim_update', pg_temp.pass(s LIKE '%"success": true%' AND pg_temp.acts(v) = 'invite_accepted'
      AND EXISTS (SELECT 1 FROM public.user_phones p WHERE p.user_id = u_c2), s || ' ' || v::text));

    -- ===== C3: dedupe =====
    -- org_contact_save names an IT contact -> it_admin: role_changed + contact_saved explicit rows
    s := pg_temp.call_as(u_a3, format('SELECT public.org_contact_save(%L::uuid, %L::jsonb)', o3,
           json_build_object('role', 'it', 'member_id', pg_temp.mem(o3, u_g4), 'confirm_role_change', true)));
    v := pg_temp.step();
    f := pg_temp.feed(u_sup, o3);
    r := r || jsonb_build_object('C3a_people_role_change', pg_temp.pass(
      s LIKE '%"success": true%' AND pg_temp.acts(v) LIKE '%member_role_changed%'
      AND (SELECT string_agg(DISTINCT e ->> 'action', ',' ORDER BY e ->> 'action') FROM jsonb_array_elements(f) e
            WHERE e ->> 'action' <> 'member_added') = 'contact_saved,role_changed',
      'step=' || pg_temp.acts(v) || ' feed=' || pg_temp.feed_acts(f)));
    -- a staff deal save writes the brokerage row and a staff twin (admin_save_deal shape)
    INSERT INTO public.billing_change_log (organization_id, actor_id, action, detail)
    VALUES (o1, u_sales, 'deal_saved', jsonb_build_object('version', 1, 'seats', 5, 'unit_price_cents', 2499, 'stripe_mode', 'test', 'reason', 'Deal created', 'status', 'draft'));
    INSERT INTO public.admin_audit_logs (actor_id, action, target_type, target_id, metadata)
    VALUES (u_sales, 'billing.deal_saved', 'organization', o1::text, jsonb_build_object('organization_id', o1, 'unit_price_cents', 2499, 'list_price_cents', 2999));
    INSERT INTO public.admin_audit_logs (actor_id, action, target_type, target_id, metadata)
    VALUES (u_sales, 'org_plan.assigned', 'organization', o1::text, jsonb_build_object('organization_id', o1, 'plan_id', (SELECT id FROM public.plans LIMIT 1), 'record_id', gen_random_uuid()));
    INSERT INTO public.admin_audit_logs (actor_id, action, target_type, target_id, metadata)
    VALUES (u_sales, 'organization.created', 'organization', o1::text, jsonb_build_object('name', 'P4036', 'slug', 'p4036', 'max_seats', 20));
    PERFORM pg_temp.step();
    f := pg_temp.feed(u_sales, o1);
    r := r || jsonb_build_object('C3b_staff_twin_once', pg_temp.pass(
      pg_temp.feed_count(f, 'deal_saved') = 1 AND pg_temp.feed_count(f, 'billing.deal_saved') = 0, f::text));
    -- bulk change: each member keeps its own row (no explicit twin): C1c + C1d x2 + C1m
    r := r || jsonb_build_object('C3c_bulk_rows_visible', pg_temp.pass(pg_temp.feed_count(f, 'member_role_changed') = 4,
      'role rows=' || pg_temp.feed_count(f, 'member_role_changed')));
    -- _org_billing_login_orphan_rekey shape: the old invite goes, billing_login_replaced keys the
    -- new member and names the old one in old_member_id
    INSERT INTO public.organization_members (organization_id, role, license_status, invited_email, invitation_token, invitation_expires_at, provisioned_by)
    VALUES (o4, 'agent', 'unassigned', 'p4036-rk@example.test', md5(random()::text), now() + interval '7 days', 'invite') RETURNING id INTO i1;
    PERFORM pg_temp.step();
    DELETE FROM public.organization_members WHERE id = i1;
    INSERT INTO public.billing_change_log (organization_id, actor_id, action, detail)
    VALUES (o4, NULL, 'billing_login_replaced', jsonb_build_object('old_member_id', i1, 'member_id', gen_random_uuid(), 'provisioned_by', 'scim'));
    v := pg_temp.step();
    f := pg_temp.feed(u_sup, o4);
    r := r || jsonb_build_object('C3d_rekey_old_member_hidden', pg_temp.pass(
      pg_temp.acts(v) = 'billing_login_replaced,invite_cancelled'
      AND pg_temp.feed_count(f, 'invite_cancelled') = 0 AND pg_temp.feed_count(f, 'billing_login_replaced') = 1, 'step=' || pg_temp.acts(v) || ' feed=' || pg_temp.feed_acts(f)));

    -- ===== C4: actor =====
    -- a user session sending the header: auth.uid() wins
    s := pg_temp.exec_as(u_a, format('UPDATE public.organization_members SET role = %L WHERE id = %L', 'agent', pg_temp.mem(o1, u_g1)), pg_temp.hdr(u_sup));
    v := pg_temp.step();
    r := r || jsonb_build_object('C4a_spoof_header_ignored', pg_temp.pass(s = 'ok:1' AND pg_temp.one(v, 'member_role_changed', u_a), s || ' ' || v::text));
    -- a value that is not a uuid: the write goes through, actor NULL
    s := pg_temp.as_service(format('UPDATE public.organization_members SET role = %L WHERE id = %L', 'broker', pg_temp.mem(o1, u_g1)), '{"x-keepr-actor":"not-a-uuid"}');
    v := pg_temp.step();
    r := r || jsonb_build_object('C4b_bad_header_null', pg_temp.pass(s = 'ok:1' AND pg_temp.one(v, 'member_role_changed', NULL), s || ' ' || v::text));
    -- a header that is not JSON at all
    s := pg_temp.as_service(format('UPDATE public.organization_members SET role = %L WHERE id = %L', 'agent', pg_temp.mem(o1, u_g1)), 'garbage');
    v := pg_temp.step();
    r := r || jsonb_build_object('C4c_garbage_headers_null', pg_temp.pass(s = 'ok:1' AND pg_temp.one(v, 'member_role_changed', NULL), s || ' ' || v::text));

    -- ===== C5: who can read what =====
    f := pg_temp.feed(u_a, o1);
    r := r || jsonb_build_object('C5a_non_staff_refused', pg_temp.pass(f ->> 'err' LIKE 'ERR 42501%', f::text));
    f := pg_temp.feed(u_sup, o1);
    r := r || jsonb_build_object('C5b_no_billing_view_no_billing_rows', pg_temp.pass(
      jsonb_typeof(f) = 'array' AND pg_temp.feed_count(f, 'deal_saved') = 0 AND pg_temp.feed_count(f, 'member_role_changed') = 7
      AND f::text NOT LIKE '%price_cents%' AND f::text NOT LIKE '%phone"%', left(f::text, 200)));
    f := pg_temp.feed(u_sales, o1);
    r := r || jsonb_build_object('C5c_billing_view_no_price', pg_temp.pass(
      pg_temp.feed_count(f, 'deal_saved') = 1 AND f::text NOT LIKE '%price_cents%' AND f::text NOT LIKE '%phone"%'
      AND f::text NOT LIKE '%record_id%' AND f::text NOT LIKE '%"slug"%', left(f::text, 300)));
    r := r || jsonb_build_object('C5d_grants', pg_temp.pass(
      NOT has_function_privilege('anon', 'public.admin_get_org_activity(uuid,integer)', 'EXECUTE')
      AND has_function_privilege('authenticated', 'public.admin_get_org_activity(uuid,integer)', 'EXECUTE')
      AND NOT has_function_privilege('authenticated', 'public._activity_actor()', 'EXECUTE')
      AND NOT has_function_privilege('authenticated', 'public._org_member_change_log()', 'EXECUTE')
      AND NOT has_function_privilege('authenticated', 'public._user_phone_change_log()', 'EXECUTE'), 'grants'));
    r := r || jsonb_build_object('C5e_staff_rows', pg_temp.pass(
      pg_temp.feed_count(f, 'org_plan.assigned') = 1 AND pg_temp.feed_count(f, 'organization.created') = 1
      AND (SELECT bool_and(e ->> 'actor_is_staff' = 'true') FROM jsonb_array_elements(f) e WHERE e ->> 'action' LIKE '%.%'), left(f::text, 300)));

    -- ===== C6: personal organizations, phone privacy, cascades =====
    s := pg_temp.as_service(format('INSERT INTO public.organization_members (organization_id, user_id, role, license_status, joined_at) VALUES (%L, %L, %L, %L, now())',
      op, u_p, 'admin', 'active'));
    v := pg_temp.step();
    r := r || jsonb_build_object('C6a_personal_org_silent', pg_temp.pass(s = 'ok:1' AND v = '[]'::jsonb, s || ' ' || v::text));
    f := pg_temp.feed(u_sales, o1);
    r := r || jsonb_build_object('C6b_no_phone_number', pg_temp.pass(jsonb_typeof(f) = 'array' AND f::text NOT LIKE '%2065550%', 'phone in feed'));
    -- removeUser.ts:112 on a pending invite that has a phone: the phone row cascades
    s := pg_temp.exec_as(u_a, format('DELETE FROM public.organization_members WHERE id = %L', i6));
    v := pg_temp.step();
    r := r || jsonb_build_object('C6c_cancel_invite_with_phone', pg_temp.pass(s = 'ok:1' AND pg_temp.acts(v) = 'invite_cancelled'
      AND NOT EXISTS (SELECT 1 FROM public.user_phones p WHERE p.pending_member_id = i6), s || ' ' || v::text));
    -- the organization is removed: its members cascade, the log gets nothing for it
    DELETE FROM public.organizations WHERE id = o5;
    v := pg_temp.step();
    r := r || jsonb_build_object('C6d_org_removed_silent', pg_temp.pass(v = '[]'::jsonb, v::text));

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
          'pass', (SELECT count(*) FROM jsonb_each_text(v_r->'checks') e WHERE e.value = 'PASS'),
          'fail', (SELECT count(*) FROM jsonb_each_text(v_r->'checks') e WHERE e.value <> 'PASS'),
          'reds', CASE WHEN v_m = 'base' THEN (SELECT coalesce(jsonb_object_agg(e.key, e.value), '{}'::jsonb) FROM jsonb_each_text(v_r->'checks') e WHERE e.value <> 'PASS')
                       ELSE (SELECT coalesce(jsonb_agg(e.key ORDER BY e.key), '[]'::jsonb) FROM jsonb_each_text(v_r->'checks') e WHERE e.value <> 'PASS') END));
      ELSE
        v_res := v_res || jsonb_build_object(v_m, 'ERROR ' || SQLSTATE || ' ' || left(SQLERRM, 300));
      END IF;
    END;
  END LOOP;
  RAISE EXCEPTION 'P4036_RESULT %', v_res;
END
$drv$;
