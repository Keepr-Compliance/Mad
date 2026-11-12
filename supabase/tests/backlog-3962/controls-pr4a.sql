-- BACKLOG-3962 PR4a (20261112120000) DB tests and controls: JIT for brand-new people only, the
-- verified-claim requirement, and the solo sign-up block.
-- Venue: keepr-test via ~/.claude/bin/kt-sql. ONE call, one implicit transaction that always ends
-- in RAISE, so nothing persists. compose-pr4a.py prepends the migration (or a mutant of it).
-- Own fixtures (keys bl3962p4:, domains *-3962p4.test); nothing outside them is read or written.
-- Output: RAISE 'P3962_RESULT {"mode":..., "pass":n, "fail":n, "reds":{case: got}}'.

set local pg_stat_statements.track = 'none';

CREATE FUNCTION pg_temp.id(t text) RETURNS uuid LANGUAGE sql IMMUTABLE AS $b$ SELECT md5('bl3962p4:' || t)::uuid $b$;

-- JWT claims for user u with role r, carrying u's latest session id (the JIT freshness check).
CREATE FUNCTION pg_temp.as_user(u uuid, r text) RETURNS void LANGUAGE plpgsql AS $b$
BEGIN
  PERFORM set_config('request.jwt.claims', json_build_object('sub', u, 'role', r,
    'session_id', (SELECT s.id FROM auth.sessions s WHERE s.user_id = u ORDER BY s.created_at DESC LIMIT 1))::text, true);
  PERFORM set_config('request.jwt.claim.sub', coalesce(u::text, ''), true);
  PERFORM set_config('request.jwt.claim.role', r, true);
END $b$;

CREATE FUNCTION pg_temp.q(u uuid, r text, q text) RETURNS text LANGUAGE plpgsql AS $b$
DECLARE v text;
BEGIN
  BEGIN
    PERFORM pg_temp.as_user(u, r);
    EXECUTE format('SET LOCAL ROLE %I', r);
    EXECUTE q INTO v;
    EXECUTE 'RESET ROLE';
    PERFORM pg_temp.as_user(NULL, 'postgres');
    RETURN coalesce(v, 'null');
  EXCEPTION WHEN OTHERS THEN
    EXECUTE 'RESET ROLE';
    PERFORM pg_temp.as_user(NULL, 'postgres');
    RETURN 'ERR ' || SQLSTATE || ' ' || left(SQLERRM, 120);
  END;
END $b$;

CREATE FUNCTION pg_temp.jit(u uuid, p text, i text) RETURNS text LANGUAGE sql AS $b$
  SELECT pg_temp.q(u, 'authenticated', format('SELECT public.jit_join_organization(%L, %L)::text', p, i))
$b$;
CREATE FUNCTION pg_temp.lic(caller uuid, r text, target uuid) RETURNS text LANGUAGE sql AS $b$
  SELECT pg_temp.q(caller, r, format('SELECT (public.create_active_individual_license(%L::uuid)).license_type', target))
$b$;
CREATE FUNCTION pg_temp.members(o uuid, u uuid) RETURNS int LANGUAGE sql AS $b$
  SELECT count(*)::int FROM public.organization_members WHERE organization_id = o AND user_id = u $b$;
CREATE FUNCTION pg_temp.nlic(u uuid) RETURNS int LANGUAGE sql AS $b$
  SELECT count(*)::int FROM public.licenses WHERE user_id = u $b$;
CREATE FUNCTION pg_temp.npo(u uuid) RETURNS int LANGUAGE sql AS $b$
  SELECT count(*)::int FROM public.organizations WHERE personal_owner_user_id = u $b$;

