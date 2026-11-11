-- BACKLOG-3962 PR3a (20261112113000) DB tests and controls for domain capture.
-- Venue: keepr-test via ~/.claude/bin/kt-sql. ONE call, one implicit transaction that always ends
-- in RAISE, so nothing persists. compose.py prepends the migration (or a mutant of it).
-- now() is fixed inside one transaction, so elapsed time is simulated by moving timestamps back.
-- Output: RAISE 'P3962_RESULT {"mode":..., "pass":n, "fail":n, "reds":{case: got}}'.

CREATE FUNCTION pg_temp.id(t text) RETURNS uuid LANGUAGE sql IMMUTABLE AS $b$ SELECT md5('bl3962c:' || t)::uuid $b$;

CREATE FUNCTION pg_temp.as_user(u uuid, r text) RETURNS void LANGUAGE plpgsql AS $b$
BEGIN
  PERFORM set_config('request.jwt.claims', json_build_object('sub', u, 'role', r)::text, true);
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

CREATE FUNCTION pg_temp.h02_refuse() RETURNS trigger LANGUAGE plpgsql AS $b$
BEGIN RAISE EXCEPTION 'bl3962_other_refusal' USING ERRCODE = 'P0001'; END $b$;

CREATE FUNCTION pg_temp.sw(s uuid) RETURNS text LANGUAGE sql AS $b$
  SELECT pg_temp.q(NULL, 'service_role', format('SELECT public._domain_capture_switch(%L::uuid)::text', s))
$b$;
CREATE FUNCTION pg_temp.mark(s uuid, o text) RETURNS text LANGUAGE sql AS $b$
  SELECT pg_temp.q(NULL, 'service_role', format('SELECT public._domain_capture_mark_notice(%L::uuid, %L)::text', s, o))
$b$;
CREATE FUNCTION pg_temp.start(u uuid, o uuid, c uuid, us uuid[]) RETURNS text LANGUAGE sql AS $b$
  SELECT pg_temp.q(u, 'authenticated', format('SELECT public.domain_capture_start(%L::uuid, %L::uuid, %L::uuid[])::text', o, c, us))
$b$;
-- the switch row of user u (latest)
CREATE FUNCTION pg_temp.sid(u uuid) RETURNS uuid LANGUAGE sql AS $b$
  SELECT id FROM public.domain_capture_switches WHERE user_id = u ORDER BY (status = 'scheduled') DESC, created_at DESC, id LIMIT 1 $b$;
CREATE FUNCTION pg_temp.sst(u uuid) RETURNS text LANGUAGE sql AS $b$
  SELECT status || ':' || coalesce(reason, '-') FROM public.domain_capture_switches WHERE user_id = u
   ORDER BY (status = 'scheduled') DESC, created_at DESC, id LIMIT 1 $b$;
CREATE FUNCTION pg_temp.members(o uuid, u uuid) RETURNS int LANGUAGE sql AS $b$
  SELECT count(*)::int FROM public.organization_members WHERE organization_id = o AND user_id = u $b$;
CREATE FUNCTION pg_temp.seats(o uuid) RETURNS int LANGUAGE sql AS $b$
  SELECT count(*)::int FROM public.organization_members m WHERE m.organization_id = o
     AND public.member_row_holds_seat(m.license_status, m.invitation_expires_at, m.user_id) $b$;
CREATE FUNCTION pg_temp.outbox(u uuid) RETURNS int LANGUAGE sql AS $b$
  SELECT count(*)::int FROM public.billing_outbox WHERE user_id = u AND kind = 'cancel_agent_on_brokerage_join' $b$;

-- Fixtures ----------------------------------------------------------------------------------
-- Brokerages: A (tenant tid-a-3962, domain cap-3962.test), B (holds u_deact's suspended row),
-- W / R / L (cascade: withdraw / revoke / lapse, one domain each). Personal accounts p_*.
-- k = key, e = email, kind = identity kind ('email' | 'azure:<tid>' | 'google:<hd>' | 'google:')
CREATE TEMP TABLE fx (k text, e text, kind text) ON COMMIT DROP;
INSERT INTO fx VALUES
  ('u_admA', 'adma@corp-3962.test', 'email'),
  ('u_agA',  'aga@corp-3962.test', 'email'),
  ('u_admB', 'admb@corp-3962.test', 'email'),
  ('u_admW', 'admw@corp-3962.test', 'email'),
  ('u_admR', 'admr@corp-3962.test', 'email'),
  ('u_admL', 'adml@corp-3962.test', 'email'),
  ('u_staff', 'staff@corp-3962.test', 'email'),
  ('p_mail', 'mail@cap-3962.test', 'email'),
  ('p_az',   'az@cap-3962.test', 'azure:tid-a-3962'),
  ('p_azf',  'azf@cap-3962.test', 'azure:tid-x-3962'),
  ('p_g',    'g@cap-3962.test', 'google:cap-3962.test'),
  ('p_none', 'none@cap-3962.test', 'google:'),
  ('p_deact','deact@cap-3962.test', 'email'),
  ('p_other','other@elsewhere-3962.test', 'email'),
  ('p_opt',  'opt@cap-3962.test', 'email'),
  ('p_fail', 'fail@cap-3962.test', 'email'),
  ('p_w',    'w@w-3962.test', 'email'),
  ('p_r',    'r@r-3962.test', 'email'),
  ('p_l',    'l@l-3962.test', 'email'),
  ('u_admN', 'admn@corp-3962.test', 'email'),
  ('p_nt',   'nt@nt-3962.test', 'azure:tid-n-3962'),
  ('u_admD', 'admd@corp-3962.test', 'email'),
  ('p_d',    'd@d-3962.test', 'email'),
  ('p_d2',   'd2@d-3962.test', 'email'),
  ('p_dx',   'dx@d-3962.test', 'email'),
  ('u_admS', 'adms@corp-3962.test', 'email'),
  ('p_s',    's@s-3962.test', 'email'),
  ('u_admK', 'admk@corp-3962.test', 'email'),
  ('p_k',    'k@k-3962.test', 'email'),
  ('p_i',    'i@k-3962.test', 'email'),
  ('p_h',    'h@k-3962.test', 'email');

INSERT INTO auth.users (id, email, instance_id, aud, role, email_confirmed_at)
  SELECT pg_temp.id(k), e, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', now() FROM fx;
INSERT INTO public.users (id, email, oauth_provider, oauth_id)
  SELECT pg_temp.id(k), e, 'google', k || '3962c' FROM fx ON CONFLICT DO NOTHING;
INSERT INTO auth.identities (provider_id, user_id, identity_data, provider)
  SELECT k || '-pid-3962', pg_temp.id(k),
         CASE WHEN kind = 'email' THEN jsonb_build_object('sub', pg_temp.id(k), 'email', e)
              WHEN kind LIKE 'azure:%' THEN jsonb_build_object('email', e, 'custom_claims', jsonb_build_object('tid', substr(kind, 7)))
              WHEN kind = 'google:' THEN jsonb_build_object('email', e)
              ELSE jsonb_build_object('email', e, 'custom_claims', jsonb_build_object('hd', substr(kind, 8))) END,
         split_part(kind, ':', 1)
    FROM fx;

INSERT INTO public.organizations (id, name, slug, is_test, max_seats, microsoft_tenant_id) VALUES
  (pg_temp.id('oA'), 'Capture A 3962', 'cap-a-3962', true, 2, 'tid-a-3962'),
  (pg_temp.id('oB'), 'Capture B 3962', 'cap-b-3962', true, 10, NULL),
  (pg_temp.id('oW'), 'Capture W 3962', 'cap-w-3962', true, 10, NULL),
  (pg_temp.id('oR'), 'Capture R 3962', 'cap-r-3962', true, 10, NULL),
  (pg_temp.id('oL'), 'Capture L 3962', 'cap-l-3962', true, 10, NULL),
  (pg_temp.id('oN'), 'Capture N 3962', 'cap-n-3962', true, 10, NULL),
  (pg_temp.id('oD'), 'Capture D 3962', 'cap-d-3962', true, 10, NULL),
  (pg_temp.id('oS'), 'Capture S 3962', 'cap-s-3962', true, 10, NULL);
-- oK: new members get the organization's default role, not a fixed one
INSERT INTO public.organizations (id, name, slug, is_test, max_seats, microsoft_tenant_id, default_member_role)
  VALUES (pg_temp.id('oK'), 'Capture K 3962', 'cap-k-3962', true, 10, NULL, 'broker');
INSERT INTO public.organizations (id, name, slug, is_test, max_seats, personal_owner_user_id)
  SELECT pg_temp.id('po_' || k), 'Personal', 'po-' || replace(k, '_', '-') || '-3962', true, 1, pg_temp.id(k)
    FROM fx WHERE k LIKE 'p\_%';
INSERT INTO public.organization_members (organization_id, user_id, role, license_status)
  SELECT pg_temp.id('po_' || k), pg_temp.id(k), 'admin', 'active' FROM fx WHERE k LIKE 'p\_%';
INSERT INTO public.organization_members (organization_id, user_id, role, license_status) VALUES
  (pg_temp.id('oA'), pg_temp.id('u_admA'), 'admin', 'active'),
  (pg_temp.id('oA'), pg_temp.id('u_agA'), 'agent', 'unassigned'),
  (pg_temp.id('oB'), pg_temp.id('u_admB'), 'admin', 'active'),
  (pg_temp.id('oB'), pg_temp.id('p_deact'), 'agent', 'suspended'),
  (pg_temp.id('oW'), pg_temp.id('u_admW'), 'admin', 'active'),
  (pg_temp.id('oR'), pg_temp.id('u_admR'), 'admin', 'active'),
  (pg_temp.id('oL'), pg_temp.id('u_admL'), 'admin', 'active'),
  (pg_temp.id('oN'), pg_temp.id('u_admN'), 'admin', 'active'),
  (pg_temp.id('oD'), pg_temp.id('u_admD'), 'admin', 'active'),
  (pg_temp.id('oS'), pg_temp.id('u_admS'), 'admin', 'active'),
  (pg_temp.id('oK'), pg_temp.id('u_admK'), 'admin', 'active');

-- staff with organizations.edit (revoke)
INSERT INTO public.admin_roles (id, name, slug) VALUES (pg_temp.id('role_edit'), 'org edit 3962c', 'org-edit-3962c');
INSERT INTO public.admin_role_permissions (role_id, permission_id)
  SELECT pg_temp.id('role_edit'), id FROM public.admin_permissions WHERE key IN ('organizations.edit', 'organizations.view');
INSERT INTO public.internal_roles (user_id, role_id) VALUES (pg_temp.id('u_staff'), pg_temp.id('role_edit'));

-- verified claims with a fresh verified DNS answer
INSERT INTO public.domain_claims (id, organization_id, domain, token, status, verified_at, last_checked_at, last_check_result)
  SELECT pg_temp.id('c' || o), pg_temp.id('o' || o), d,
         'keepr-domain-verification=' || substr(md5('t3962c' || o) || md5('u3962c' || o), 1, 48),
         'verified', now() - interval '20 days', now(), 'verified'
    FROM (VALUES ('A', 'cap-3962.test'), ('W', 'w-3962.test'), ('R', 'r-3962.test'), ('L', 'l-3962.test'),
                 ('N', 'nt-3962.test'), ('D', 'd-3962.test'), ('S', 's-3962.test'), ('K', 'k-3962.test')) v(o, d);

-- p_mail pays for a personal Agent plan (one Stripe customer, one live subscription row)
INSERT INTO public.stripe_customers (user_id, stripe_mode, stripe_customer_id) VALUES
  (pg_temp.id('p_mail'), 'test', 'cus_3962c_mail'),
  (pg_temp.id('p_g'), 'test', 'cus_3962c_g'),
  (pg_temp.id('p_i'), 'test', 'cus_3962c_i');
INSERT INTO public.billing_subscriptions (stripe_mode, user_id, stripe_customer_id, stripe_subscription_id, status)
  VALUES ('test', pg_temp.id('p_mail'), 'cus_3962c_mail', 'sub_3962c_mail', 'active'),
         ('test', pg_temp.id('p_i'), 'cus_3962c_i', 'sub_3962c_i', 'incomplete');

-- PR3b: one person with a display name, one with a blank one (falls back to the email)
UPDATE public.users SET display_name = 'Mail Person 3962' WHERE id = pg_temp.id('p_mail');
UPDATE public.users SET display_name = '  ' WHERE id = pg_temp.id('p_g');

-- __MODE__

DO $drv$
DECLARE
  oA uuid := pg_temp.id('oA'); oB uuid := pg_temp.id('oB'); cA uuid := pg_temp.id('cA');
  uAdmA uuid := pg_temp.id('u_admA'); uAgA uuid := pg_temp.id('u_agA'); uAdmB uuid := pg_temp.id('u_admB');
  pMail uuid := pg_temp.id('p_mail'); pAz uuid := pg_temp.id('p_az'); pAzf uuid := pg_temp.id('p_azf');
  pG uuid := pg_temp.id('p_g'); pNone uuid := pg_temp.id('p_none'); pDeact uuid := pg_temp.id('p_deact');
  pOther uuid := pg_temp.id('p_other'); pOpt uuid := pg_temp.id('p_opt'); pFail uuid := pg_temp.id('p_fail');
  g text; g2 text; j jsonb; n int; n2 int; s uuid;
  v_pass int := 0; v_fail int := 0; reds jsonb := '{}'::jsonb; k record;
BEGIN
  CREATE TEMP TABLE r3962 (k text, ok boolean, got text) ON COMMIT DROP;

  -- ---- candidates ------------------------------------------------------------------------------
  g := pg_temp.q(uAdmA, 'authenticated', format('SELECT public.domain_capture_candidates(%L::uuid, %L::uuid)::text', oA, cA));
  j := CASE WHEN g LIKE '{%' THEN g::jsonb ELSE '{}'::jsonb END;
  INSERT INTO r3962 VALUES ('K01_candidates_listed',
    (SELECT coalesce(string_agg(x ->> 'email' || '=' || coalesce(x ->> 'attestation', 'none') || '/' || (x ->> 'convertible'), ',' ORDER BY x ->> 'email'), '')
       FROM jsonb_array_elements(coalesce(j -> 'candidates', '[]'::jsonb)) x)
      = 'az@cap-3962.test=azure_tid/true,fail@cap-3962.test=email_confirmed/true,g@cap-3962.test=google_hd/true,mail@cap-3962.test=email_confirmed/true,none@cap-3962.test=none/false,opt@cap-3962.test=email_confirmed/true',
    left(g, 600));
  INSERT INTO r3962 VALUES ('K02_foreign_tenant_not_listed', position('azf@' IN g) = 0, left(g, 200));
  INSERT INTO r3962 VALUES ('K03_deactivated_elsewhere_not_listed', position('deact@' IN g) = 0, left(g, 200));
  INSERT INTO r3962 VALUES ('K07_candidate_name_or_email',
    (SELECT string_agg(x ->> 'email' || '=' || coalesce(x ->> 'name', 'NULL'), ',' ORDER BY x ->> 'email')
       FROM jsonb_array_elements(coalesce(j -> 'candidates', '[]'::jsonb)) x
      WHERE x ->> 'email' IN ('mail@cap-3962.test', 'g@cap-3962.test')) = 'g@cap-3962.test=g@cap-3962.test,mail@cap-3962.test=Mail Person 3962',
    left(g, 300));
  g := pg_temp.q(uAgA, 'authenticated', format('SELECT public.domain_capture_candidates(%L::uuid, %L::uuid)::text', oA, cA));
  INSERT INTO r3962 VALUES ('K04_agent_refused', g LIKE '%not_authorized%', g);
  g := pg_temp.q(uAdmB, 'authenticated', format('SELECT public.domain_capture_candidates(%L::uuid, %L::uuid)::text', oB, cA));
  INSERT INTO r3962 VALUES ('K05_other_org_claim_not_found', g LIKE '%claim_not_found%', g);

  -- ---- start -----------------------------------------------------------------------------------
  g := pg_temp.start(uAdmB, oA, cA, ARRAY[pMail]);
  INSERT INTO r3962 VALUES ('S01_admin_of_other_org_refused', g LIKE '%not_authorized%', g);
  g := pg_temp.start(uAdmA, oA, cA, ARRAY[pMail, pAz, pAzf, pG, pNone, pDeact, pOther, pOpt, pFail]);
  j := CASE WHEN g LIKE '{%' THEN g::jsonb ELSE '{}'::jsonb END;
  INSERT INTO r3962 VALUES ('S02_scheduled_set',
    jsonb_array_length(coalesce(j -> 'scheduled', '[]'::jsonb)) = 5
      AND (SELECT count(*) FROM public.domain_capture_switches WHERE organization_id = oA AND status = 'scheduled') = 5, left(g, 400));
  INSERT INTO r3962 VALUES ('S08_start_reports_payer',
    (SELECT bool_and((x ->> 'payer')::boolean = (x ->> 'email' = 'mail@cap-3962.test'))
       FROM jsonb_array_elements(coalesce(j -> 'scheduled', '[]'::jsonb)) x) IS TRUE
      AND (SELECT count(*) FROM jsonb_array_elements(coalesce(j -> 'scheduled', '[]'::jsonb)) x WHERE x ? 'payer') = 5, left(g, 400));
  INSERT INTO r3962 VALUES ('S03_foreign_tenant_never_scheduled',
    NOT EXISTS (SELECT 1 FROM public.domain_capture_switches WHERE user_id = pAzf)
      AND g LIKE '%foreign_tenant%', left(g, 400));
  INSERT INTO r3962 VALUES ('S04_deactivated_elsewhere_never_scheduled',
    NOT EXISTS (SELECT 1 FROM public.domain_capture_switches WHERE user_id = pDeact)
      AND g LIKE '%brokerage_member%', left(g, 400));
  INSERT INTO r3962 VALUES ('S05_email_only_never_scheduled',
    NOT EXISTS (SELECT 1 FROM public.domain_capture_switches WHERE user_id = pNone), left(g, 400));
  INSERT INTO r3962 VALUES ('S06_switch_at_14_days',
    (SELECT bool_and(switch_at = now() + interval '14 days') FROM public.domain_capture_switches WHERE organization_id = oA), '');
  g := pg_temp.start(uAdmA, oA, cA, ARRAY[pMail]);
  INSERT INTO r3962 VALUES ('S07_second_start_already_scheduled', g LIKE '%already_scheduled%', g);

  -- ---- notice -----------------------------------------------------------------------------------
  g := pg_temp.q(uAdmA, 'authenticated', format('SELECT public._domain_capture_mark_notice(%L::uuid, %L)::text', pg_temp.sid(pMail), 'sent'));
  INSERT INTO r3962 VALUES ('N01_client_cannot_mark_notice', g LIKE 'ERR 42501%', g);
  PERFORM pg_temp.mark(pg_temp.sid(pMail), 'sent');
  PERFORM pg_temp.mark(pg_temp.sid(pAz), 'sent');
  PERFORM pg_temp.mark(pg_temp.sid(pOpt), 'sent');
  g := pg_temp.mark(pg_temp.sid(pG), 'queued');
  INSERT INTO r3962 VALUES ('N02_queued_stays_scheduled_undecided',
    pg_temp.sst(pG) = 'scheduled:-' AND (SELECT notice_delivered FROM public.domain_capture_switches WHERE user_id = pG) IS NULL, g);
  g := pg_temp.mark(pg_temp.sid(pFail), 'failed');
  INSERT INTO r3962 VALUES ('N03_failed_send_cancels', pg_temp.sst(pFail) = 'cancelled:notice_undelivered', g);
  g := pg_temp.start(uAdmA, oA, cA, ARRAY[pFail]);
  INSERT INTO r3962 VALUES ('N04_restart_after_undelivered', pg_temp.sst(pFail) = 'scheduled:-', g);
  PERFORM pg_temp.mark(pg_temp.sid(pFail), 'sent');

  -- ---- own notice / opt-out ---------------------------------------------------------------------
  g := pg_temp.q(pOpt, 'authenticated', 'SELECT public.caller_capture_notice()::text');
  INSERT INTO r3962 VALUES ('O01_caller_sees_own_only',
    g LIKE '%Capture A 3962%' AND jsonb_array_length((g::jsonb) -> 'switches') = 1
      AND (g::jsonb) -> 'switches' -> 0 ->> 'switch_id' = pg_temp.sid(pOpt)::text, left(g, 300));
  g := pg_temp.q(pOpt, 'authenticated', format('SELECT public.domain_capture_opt_out_self(%L::uuid)::text', pg_temp.sid(pMail)));
  INSERT INTO r3962 VALUES ('O02_opt_out_other_row_refused',
    g LIKE '%switch_not_found%' AND pg_temp.sst(pMail) = 'scheduled:-', g);
  g := pg_temp.q(pOpt, 'authenticated', format('SELECT public.domain_capture_opt_out_self(%L::uuid)::text', pg_temp.sid(pOpt)));
  INSERT INTO r3962 VALUES ('O03_opt_out_own_row', pg_temp.sst(pOpt) = 'opted_out:opted_out', g);
  -- PR3b: an opt-out is final in the database
  g := pg_temp.q(uAdmA, 'authenticated', format('SELECT public.domain_capture_candidates(%L::uuid, %L::uuid)::text', oA, cA));
  j := CASE WHEN g LIKE '{%' THEN g::jsonb ELSE '{}'::jsonb END;
  INSERT INTO r3962 VALUES ('Q01_opted_out_listed_not_convertible',
    (SELECT x ->> 'convertible' || '/' || coalesce(x ->> 'reason', '-') FROM jsonb_array_elements(coalesce(j -> 'candidates', '[]'::jsonb)) x
      WHERE x ->> 'email' = 'opt@cap-3962.test') = 'false/opted_out', left(g, 600));
  n := (SELECT count(*) FROM public.domain_capture_switches WHERE user_id = pOpt);
  g := pg_temp.start(uAdmA, oA, cA, ARRAY[pOpt]);
  j := CASE WHEN g LIKE '{%' THEN g::jsonb ELSE '{}'::jsonb END;
  INSERT INTO r3962 VALUES ('Q02_start_skips_opted_out_no_notice',
    jsonb_array_length(coalesce(j -> 'scheduled', '[]'::jsonb)) = 0
      AND j -> 'skipped' -> 0 ->> 'reason' = 'opted_out'
      AND (SELECT count(*) FROM public.domain_capture_switches WHERE user_id = pOpt) = n
      AND pg_temp.sst(pOpt) = 'opted_out:opted_out', left(g, 300));
  g := pg_temp.q(uAdmB, 'authenticated', format('SELECT public.domain_capture_cancel(%L::uuid)::text', pg_temp.sid(pAz)));
  INSERT INTO r3962 VALUES ('O04_cancel_by_other_org_refused', g LIKE '%switch_not_found%' AND pg_temp.sst(pAz) = 'scheduled:-', g);
  g := pg_temp.q(NULL, 'anon', format('SELECT public.domain_capture_opt_out_self(%L::uuid)::text', pg_temp.sid(pAz)));
  INSERT INTO r3962 VALUES ('O05_anon_no_execute', g LIKE 'ERR 42501%', g);
  g := pg_temp.q(uAdmA, 'authenticated', 'SELECT count(*)::text FROM public.domain_capture_switches');
  INSERT INTO r3962 VALUES ('O06_client_cannot_read_table', g LIKE 'ERR 42501%', g);
  g := pg_temp.q(uAdmA, 'authenticated', format('SELECT public._domain_capture_switch(%L::uuid)::text', pg_temp.sid(pMail)));
  INSERT INTO r3962 VALUES ('O07_client_cannot_switch', g LIKE 'ERR 42501%', g);

  -- ---- switch -----------------------------------------------------------------------------------
  g := pg_temp.sw(pg_temp.sid(pMail));
  INSERT INTO r3962 VALUES ('W01_not_due_before_day_14', g LIKE '%not_due%' AND pg_temp.members(oA, pMail) = 0, g);
  UPDATE public.domain_capture_switches SET switch_at = now() - interval '1 minute' WHERE organization_id = oA;

  -- fresh DNS required
  UPDATE public.domain_claims SET last_checked_at = now() - interval '2 hours' WHERE id = cA;
  g := pg_temp.sw(pg_temp.sid(pMail));
  INSERT INTO r3962 VALUES ('W02_stale_dns_no_switch', g LIKE '%dns_not_fresh%' AND pg_temp.sst(pMail) = 'scheduled:-'
    AND pg_temp.members(oA, pMail) = 0, g);
  INSERT INTO r3962 VALUES ('W10_dns_deferral_recorded',
    (SELECT last_defer_reason FROM public.domain_capture_switches WHERE id = pg_temp.sid(pMail)) = 'dns_not_fresh', g);
  UPDATE public.domain_claims SET last_checked_at = now() WHERE id = cA;

  -- undelivered (queued, never sent) at switch time
  n := pg_temp.outbox(pG);
  g := pg_temp.sw(pg_temp.sid(pG));
  INSERT INTO r3962 VALUES ('W03_undelivered_cancels_no_member_no_outbox',
    pg_temp.sst(pG) = 'cancelled:notice_undelivered' AND pg_temp.members(oA, pG) = 0 AND pg_temp.outbox(pG) = n, g);

  -- opted out
  g := pg_temp.sw(pg_temp.sid(pOpt));
  INSERT INTO r3962 VALUES ('W04_opted_out_nothing', g LIKE '%not_scheduled%' AND pg_temp.members(oA, pOpt) = 0
    AND pg_temp.sst(pOpt) = 'opted_out:opted_out', g);

  -- seats: max 2, one held (admin). Free seat -> active, +1.
  n := pg_temp.seats(oA);
  n2 := pg_temp.outbox(pMail);
  g := pg_temp.sw(pg_temp.sid(pMail));
  j := CASE WHEN g LIKE '{%' THEN g::jsonb ELSE '{}'::jsonb END;
  INSERT INTO r3962 VALUES ('W05_free_seat_active_plus_one',
    j ->> 'outcome' = 'switched' AND j ->> 'license_status' = 'active' AND pg_temp.seats(oA) = n + 1
      AND (SELECT license_status FROM public.organization_members WHERE organization_id = oA AND user_id = pMail) = 'active'
      AND (SELECT provisioned_by FROM public.organization_members WHERE organization_id = oA AND user_id = pMail) = 'domain_capture'
      AND coalesce((j ->> 'seat_fallback')::boolean, true) = false, g || ' seats ' || n || '->' || pg_temp.seats(oA));
  INSERT INTO r3962 VALUES ('W06_payer_flag_and_3850_outbox',
    j ->> 'payer' = 'true' AND pg_temp.outbox(pMail) = n2 + 1
      AND NOT EXISTS (SELECT 1 FROM public.organization_members m JOIN public.organizations o ON o.id = m.organization_id
                       WHERE m.user_id = pMail AND o.personal_owner_user_id IS NOT NULL),
    g || ' outbox ' || n2 || '->' || pg_temp.outbox(pMail));
  -- switch twice
  g := pg_temp.sw(pg_temp.sid(pMail));
  INSERT INTO r3962 VALUES ('W11_switched_row_defer_cleared',
    (SELECT status || ':' || coalesce(last_defer_reason, '-') FROM public.domain_capture_switches
      WHERE user_id = pMail AND organization_id = oA AND status = 'switched') = 'switched:-', '');
  INSERT INTO r3962 VALUES ('W07_switch_twice_one_membership', g LIKE '%not_scheduled%' AND pg_temp.members(oA, pMail) = 1, g);

  -- zero seats left -> unassigned, count unchanged
  n := pg_temp.seats(oA);
  g := pg_temp.sw(pg_temp.sid(pAz));
  j := CASE WHEN g LIKE '{%' THEN g::jsonb ELSE '{}'::jsonb END;
  INSERT INTO r3962 VALUES ('W08_no_seat_unassigned_count_unchanged',
    j ->> 'outcome' = 'switched' AND j ->> 'license_status' = 'unassigned' AND pg_temp.seats(oA) = n
      AND (SELECT license_status FROM public.organization_members WHERE organization_id = oA AND user_id = pAz) = 'unassigned'
      AND coalesce((j ->> 'seat_fallback')::boolean, true) = false AND j ->> 'payer' = 'false',
    g || ' seats ' || n || '->' || pg_temp.seats(oA));

  -- email changed after start -> not eligible, cancelled
  UPDATE auth.users SET email = 'fail@elsewhere-3962.test' WHERE id = pFail;
  s := pg_temp.sid(pFail);  -- the scheduled row (two p_fail rows share one fixed now())
  g := pg_temp.sw(s);
  INSERT INTO r3962 VALUES ('W09_email_moved_off_domain_cancelled',
    (SELECT status || ':' || coalesce(reason, '-') FROM public.domain_capture_switches WHERE id = s) = 'cancelled:not_eligible'
      AND pg_temp.members(oA, pFail) = 0, g);

  -- ---- cascade at day 7: withdraw / revoke / lapse --------------------------------------------
  PERFORM pg_temp.start(pg_temp.id('u_admW'), pg_temp.id('oW'), pg_temp.id('cW'), ARRAY[pg_temp.id('p_w')]);
  PERFORM pg_temp.start(pg_temp.id('u_admR'), pg_temp.id('oR'), pg_temp.id('cR'), ARRAY[pg_temp.id('p_r')]);
  PERFORM pg_temp.start(pg_temp.id('u_admL'), pg_temp.id('oL'), pg_temp.id('cL'), ARRAY[pg_temp.id('p_l')]);
  PERFORM pg_temp.mark(pg_temp.sid(pg_temp.id(x)), 'sent') FROM unnest(ARRAY['p_w', 'p_r', 'p_l']) x;
  UPDATE public.domain_capture_switches SET switch_at = now() + interval '7 days'
   WHERE organization_id IN (pg_temp.id('oW'), pg_temp.id('oR'), pg_temp.id('oL'));

  g := pg_temp.q(pg_temp.id('u_admW'), 'authenticated', format('SELECT public.domain_claim_withdraw(%L::uuid)::text', pg_temp.id('cW')));
  INSERT INTO r3962 VALUES ('X01_withdraw_cancels', pg_temp.sst(pg_temp.id('p_w')) = 'cancelled:claim_withdrawn', g);
  g := pg_temp.q(pg_temp.id('u_staff'), 'authenticated', format('SELECT public.admin_revoke_domain_claim(%L::uuid, %L)::text', pg_temp.id('cR'), 'test 3962'));
  INSERT INTO r3962 VALUES ('X02_revoke_cancels', pg_temp.sst(pg_temp.id('p_r')) = 'cancelled:claim_revoked', g);
  UPDATE public.domain_claims SET consecutive_misses = 2, last_miss_counted_at = NULL WHERE id = pg_temp.id('cL');
  g := pg_temp.q(NULL, 'service_role', format('SELECT public._domain_claim_record_check(%L::uuid, %L::uuid, %L::text[], true, %L)::text',
         pg_temp.id('cL'), pg_temp.id('oL'), ARRAY[]::text[], 'recheck'));
  INSERT INTO r3962 VALUES ('X03_lapse_cancels', g LIKE '%lapsed%' AND pg_temp.sst(pg_temp.id('p_l')) = 'cancelled:claim_lapsed', g);
  UPDATE public.domain_capture_switches SET switch_at = now() - interval '1 minute'
   WHERE organization_id IN (pg_temp.id('oW'), pg_temp.id('oR'), pg_temp.id('oL'));
  PERFORM pg_temp.sw(s2.id) FROM public.domain_capture_switches s2
   WHERE s2.organization_id IN (pg_temp.id('oW'), pg_temp.id('oR'), pg_temp.id('oL'));
  SELECT count(*) INTO n FROM public.organization_members
   WHERE organization_id IN (pg_temp.id('oW'), pg_temp.id('oR'), pg_temp.id('oL'))
     AND user_id IN (pg_temp.id('p_w'), pg_temp.id('p_r'), pg_temp.id('p_l'));
  INSERT INTO r3962 VALUES ('X04_zero_switches_after_cascade', n = 0, n::text);

  -- ---- ruling g: no tenant recorded ----------------------------------------------------------
  g := pg_temp.q(pg_temp.id('u_admN'), 'authenticated', format('SELECT public.domain_capture_candidates(%L::uuid, %L::uuid)::text', pg_temp.id('oN'), pg_temp.id('cN')));
  j := CASE WHEN g LIKE '{%' THEN g::jsonb ELSE '{}'::jsonb END;
  g2 := pg_temp.start(pg_temp.id('u_admN'), pg_temp.id('oN'), pg_temp.id('cN'), ARRAY[pg_temp.id('p_nt')]);
  INSERT INTO r3962 VALUES ('K06_no_tenant_listed_not_convertible_never_scheduled',
    (SELECT x ->> 'convertible' || '/' || coalesce(x ->> 'reason', '-') || '/' || coalesce(x ->> 'attestation', '-')
       FROM jsonb_array_elements(coalesce(j -> 'candidates', '[]'::jsonb)) x WHERE x ->> 'email' = 'nt@nt-3962.test') = 'false/no_tenant/-'
      AND NOT EXISTS (SELECT 1 FROM public.domain_capture_switches WHERE user_id = pg_temp.id('p_nt'))
      AND g2 LIKE '%no_tenant%', left(g, 300) || ' | ' || left(g2, 200));

  -- ---- the 3850 gate (function renamed away inside this rolled-back transaction) -----------------
  ALTER FUNCTION public._billing_enqueue_agent_cancel_on_join(uuid, uuid, uuid) RENAME TO _bl3962_tmp;
  g := pg_temp.start(pg_temp.id('u_admD'), pg_temp.id('oD'), pg_temp.id('cD'), ARRAY[pg_temp.id('p_dx')]);
  ALTER FUNCTION public._bl3962_tmp(uuid, uuid, uuid) RENAME TO _billing_enqueue_agent_cancel_on_join;
  INSERT INTO r3962 VALUES ('B01_start_refused_without_3850',
    g LIKE '%billing_not_ready%' AND NOT EXISTS (SELECT 1 FROM public.domain_capture_switches WHERE user_id = pg_temp.id('p_dx')), g);
  g := pg_temp.start(pg_temp.id('u_admD'), pg_temp.id('oD'), pg_temp.id('cD'), ARRAY[pg_temp.id('p_d')]);
  PERFORM pg_temp.mark(pg_temp.sid(pg_temp.id('p_d')), 'sent');
  UPDATE public.domain_capture_switches SET switch_at = now() - interval '1 minute' WHERE organization_id = pg_temp.id('oD');
  ALTER FUNCTION public._billing_enqueue_agent_cancel_on_join(uuid, uuid, uuid) RENAME TO _bl3962_tmp;
  g := pg_temp.sw(pg_temp.sid(pg_temp.id('p_d')));
  ALTER FUNCTION public._bl3962_tmp(uuid, uuid, uuid) RENAME TO _billing_enqueue_agent_cancel_on_join;
  INSERT INTO r3962 VALUES ('B02_switch_deferred_without_3850',
    g LIKE '%billing_not_ready%' AND pg_temp.sst(pg_temp.id('p_d')) = 'scheduled:-' AND pg_temp.members(pg_temp.id('oD'), pg_temp.id('p_d')) = 0, g);
  INSERT INTO r3962 VALUES ('B06_billing_not_ready_recorded',
    (SELECT last_defer_reason FROM public.domain_capture_switches WHERE id = pg_temp.sid(pg_temp.id('p_d'))) = 'billing_not_ready', g);

  -- ---- the brokerage's Billing step not done ---------------------------------------------------
  INSERT INTO public.org_deals (organization_id, stripe_mode, seats, status) VALUES (pg_temp.id('oD'), 'test', 5, 'draft');
  INSERT INTO public.org_deal_lines (organization_id, item_key, quantity_rule, unit_price_cents)
    VALUES (pg_temp.id('oD'), 'brokerage_seat', 'seats', 5000);
  g := pg_temp.start(pg_temp.id('u_admD'), pg_temp.id('oD'), pg_temp.id('cD'), ARRAY[pg_temp.id('p_d2')]);
  INSERT INTO r3962 VALUES ('B03_start_refused_billing_setup_pending',
    g LIKE '%billing_setup_incomplete%' AND NOT EXISTS (SELECT 1 FROM public.domain_capture_switches WHERE user_id = pg_temp.id('p_d2')), g);
  g := pg_temp.sw(pg_temp.sid(pg_temp.id('p_d')));
  INSERT INTO r3962 VALUES ('B04_switch_deferred_billing_setup_pending',
    g LIKE '%billing_setup_incomplete%' AND pg_temp.sst(pg_temp.id('p_d')) = 'scheduled:-' AND pg_temp.members(pg_temp.id('oD'), pg_temp.id('p_d')) = 0, g);
  g2 := pg_temp.q(pg_temp.id('u_admD'), 'authenticated', format('SELECT public.domain_capture_candidates(%L::uuid, %L::uuid)::text', pg_temp.id('oD'), pg_temp.id('cD')));
  INSERT INTO r3962 VALUES ('B07_setup_deferral_recorded_and_listed',
    (SELECT last_defer_reason FROM public.domain_capture_switches WHERE id = pg_temp.sid(pg_temp.id('p_d'))) = 'billing_setup_incomplete'
      AND (SELECT x ->> 'last_defer_reason' FROM jsonb_array_elements(coalesce((g2::jsonb) -> 'candidates', '[]'::jsonb)) x
            WHERE x ->> 'email' = 'd@d-3962.test') = 'billing_setup_incomplete', left(g2, 300));
  DELETE FROM public.org_deals WHERE organization_id = pg_temp.id('oD');
  g := pg_temp.sw(pg_temp.sid(pg_temp.id('p_d')));
  INSERT INTO r3962 VALUES ('B05_same_switch_goes_through_once_setup_done',
    g LIKE '%switched%' AND pg_temp.members(pg_temp.id('oD'), pg_temp.id('p_d')) = 1, g);
  INSERT INTO r3962 VALUES ('B08_defer_cleared_on_switch',
    (SELECT last_defer_reason FROM public.domain_capture_switches WHERE user_id = pg_temp.id('p_d') AND status = 'switched') IS NULL, '');

  -- ---- suspended brokerage: cancelled, no membership, no outbox row ------------------------------
  PERFORM pg_temp.start(pg_temp.id('u_admS'), pg_temp.id('oS'), pg_temp.id('cS'), ARRAY[pg_temp.id('p_s')]);
  PERFORM pg_temp.mark(pg_temp.sid(pg_temp.id('p_s')), 'sent');
  UPDATE public.domain_capture_switches SET switch_at = now() - interval '1 minute' WHERE organization_id = pg_temp.id('oS');
  INSERT INTO public.org_deals (organization_id, stripe_mode, seats, status, suspended_at, suspended_reason, status_before_suspension)
    VALUES (pg_temp.id('oS'), 'test', 5, 'suspended', now(), 'other', 'active');
  n := pg_temp.outbox(pg_temp.id('p_s'));
  g := pg_temp.sw(pg_temp.sid(pg_temp.id('p_s')));
  INSERT INTO r3962 VALUES ('H01_suspended_brokerage_cancels_no_member_no_outbox',
    g LIKE '%brokerage_suspended%' AND g LIKE '%"success": true%' AND pg_temp.sst(pg_temp.id('p_s')) = 'cancelled:brokerage_suspended'
      AND pg_temp.members(pg_temp.id('oS'), pg_temp.id('p_s')) = 0 AND pg_temp.outbox(pg_temp.id('p_s')) = n
      AND EXISTS (SELECT 1 FROM public.organization_members m JOIN public.organizations o ON o.id = m.organization_id
                   WHERE m.user_id = pg_temp.id('p_s') AND o.personal_owner_user_id IS NOT NULL), g);

  -- ---- role = the organization's default; an incomplete subscription is not a payer -------------
  g := pg_temp.start(pg_temp.id('u_admK'), pg_temp.id('oK'), pg_temp.id('cK'), ARRAY[pg_temp.id('p_k'), pg_temp.id('p_i')]);
  PERFORM pg_temp.mark(pg_temp.sid(pg_temp.id(x)), 'sent') FROM unnest(ARRAY['p_k', 'p_i']) x;
  UPDATE public.domain_capture_switches SET switch_at = now() - interval '1 minute' WHERE organization_id = pg_temp.id('oK');
  g := pg_temp.sw(pg_temp.sid(pg_temp.id('p_k')));
  INSERT INTO r3962 VALUES ('R01_role_is_org_default_member_role',
    (SELECT role FROM public.organization_members WHERE organization_id = pg_temp.id('oK') AND user_id = pg_temp.id('p_k')) = 'broker', g);
  -- an organization default of 'admin' never reaches a captured member (auto-join precedent)
  UPDATE public.organizations SET default_member_role = 'admin' WHERE id = pg_temp.id('oK');
  g := pg_temp.sw(pg_temp.sid(pg_temp.id('p_i')));
  INSERT INTO r3962 VALUES ('R02_org_default_admin_clamped_to_agent',
    (SELECT role FROM public.organization_members WHERE organization_id = pg_temp.id('oK') AND user_id = pg_temp.id('p_i')) = 'agent', g);
  j := CASE WHEN g LIKE '{%' THEN g::jsonb ELSE '{}'::jsonb END;
  INSERT INTO r3962 VALUES ('P01_incomplete_subscription_is_not_a_payer',
    j ->> 'outcome' = 'switched' AND j ->> 'payer' = 'false'
      AND (SELECT payer FROM public.domain_capture_switches WHERE user_id = pg_temp.id('p_i') AND status = 'switched') = false, g);

  -- ---- due ----------------------------------------------------------------------------------
  PERFORM pg_temp.start(uAdmA, oA, cA, ARRAY[pFail]);  -- email no longer on domain: skipped
  UPDATE auth.users SET email = 'fail@cap-3962.test' WHERE id = pFail;
  PERFORM pg_temp.start(uAdmA, oA, cA, ARRAY[pFail]);
  UPDATE public.domain_capture_switches SET switch_at = now() - interval '1 minute' WHERE user_id = pFail AND status = 'scheduled';
  g := pg_temp.q(NULL, 'service_role', 'SELECT count(*)::text FROM public._domain_capture_due(50)');
  INSERT INTO r3962 VALUES ('D01_due_returns_then_stamps', g = '1'
    AND pg_temp.q(NULL, 'service_role', 'SELECT count(*)::text FROM public._domain_capture_due(50)') = '0', g);
  g := pg_temp.q(uAdmA, 'authenticated', 'SELECT count(*)::text FROM public._domain_capture_due(50)');
  INSERT INTO r3962 VALUES ('D02_client_cannot_list_due', g LIKE 'ERR 42501%', g);

  -- ---- a P0001 that is not account_suspended / seat_limit_reached is not swallowed -----------------
  PERFORM pg_temp.start(pg_temp.id('u_admK'), pg_temp.id('oK'), pg_temp.id('cK'), ARRAY[pg_temp.id('p_h')]);
  PERFORM pg_temp.mark(pg_temp.sid(pg_temp.id('p_h')), 'sent');
  UPDATE public.domain_capture_switches SET switch_at = now() - interval '1 minute' WHERE user_id = pg_temp.id('p_h');
  CREATE TRIGGER h02_other_p0001 BEFORE INSERT ON public.organization_members
    FOR EACH ROW EXECUTE FUNCTION pg_temp.h02_refuse();
  g := pg_temp.sw(pg_temp.sid(pg_temp.id('p_h')));
  DROP TRIGGER h02_other_p0001 ON public.organization_members;
  INSERT INTO r3962 VALUES ('H02_other_p0001_reraised_switch_stays_scheduled',
    g LIKE 'ERR P0001%bl3962_other_refusal%' AND pg_temp.sst(pg_temp.id('p_h')) = 'scheduled:-'
      AND pg_temp.members(pg_temp.id('oK'), pg_temp.id('p_h')) = 0, g);

  -- ---- PR3b: history -------------------------------------------------------------------------
  g := pg_temp.q(uAdmA, 'authenticated', format('SELECT public.domain_capture_history(%L::uuid)::text', oA));
  j := CASE WHEN g LIKE '{%' THEN g::jsonb ELSE '{}'::jsonb END;
  INSERT INTO r3962 VALUES ('Y01_history_admin_sees_org_rows',
    j ->> 'success' = 'true'
      AND jsonb_array_length(j -> 'switches') = (SELECT count(*) FROM public.domain_capture_switches WHERE organization_id = oA)
      AND EXISTS (SELECT 1 FROM jsonb_array_elements(j -> 'switches') x WHERE x ->> 'email' = 'opt@cap-3962.test' AND x ->> 'status' = 'opted_out')
      AND EXISTS (SELECT 1 FROM jsonb_array_elements(j -> 'switches') x WHERE x ->> 'email' = 'mail@cap-3962.test' AND x ->> 'name' = 'Mail Person 3962' AND x ->> 'status' = 'switched')
      AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(j -> 'switches') x WHERE x ->> 'email' LIKE '%@d-3962.test'),
    left(g, 400));
  g := pg_temp.q(uAgA, 'authenticated', format('SELECT public.domain_capture_history(%L::uuid)::text', oA));
  INSERT INTO r3962 VALUES ('Y02_history_agent_refused', g LIKE '%not_authorized%', g);
  g := pg_temp.q(uAdmB, 'authenticated', format('SELECT public.domain_capture_history(%L::uuid)::text', oA));
  INSERT INTO r3962 VALUES ('Y03_history_other_org_admin_refused', g LIKE '%not_authorized%', g);
  g := pg_temp.q(NULL, 'anon', format('SELECT public.domain_capture_history(%L::uuid)::text', oA));
  INSERT INTO r3962 VALUES ('Y04_history_anon_no_execute', g LIKE 'ERR 42501%', g);

  FOR k IN SELECT * FROM r3962 ORDER BY 1 LOOP
    IF k.ok IS TRUE THEN v_pass := v_pass + 1;
    ELSE v_fail := v_fail + 1; reds := reds || jsonb_build_object(k.k, left(coalesce(k.got, 'null'), 300));
    END IF;
  END LOOP;
  RAISE EXCEPTION 'P3962_RESULT %', jsonb_build_object('mode', current_setting('p3962.mode', true),
    'pass', v_pass, 'fail', v_fail, 'reds', reds);
END
$drv$;