-- Fixtures ----------------------------------------------------------------------------------
-- Brokerages:
--   A  tenant tid-a-3962p4, verified claim a-3962p4.test (block toggled per case), pending claim
--      p-3962p4.test, JIT on.
--   L  tenant tid-l-3962p4, LAPSED claim l-3962p4.test, JIT on.
--   G  no tenant, verified claims g-3962p4.test and g2-3962p4.test, JIT on.
--   X  another brokerage, holds rows in several statuses.
-- Users (k, email, provider, claim value) below; every OAuth user has a fresh 'oauth' session.
CREATE TEMP TABLE fx (k text, e text, prov text, cl text) ON COMMIT DROP;
INSERT INTO fx VALUES
  ('u_admA', 'adm@corp-3962p4.test', 'email', NULL),
  ('u_agA',  'ag@corp-3962p4.test', 'email', NULL),
  ('u_admX', 'admx@corp-3962p4.test', 'email', NULL),
  ('u_staff', 'staff@corp-3962p4.test', 'email', NULL),
  -- JIT, Microsoft
  ('j_owner',  'owner@a-3962p4.test',  'azure', 'tid-a-3962p4'),   -- personal owner + licence
  ('j_lic',    'lic@a-3962p4.test',    'azure', 'tid-a-3962p4'),   -- licence only (former member)
  ('j_porg',   'porg@a-3962p4.test',   'azure', 'tid-a-3962p4'),   -- personal org row only
  ('j_new',    'new@a-3962p4.test',    'azure', 'tid-a-3962p4'),   -- brand-new
  ('j_mem',    'mem@a-3962p4.test',    'azure', 'tid-a-3962p4'),   -- already in A
  ('j_plcd',   'plcd@a-3962p4.test',   'azure', 'tid-a-3962p4'),   -- expired row in X
  ('j_lapsed', 'lap@l-3962p4.test',    'azure', 'tid-l-3962p4'),   -- L's claim lapsed
  ('j_sub',    'sub@sub.a-3962p4.test','azure', 'tid-a-3962p4'),   -- subdomain email
  ('j_sfx',    'sfx@xa-3962p4.test',   'azure', 'tid-a-3962p4'),   -- suffix email
  ('j_othr',   'othr@g-3962p4.test',   'azure', 'tid-a-3962p4'),   -- G's domain, A's tenant
  ('j_frgn',   'frgn@a-3962p4.test',   'azure', 'tid-foreign-3962p4'), -- foreign tenant
  -- JIT, Google
  ('g_ok',     'gok@g-3962p4.test',    'google', 'g-3962p4.test'),
  ('g_hdmis',  'ghd@g2-3962p4.test',   'google', 'g-3962p4.test'),  -- hd g, email g2 (both G's)
  ('g_emis',   'gem@a-3962p4.test',    'google', 'g-3962p4.test'),  -- hd g, email on A's domain
  ('g_lapsed', 'glap@l-3962p4.test',   'google', 'l-3962p4.test'),  -- lapsed claim
  -- solo block
  ('s_new',    's.new@a-3962p4.test',  'email', NULL),
  ('s_susp',   's.susp@a-3962p4.test', 'email', NULL),  -- suspended row in X
  ('s_inv',    's.inv@a-3962p4.test',  'email', NULL),  -- live invitation in A
  ('s_invx',   's.invx@a-3962p4.test', 'email', NULL),  -- expired invitation in A
  ('s_sub',    's.sub@sub.a-3962p4.test', 'email', NULL),
  ('s_lap',    's.lap@l-3962p4.test',  'email', NULL),
  ('s_svc',    's.svc@a-3962p4.test',  'email', NULL),
  ('s_staff',  's.staff@a-3962p4.test','email', NULL),
  ('s_has',    's.has@a-3962p4.test',  'email', NULL),  -- licence already
  ('s_rev',    's.rev@a-3962p4.test',  'email', NULL),  -- active row in A + licence, deactivated later
  ('e_new',    'e.new@a-3962p4.test',  'email', NULL),
  ('e_lic',    'e.lic@a-3962p4.test',  'email', NULL),  -- licence, no personal org
  ('e_free',   'e.free@free-3962p4.test', 'email', NULL);

INSERT INTO auth.users (id, email, instance_id, aud, role, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
  SELECT pg_temp.id(k), e, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', now(),
         jsonb_build_object('provider', prov), '{}'::jsonb, now(), now() FROM fx;
INSERT INTO public.users (id, email, oauth_provider, oauth_id)
  SELECT pg_temp.id(k), e, prov, k || '-3962p4' FROM fx WHERE k IN ('u_admA', 'u_agA', 'u_admX', 'u_staff', 'j_owner', 'j_lic', 'j_porg', 'j_mem', 'j_plcd', 's_susp', 's_has', 's_rev', 'e_lic')
  ON CONFLICT DO NOTHING;
INSERT INTO auth.identities (provider_id, user_id, identity_data, provider, created_at, updated_at)
  SELECT k || '-pid-3962p4', pg_temp.id(k),
         CASE WHEN prov = 'azure' THEN jsonb_build_object('sub', k, 'email', e, 'custom_claims', jsonb_build_object('tid', cl))
              WHEN prov = 'google' THEN jsonb_build_object('sub', k, 'email', e, 'custom_claims', jsonb_build_object('hd', cl))
              ELSE jsonb_build_object('sub', pg_temp.id(k), 'email', e) END,
         prov, now(), now() FROM fx;
INSERT INTO auth.sessions (id, user_id, created_at, updated_at, aal)
  SELECT pg_temp.id('sess_' || k), pg_temp.id(k), now(), now(), 'aal1' FROM fx WHERE prov IN ('azure', 'google');
INSERT INTO auth.mfa_amr_claims (id, session_id, created_at, updated_at, authentication_method)
  SELECT pg_temp.id('amr_' || k), pg_temp.id('sess_' || k), now(), now(), 'oauth' FROM fx WHERE prov IN ('azure', 'google');
INSERT INTO public.internal_roles (user_id, role_id)
  SELECT pg_temp.id('u_staff'), ar.id FROM public.admin_roles ar WHERE ar.slug = 'sales';

INSERT INTO public.organizations (id, name, slug, is_test, max_seats, microsoft_tenant_id, jit_provisioning_enabled, default_member_role) VALUES
  (pg_temp.id('oA'), 'PR4a Brokerage A', 'pr4a-a-3962p4', true, 50, 'tid-a-3962p4', true, 'agent'),
  (pg_temp.id('oL'), 'PR4a Brokerage L', 'pr4a-l-3962p4', true, 50, 'tid-l-3962p4', true, 'agent'),
  (pg_temp.id('oG'), 'PR4a Brokerage G', 'pr4a-g-3962p4', true, 50, NULL, true, 'agent'),
  (pg_temp.id('oX'), 'PR4a Brokerage X', 'pr4a-x-3962p4', true, 50, 'tid-x-3962p4', true, 'agent');
INSERT INTO public.organization_plans (organization_id, plan_id, feature_overrides)
  SELECT pg_temp.id(o), (SELECT id FROM public.plans WHERE tier = 'team' ORDER BY sort_order, created_at LIMIT 1),
         '{"jit_provisioning":{"enabled":true}}'::jsonb
    FROM unnest(ARRAY['oA', 'oL', 'oG', 'oX']) o;
INSERT INTO public.organization_members (organization_id, user_id, role, license_status, joined_at) VALUES
  (pg_temp.id('oA'), pg_temp.id('u_admA'), 'admin', 'active', now()),
  (pg_temp.id('oA'), pg_temp.id('u_agA'), 'agent', 'active', now()),
  (pg_temp.id('oX'), pg_temp.id('u_admX'), 'admin', 'active', now()),
  (pg_temp.id('oA'), pg_temp.id('j_mem'), 'agent', 'active', now()),
  (pg_temp.id('oX'), pg_temp.id('j_plcd'), 'agent', 'expired', now()),
  (pg_temp.id('oX'), pg_temp.id('s_susp'), 'agent', 'suspended', now()),
  (pg_temp.id('oA'), pg_temp.id('s_rev'), 'agent', 'active', now());
INSERT INTO public.organization_members (organization_id, user_id, role, license_status, invited_email, invitation_token, invitation_expires_at) VALUES
  (pg_temp.id('oA'), NULL, 'agent', 'pending', 's.inv@a-3962p4.test', 'bl3962p4-inv-live', now() + interval '3 days'),
  (pg_temp.id('oA'), NULL, 'agent', 'pending', 's.invx@a-3962p4.test', 'bl3962p4-inv-old', now() - interval '1 day');

-- personal organizations: j_owner (with licence), j_porg (org + membership, no licence)
INSERT INTO public.organizations (id, name, slug, is_test, max_seats, personal_owner_user_id)
  SELECT pg_temp.id('po_' || k), 'Personal', 'po-' || replace(k, '_', '-') || '-3962p4', true, 1, pg_temp.id(k)
    FROM unnest(ARRAY['j_owner', 'j_porg']) k;
INSERT INTO public.organization_members (organization_id, user_id, role, license_status)
  SELECT pg_temp.id('po_' || k), pg_temp.id(k), 'agent', 'active' FROM unnest(ARRAY['j_owner', 'j_porg']) k;
INSERT INTO public.licenses (user_id, license_key, license_type, status, max_devices, transaction_limit)
  SELECT pg_temp.id(k), 'IND-bl3962p4-' || k, 'individual', 'active', 2, 99999
    FROM unnest(ARRAY['j_owner', 'j_lic', 's_has', 's_rev', 'e_lic']) k;

INSERT INTO public.domain_claims (id, organization_id, domain, token, status, verified_at, last_checked_at, last_check_result) VALUES
  (pg_temp.id('cA'),  pg_temp.id('oA'), 'a-3962p4.test',  'keepr-domain-verification=' || substr(md5('p4a') || md5('p4a2'), 1, 48), 'verified', now() - interval '5 days', now(), 'verified'),
  (pg_temp.id('cAp'), pg_temp.id('oA'), 'p-3962p4.test',  'keepr-domain-verification=' || substr(md5('p4p') || md5('p4p2'), 1, 48), 'pending', NULL, NULL, NULL),
  (pg_temp.id('cL'),  pg_temp.id('oL'), 'l-3962p4.test',  'keepr-domain-verification=' || substr(md5('p4l') || md5('p4l2'), 1, 48), 'lapsed', now() - interval '40 days', now(), 'not_found'),
  (pg_temp.id('cG'),  pg_temp.id('oG'), 'g-3962p4.test',  'keepr-domain-verification=' || substr(md5('p4g') || md5('p4g2'), 1, 48), 'verified', now() - interval '5 days', now(), 'verified'),
  (pg_temp.id('cG2'), pg_temp.id('oG'), 'g2-3962p4.test', 'keepr-domain-verification=' || substr(md5('p4h') || md5('p4h2'), 1, 48), 'verified', now() - interval '5 days', now(), 'verified');

-- __MODE__

DO $drv$
DECLARE
  oA uuid := pg_temp.id('oA'); oL uuid := pg_temp.id('oL'); oG uuid := pg_temp.id('oG'); oX uuid := pg_temp.id('oX');
  g text; j jsonb;
  v_pass int := 0; v_fail int := 0; reds jsonb := '{}'::jsonb; k record;
BEGIN
  CREATE TEMP TABLE r4 (k text, ok boolean, got text) ON COMMIT DROP;

  -- ---- O1 the one-argument overload is gone ---------------------------------------------------
  INSERT INTO r4 VALUES ('O1_one_arg_overload_dropped', to_regprocedure('public.jit_join_organization(text)') IS NULL, '');

  -- ---- J1 existing accounts are not auto-joined ----------------------------------------------
  g := pg_temp.jit(pg_temp.id('j_owner'), 'azure_ad', 'tid-a-3962p4');
  INSERT INTO r4 VALUES ('J1a_personal_owner_existing_account', g LIKE '%"existing_account"%' AND pg_temp.members(oA, pg_temp.id('j_owner')) = 0, g);
  g := pg_temp.jit(pg_temp.id('j_lic'), 'azure_ad', 'tid-a-3962p4');
  INSERT INTO r4 VALUES ('J1b_licence_only_existing_account', g LIKE '%"existing_account"%' AND pg_temp.members(oA, pg_temp.id('j_lic')) = 0, g);
  g := pg_temp.jit(pg_temp.id('j_porg'), 'azure_ad', 'tid-a-3962p4');
  INSERT INTO r4 VALUES ('J1c_personal_org_row_existing_account', g LIKE '%"existing_account"%' AND pg_temp.members(oA, pg_temp.id('j_porg')) = 0, g);

  -- ---- J2 brand-new joins; members and placed people as before ---------------------------------
  g := pg_temp.jit(pg_temp.id('j_new'), 'azure_ad', 'tid-a-3962p4');
  INSERT INTO r4 VALUES ('J2a_brand_new_joins', g LIKE '%"success": true%' AND g LIKE '%"already_member": false%'
    AND pg_temp.members(oA, pg_temp.id('j_new')) = 1, g);
  g := pg_temp.jit(pg_temp.id('j_mem'), 'azure_ad', 'tid-a-3962p4');
  INSERT INTO r4 VALUES ('J2b_member_already_member', g LIKE '%"already_member": true%', g);
  g := pg_temp.jit(pg_temp.id('j_plcd'), 'azure_ad', 'tid-a-3962p4');
  INSERT INTO r4 VALUES ('J2c_expired_row_elsewhere_already_placed', g LIKE '%"already_placed"%' AND pg_temp.members(oA, pg_temp.id('j_plcd')) = 0, g);

  -- ---- J3 verified claim equal to the email domain ---------------------------------------------
  g := pg_temp.jit(pg_temp.id('j_lapsed'), 'azure_ad', 'tid-l-3962p4');
  INSERT INTO r4 VALUES ('J3a_lapsed_claim_refused', g LIKE '%"domain_not_verified"%' AND pg_temp.members(oL, pg_temp.id('j_lapsed')) = 0, g);
  g := pg_temp.jit(pg_temp.id('j_sub'), 'azure_ad', 'tid-a-3962p4');
  INSERT INTO r4 VALUES ('J3b_subdomain_email_refused', g LIKE '%"domain_not_verified"%' AND pg_temp.members(oA, pg_temp.id('j_sub')) = 0, g);
  g := pg_temp.jit(pg_temp.id('j_sfx'), 'azure_ad', 'tid-a-3962p4');
  INSERT INTO r4 VALUES ('J3c_suffix_email_refused', g LIKE '%"domain_not_verified"%' AND pg_temp.members(oA, pg_temp.id('j_sfx')) = 0, g);
  g := pg_temp.jit(pg_temp.id('j_othr'), 'azure_ad', 'tid-a-3962p4');
  INSERT INTO r4 VALUES ('J3d_other_brokerages_domain_refused', g LIKE '%"domain_not_verified"%' AND pg_temp.members(oA, pg_temp.id('j_othr')) = 0, g);

  -- ---- J4 foreign tenant ------------------------------------------------------------------------
  g := pg_temp.jit(pg_temp.id('j_frgn'), 'azure_ad', 'tid-a-3962p4');
  INSERT INTO r4 VALUES ('J4a_foreign_tenant_asking_for_A_refused', g LIKE '%"identity_mismatch"%' AND pg_temp.members(oA, pg_temp.id('j_frgn')) = 0, g);
  g := pg_temp.jit(pg_temp.id('j_frgn'), 'azure_ad', 'tid-foreign-3962p4');
  INSERT INTO r4 VALUES ('J4b_foreign_tenant_own_tid_refused', g LIKE '%"domain_not_verified"%'
    AND NOT EXISTS (SELECT 1 FROM public.organization_members WHERE user_id = pg_temp.id('j_frgn')), g);

  -- ---- JG Google by verified claim -------------------------------------------------------------
  g := pg_temp.jit(pg_temp.id('g_ok'), 'google_workspace', 'g-3962p4.test');
  INSERT INTO r4 VALUES ('JG1_google_hd_on_verified_claim_joins', g LIKE '%"success": true%' AND pg_temp.members(oG, pg_temp.id('g_ok')) = 1, g);
  g := pg_temp.jit(pg_temp.id('g_hdmis'), 'google_workspace', 'g-3962p4.test');
  INSERT INTO r4 VALUES ('JG2_hd_not_email_domain_refused', g LIKE '%"domain_not_verified"%' AND pg_temp.members(oG, pg_temp.id('g_hdmis')) = 0, g);
  g := pg_temp.jit(pg_temp.id('g_emis'), 'google_workspace', 'g-3962p4.test');
  INSERT INTO r4 VALUES ('JG3_email_on_other_brokerage_domain_refused', g LIKE '%"domain_not_verified"%'
    AND NOT EXISTS (SELECT 1 FROM public.organization_members WHERE user_id = pg_temp.id('g_emis')), g);
  g := pg_temp.jit(pg_temp.id('g_lapsed'), 'google_workspace', 'l-3962p4.test');
  INSERT INTO r4 VALUES ('JG4_lapsed_claim_refused', g LIKE '%"domain_not_verified"%'
    AND NOT EXISTS (SELECT 1 FROM public.organization_members WHERE user_id = pg_temp.id('g_lapsed')), g);
  g := pg_temp.jit(pg_temp.id('g_ok'), 'google_workspace', 'gmail.com');
  INSERT INTO r4 VALUES ('JG5_consumer_domain_refused', g LIKE '%"consumer_domain"%', g);

  -- ---- T1 the toggle ---------------------------------------------------------------------------
  g := pg_temp.q(pg_temp.id('u_agA'), 'authenticated', format('SELECT public.domain_claim_set_block_solo(%L::uuid, true)::text', pg_temp.id('cA')));
  INSERT INTO r4 VALUES ('T1a_agent_cannot_toggle', g LIKE '%"not_found"%'
    AND NOT (SELECT block_solo_signups FROM public.domain_claims WHERE id = pg_temp.id('cA')), g);
  g := pg_temp.q(pg_temp.id('u_admX'), 'authenticated', format('SELECT public.domain_claim_set_block_solo(%L::uuid, true)::text', pg_temp.id('cA')));
  INSERT INTO r4 VALUES ('T1b_other_orgs_admin_cannot_toggle', g LIKE '%"not_found"%'
    AND NOT (SELECT block_solo_signups FROM public.domain_claims WHERE id = pg_temp.id('cA')), g);
  g := pg_temp.q(pg_temp.id('u_admA'), 'authenticated', format('SELECT public.domain_claim_set_block_solo(%L::uuid, true)::text', pg_temp.id('cAp')));
  INSERT INTO r4 VALUES ('T1c_pending_claim_cannot_turn_on', g LIKE '%"not_verified"%'
    AND NOT (SELECT block_solo_signups FROM public.domain_claims WHERE id = pg_temp.id('cAp')), g);
  g := pg_temp.q(NULL, 'anon', format('SELECT public.domain_claim_set_block_solo(%L::uuid, true)::text', pg_temp.id('cA')));
  INSERT INTO r4 VALUES ('T1d_anon_refused', g LIKE 'ERR 42501%', g);
  g := pg_temp.q(pg_temp.id('u_admA'), 'authenticated', format('SELECT public.domain_claim_set_block_solo(%L::uuid, true)::text', pg_temp.id('cA')));
  INSERT INTO r4 VALUES ('T1e_admin_turns_on', g LIKE '%"success": true%'
    AND (SELECT block_solo_signups FROM public.domain_claims WHERE id = pg_temp.id('cA')), g);
  -- L's lapsed claim with the switch left on (set directly: it was on before the claim lapsed)
  UPDATE public.domain_claims SET block_solo_signups = true WHERE id = pg_temp.id('cL');

  -- ---- S1 the licence gate (A's claim now blocks) ----------------------------------------------
  g := pg_temp.lic(pg_temp.id('s_new'), 'authenticated', pg_temp.id('s_new'));
  INSERT INTO r4 VALUES ('S1a_blocked_new_licence_refused', g LIKE 'ERR P0001 domain_managed%' AND pg_temp.nlic(pg_temp.id('s_new')) = 0, g);
  g := pg_temp.lic(pg_temp.id('s_susp'), 'authenticated', pg_temp.id('s_susp'));
  INSERT INTO r4 VALUES ('S1b_suspended_row_elsewhere_exempt', g = 'individual' AND pg_temp.nlic(pg_temp.id('s_susp')) = 1, g);
  g := pg_temp.lic(pg_temp.id('s_inv'), 'authenticated', pg_temp.id('s_inv'));
  INSERT INTO r4 VALUES ('S1c_live_invite_exempt', g = 'individual' AND pg_temp.nlic(pg_temp.id('s_inv')) = 1, g);
  g := pg_temp.lic(pg_temp.id('s_invx'), 'authenticated', pg_temp.id('s_invx'));
  INSERT INTO r4 VALUES ('S1d_expired_invite_not_exempt', g LIKE 'ERR P0001 domain_managed%' AND pg_temp.nlic(pg_temp.id('s_invx')) = 0, g);
  g := pg_temp.lic(pg_temp.id('s_sub'), 'authenticated', pg_temp.id('s_sub'));
  INSERT INTO r4 VALUES ('S1e_subdomain_not_blocked', g = 'individual', g);
  g := pg_temp.lic(pg_temp.id('s_lap'), 'authenticated', pg_temp.id('s_lap'));
  INSERT INTO r4 VALUES ('S1f_lapsed_claim_not_blocking', g = 'individual', g);
  g := pg_temp.lic(NULL, 'service_role', pg_temp.id('s_svc'));
  INSERT INTO r4 VALUES ('S1g_server_role_exempt', g = 'individual', g);
  g := pg_temp.lic(pg_temp.id('s_has'), 'authenticated', pg_temp.id('s_has'));
  INSERT INTO r4 VALUES ('S1h_existing_licence_returned', g = 'individual' AND pg_temp.nlic(pg_temp.id('s_has')) = 1, g);
  g := pg_temp.lic(pg_temp.id('e_free'), 'authenticated', pg_temp.id('e_free'));
  INSERT INTO r4 VALUES ('S1i_unclaimed_domain_creates', g = 'individual', g);
  DELETE FROM public.licenses WHERE user_id = pg_temp.id('e_free');

  -- ---- S2 staff creating for a blocked person: gated on that person's email --------------------
  g := pg_temp.lic(pg_temp.id('u_staff'), 'authenticated', pg_temp.id('s_staff'));
  INSERT INTO r4 VALUES ('S2_staff_for_blocked_user_refused', g LIKE 'ERR P0001 domain_managed%' AND pg_temp.nlic(pg_temp.id('s_staff')) = 0, g);

  -- ---- S3 (C19) a deactivated member still reverts to a personal account -----------------------
  UPDATE public.organization_members SET license_status = 'suspended' WHERE organization_id = oA AND user_id = pg_temp.id('s_rev');
  INSERT INTO r4 VALUES ('S3_deactivated_member_gets_personal_org',
    pg_temp.npo(pg_temp.id('s_rev')) = 1
      AND EXISTS (SELECT 1 FROM public.organization_members m JOIN public.organizations o ON o.id = m.organization_id
                   WHERE o.personal_owner_user_id = pg_temp.id('s_rev') AND m.user_id = pg_temp.id('s_rev')),
    pg_temp.npo(pg_temp.id('s_rev'))::text);

  -- ---- E ensure_personal_organization ------------------------------------------------------------
  g := pg_temp.q(pg_temp.id('e_new'), 'authenticated', 'SELECT public.ensure_personal_organization()::text');
  INSERT INTO r4 VALUES ('E1_blocked_no_licence_domain_managed', g LIKE '%"domain_managed"%' AND g LIKE '%PR4a Brokerage A%'
    AND pg_temp.npo(pg_temp.id('e_new')) = 0, g);
  g := pg_temp.q(pg_temp.id('e_lic'), 'authenticated', 'SELECT public.ensure_personal_organization()::text');
  INSERT INTO r4 VALUES ('E2_licence_holder_attached', (g LIKE '%"created"%' OR g LIKE '%"attached"%') AND pg_temp.npo(pg_temp.id('e_lic')) = 1, g);
  g := pg_temp.q(pg_temp.id('e_free'), 'authenticated', 'SELECT public.ensure_personal_organization()::text');
  INSERT INTO r4 VALUES ('E3_unblocked_no_licence_unchanged', g LIKE '%"no_license"%', g);

  -- ---- C caller_domain_managed --------------------------------------------------------------------
  g := pg_temp.q(pg_temp.id('e_new'), 'authenticated', 'SELECT public.caller_domain_managed()::text');
  INSERT INTO r4 VALUES ('C1_blocked_caller', g LIKE '%"blocked": true%' AND g LIKE '%PR4a Brokerage A%' AND g LIKE '%"a-3962p4.test"%', g);
  g := pg_temp.q(pg_temp.id('s_has'), 'authenticated', 'SELECT public.caller_domain_managed()::text');
  INSERT INTO r4 VALUES ('C2_licence_holder_not_blocked', g = '{"blocked": false}', g);
  g := pg_temp.q(pg_temp.id('e_free'), 'authenticated', 'SELECT public.caller_domain_managed()::text');
  INSERT INTO r4 VALUES ('C3_unclaimed_domain_not_blocked', g = '{"blocked": false}', g);
  g := pg_temp.q(NULL, 'anon', 'SELECT public.caller_domain_managed()::text');
  INSERT INTO r4 VALUES ('C4_anon_refused', g LIKE 'ERR 42501%', g);
  g := pg_temp.q(pg_temp.id('e_new'), 'authenticated', format('SELECT public._solo_signup_block_org(%L::uuid)', pg_temp.id('e_new')));
  INSERT INTO r4 VALUES ('C5_internal_not_callable', g LIKE 'ERR 42501%', g);

  -- ---- T1f turning off works on any status ------------------------------------------------------
  g := pg_temp.q(pg_temp.id('u_admA'), 'authenticated', format('SELECT public.domain_claim_set_block_solo(%L::uuid, false)::text', pg_temp.id('cA')));
  INSERT INTO r4 VALUES ('T1f_admin_turns_off', g LIKE '%"success": true%'
    AND NOT (SELECT block_solo_signups FROM public.domain_claims WHERE id = pg_temp.id('cA')), g);
  g := pg_temp.lic(pg_temp.id('s_new'), 'authenticated', pg_temp.id('s_new'));
  INSERT INTO r4 VALUES ('T1g_off_lets_licence_through', g = 'individual', g);

  FOR k IN SELECT * FROM r4 ORDER BY r4.k LOOP
    IF k.ok THEN v_pass := v_pass + 1; ELSE v_fail := v_fail + 1; reds := reds || jsonb_build_object(k.k, k.got); END IF;
  END LOOP;
  RAISE EXCEPTION 'P3962_RESULT %', jsonb_build_object('mode', current_setting('p3962.mode', true),
    'pass', v_pass, 'fail', v_fail, 'reds', reds);
END
$drv$;
