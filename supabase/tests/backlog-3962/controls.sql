-- BACKLOG-3962 PR1 (20261112100000) DB tests and controls for domain_claims and its functions.
-- Venue: keepr-test via ~/.claude/bin/kt-sql. ONE call, one implicit transaction that always ends
-- in RAISE, so nothing persists. compose.py prepends the migration (or a mutant of it).
-- now() is fixed inside one transaction, so elapsed time is simulated by moving timestamps back.
-- Output: RAISE 'P3962_RESULT {"mode":..., "pass":n, "fail":n, "reds":{case: got}}'.

CREATE FUNCTION pg_temp.id(t text) RETURNS uuid LANGUAGE sql IMMUTABLE AS $b$ SELECT md5('bl3962:' || t)::uuid $b$;

CREATE FUNCTION pg_temp.as_user(u uuid, r text) RETURNS void LANGUAGE plpgsql AS $b$
BEGIN
  PERFORM set_config('request.jwt.claims', json_build_object('sub', u, 'role', r)::text, true);
  PERFORM set_config('request.jwt.claim.sub', coalesce(u::text, ''), true);
  PERFORM set_config('request.jwt.claim.role', r, true);
END $b$;

-- Run q as user u with database role r: the first column as text, or 'ERR <sqlstate> <message>'.
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
    RETURN 'ERR ' || SQLSTATE || ' ' || left(SQLERRM, 80);
  END;
END $b$;

CREATE FUNCTION pg_temp.tok(c uuid) RETURNS text LANGUAGE sql AS $b$ SELECT token FROM public.domain_claims WHERE id = c $b$;
CREATE FUNCTION pg_temp.st(c uuid) RETURNS text LANGUAGE sql AS $b$ SELECT status FROM public.domain_claims WHERE id = c $b$;
CREATE FUNCTION pg_temp.misses(c uuid) RETURNS int LANGUAGE sql AS $b$ SELECT consecutive_misses FROM public.domain_claims WHERE id = c $b$;

-- server-role record_check
CREATE FUNCTION pg_temp.rc(c uuid, o uuid, answers text[], ok boolean, src text) RETURNS text LANGUAGE sql AS $b$
  SELECT pg_temp.q(NULL, 'service_role', format(
    'SELECT public._domain_claim_record_check(%L::uuid, %L::uuid, %L::text[], %L::boolean, %L)::text', c, o, answers, ok, src))
$b$;
CREATE FUNCTION pg_temp.bc(c uuid, o uuid) RETURNS text LANGUAGE sql AS $b$
  SELECT pg_temp.q(NULL, 'service_role', format('SELECT public._domain_claim_begin_check(%L::uuid, %L::uuid)::text', c, o))
$b$;
CREATE FUNCTION pg_temp.cr(u uuid, o uuid, d text) RETURNS text LANGUAGE sql AS $b$
  SELECT pg_temp.q(u, 'authenticated', format('SELECT public.domain_claim_create(%L::uuid, %L)::text', o, d))
$b$;
CREATE FUNCTION pg_temp.cid(j text) RETURNS uuid LANGUAGE sql AS $b$ SELECT (j::jsonb ->> 'claim_id')::uuid $b$;

-- Fixtures. A, B, C are brokerages; P is u_p's personal org. u_s is staff with organizations.edit
-- and .view, u_v staff with .view only.
INSERT INTO auth.users (id, email, instance_id, aud, role)
  SELECT pg_temp.id(k), k || '-3962@example.test', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated'
  FROM unnest(ARRAY['u_a','u_ag','u_b','u_c','u_p','u_s','u_v']) k;
INSERT INTO public.users (id, email, oauth_provider, oauth_id)
  SELECT pg_temp.id(k), k || '-3962@example.test', 'google', k || '3962'
  FROM unnest(ARRAY['u_a','u_ag','u_b','u_c','u_p','u_s','u_v']) k
  ON CONFLICT DO NOTHING;
INSERT INTO public.licenses (user_id, license_key, license_type, status)
  SELECT pg_temp.id(k), 'lk-3962-' || k, 'individual', 'active'
  FROM unnest(ARRAY['u_a','u_ag','u_b','u_c','u_p']) k
  ON CONFLICT DO NOTHING;
INSERT INTO public.admin_roles (id, name, slug) VALUES
  (pg_temp.id('role_edit'), 'org edit 3962', 'org-edit-3962'),
  (pg_temp.id('role_view'), 'org view 3962', 'org-view-3962');
INSERT INTO public.admin_role_permissions (role_id, permission_id)
  SELECT pg_temp.id('role_edit'), id FROM public.admin_permissions WHERE key IN ('organizations.edit', 'organizations.view');
INSERT INTO public.admin_role_permissions (role_id, permission_id)
  SELECT pg_temp.id('role_view'), id FROM public.admin_permissions WHERE key = 'organizations.view';
INSERT INTO public.internal_roles (user_id, role_id) VALUES
  (pg_temp.id('u_s'), pg_temp.id('role_edit')),
  (pg_temp.id('u_v'), pg_temp.id('role_view'));
INSERT INTO public.organizations (id, name, slug, is_test, max_seats) VALUES
  (pg_temp.id('oA'), 'Org A 3962', 'org-a-3962', true, 10),
  (pg_temp.id('oB'), 'Org B 3962', 'org-b-3962', true, 10),
  (pg_temp.id('oC'), 'Org C 3962', 'org-c-3962', true, 10);
INSERT INTO public.organizations (id, name, slug, is_test, max_seats, personal_owner_user_id) VALUES
  (pg_temp.id('oP'), 'Personal', 'org-p-3962', true, 1, pg_temp.id('u_p'));
INSERT INTO public.organization_members (organization_id, user_id, role, license_status) VALUES
  (pg_temp.id('oA'), pg_temp.id('u_a'), 'admin', 'active'),
  (pg_temp.id('oA'), pg_temp.id('u_ag'), 'agent', 'active'),
  (pg_temp.id('oB'), pg_temp.id('u_b'), 'admin', 'active'),
  (pg_temp.id('oC'), pg_temp.id('u_c'), 'it_admin', 'active'),
  (pg_temp.id('oP'), pg_temp.id('u_p'), 'admin', 'active');

-- compose.py replaces the next line with the mode name.
-- __MODE__

DO $drv$
DECLARE
  oA uuid := pg_temp.id('oA'); oB uuid := pg_temp.id('oB'); oC uuid := pg_temp.id('oC'); oP uuid := pg_temp.id('oP');
  uA uuid := pg_temp.id('u_a'); uAG uuid := pg_temp.id('u_ag'); uB uuid := pg_temp.id('u_b');
  uC uuid := pg_temp.id('u_c'); uP uuid := pg_temp.id('u_p'); uS uuid := pg_temp.id('u_s'); uV uuid := pg_temp.id('u_v');
  D text := 'brokerage-3962.test';
  g text; g2 text; cA uuid; cB uuid; cA2 uuid; n int; i int; tA text; tB text;
  v_pass int := 0; v_fail int := 0; reds jsonb := '{}'::jsonb; k record;
BEGIN
  CREATE TEMP TABLE r3962 (k text, ok boolean, got text) ON COMMIT DROP;

  -- ---- create: caller and role (task control b) ------------------------------------------
  g := pg_temp.cr(uA, oA, '  Brokerage-3962.TEST.  ');
  INSERT INTO r3962 VALUES ('T01_admin_creates_normalised',
    g LIKE '%"success": true%' AND g::jsonb ->> 'domain' = D AND g::jsonb ->> 'record_name' = '_keepr.' || D
      AND g::jsonb ->> 'record_value' ~ '^keepr-domain-verification=[0-9a-f]{48}$', g);
  cA := pg_temp.cid(g); tA := pg_temp.tok(cA);
  INSERT INTO r3962 VALUES ('T01b_token_is_returned_value', tA = g::jsonb ->> 'record_value', tA);
  g := pg_temp.cr(uC, oC, 'it-admin-3962.test');
  INSERT INTO r3962 VALUES ('T02_it_admin_creates', g LIKE '%"success": true%', g);
  g := pg_temp.cr(uAG, oA, 'agent-3962.test');
  INSERT INTO r3962 VALUES ('T03_agent_refused', g LIKE '%not_authorized%', g);
  g := pg_temp.cr(uB, oA, 'other-org-3962.test');
  INSERT INTO r3962 VALUES ('T04_admin_of_other_org_refused', g LIKE '%not_authorized%', g);
  g := pg_temp.q(NULL, 'anon', format('SELECT public.domain_claim_create(%L::uuid, %L)::text', oA, 'anon-3962.test'));
  INSERT INTO r3962 VALUES ('T05_anon_no_execute', g LIKE 'ERR 42501%', g);
  g := pg_temp.cr(uP, oP, 'personal-3962.test');
  INSERT INTO r3962 VALUES ('T06_personal_org_refused', g LIKE '%not_authorized%', g);
  SELECT count(*) INTO n FROM public.domain_claims WHERE domain IN ('agent-3962.test', 'other-org-3962.test', 'anon-3962.test', 'personal-3962.test');
  INSERT INTO r3962 VALUES ('T06b_no_rows_from_refusals', n = 0, n::text);

  -- ---- create: domain rules (C5, C7) -------------------------------------------------------
  g := pg_temp.cr(uA, oA, 'gmail.com');
  INSERT INTO r3962 VALUES ('T07_consumer_gmail_refused', g LIKE '%consumer_domain%', g);
  g := pg_temp.cr(uA, oA, 'Comcast.net');
  INSERT INTO r3962 VALUES ('T08_consumer_comcast_refused', g LIKE '%consumer_domain%', g);
  g := concat_ws('|', pg_temp.cr(uA, oA, 'https://b3962.test/x'), pg_temp.cr(uA, oA, 'a@b3962.test'),
                 pg_temp.cr(uA, oA, 'localhost'), pg_temp.cr(uA, oA, '10.0.0.1'), pg_temp.cr(uA, oA, 'b3962.test:443'),
                 pg_temp.cr(uA, oA, 'a b.test'), pg_temp.cr(uA, oA, 'bücher.test'), pg_temp.cr(uA, oA, '-a.test'));
  INSERT INTO r3962 VALUES ('T09_invalid_refused', (length(g) - length(replace(g, 'invalid_domain', ''))) / length('invalid_domain') = 8, g);
  g := pg_temp.cr(uA, oA, 'xn--bcher-kva.test');
  INSERT INTO r3962 VALUES ('T10_a_label_accepted', g LIKE '%"success": true%', g);
  g := pg_temp.cr(uA, oA, D);
  INSERT INTO r3962 VALUES ('T11_recreate_returns_existing', g LIKE '%"existing": true%' AND pg_temp.cid(g) = cA, g);

  -- B may hold a PENDING claim for the same domain.
  g := pg_temp.cr(uB, oB, D);
  INSERT INTO r3962 VALUES ('T12_second_org_pending_allowed', g LIKE '%"success": true%' AND g LIKE '%"existing": false%', g);
  cB := pg_temp.cid(g); tB := pg_temp.tok(cB);
  INSERT INTO r3962 VALUES ('T12b_tokens_differ', tA IS DISTINCT FROM tB, tB);

  -- ---- begin_check: org binding (R2), rate limit (C8), server role only (C4, C4b/R1) ------
  g := pg_temp.bc(cA, oB);
  INSERT INTO r3962 VALUES ('T13_claim_of_other_org_refused', g LIKE '%claim_not_found%', g);
  g := pg_temp.bc(cA, oA);
  INSERT INTO r3962 VALUES ('T14_begin_check_ok_no_token', g LIKE '%"success": true%' AND g::jsonb ->> 'domain' = D AND g NOT LIKE '%keepr-domain-verification%', g);
  g := pg_temp.bc(cA, oA);
  INSERT INTO r3962 VALUES ('T15_second_check_too_soon', g LIKE '%too_soon%', g);
  UPDATE public.domain_claims SET last_checked_at = now() - interval '31 seconds' WHERE id = cA;
  g := pg_temp.bc(cA, oA);
  INSERT INTO r3962 VALUES ('T16_after_30s_ok', g LIKE '%"success": true%', g);
  g := pg_temp.q(uA, 'authenticated', format('SELECT public._domain_claim_begin_check(%L::uuid, %L::uuid)::text', cA, oA));
  INSERT INTO r3962 VALUES ('T17_begin_check_authenticated_denied', g LIKE 'ERR 42501%', g);
  g := pg_temp.q(uA, 'authenticated', format('SELECT public._domain_claim_record_check(%L::uuid, %L::uuid, %L::text[], true, %L)::text', cA, oA, ARRAY[tA], 'manual'));
  INSERT INTO r3962 VALUES ('T18_record_check_authenticated_denied', g LIKE 'ERR 42501%' AND pg_temp.st(cA) = 'pending', g);
  -- C4b: even with an EXECUTE grant, the inside check refuses a client role.
  GRANT EXECUTE ON FUNCTION public._domain_claim_record_check(uuid, uuid, text[], boolean, text) TO authenticated;
  GRANT EXECUTE ON FUNCTION public._domain_claim_begin_check(uuid, uuid) TO authenticated;
  GRANT EXECUTE ON FUNCTION public._domain_claims_due_for_recheck(integer) TO authenticated;
  g := pg_temp.q(uA, 'authenticated', format('SELECT public._domain_claim_record_check(%L::uuid, %L::uuid, %L::text[], true, %L)::text', cA, oA, ARRAY[tA], 'manual'));
  INSERT INTO r3962 VALUES ('T19_C4b_record_check_granted_still_refused', g LIKE 'ERR 42501%' AND pg_temp.st(cA) = 'pending', g);
  g := pg_temp.q(uA, 'authenticated', format('SELECT public._domain_claim_begin_check(%L::uuid, %L::uuid)::text', cA, oA));
  INSERT INTO r3962 VALUES ('T19b_C4b_begin_check_granted_still_refused', g LIKE 'ERR 42501%', g);
  g := pg_temp.q(uA, 'authenticated', 'SELECT count(*)::text FROM public._domain_claims_due_for_recheck(10)');
  INSERT INTO r3962 VALUES ('T19c_C4b_due_granted_still_refused', g LIKE 'ERR 42501%', g);
  REVOKE EXECUTE ON FUNCTION public._domain_claim_record_check(uuid, uuid, text[], boolean, text) FROM authenticated;
  REVOKE EXECUTE ON FUNCTION public._domain_claim_begin_check(uuid, uuid) FROM authenticated;
  REVOKE EXECUTE ON FUNCTION public._domain_claims_due_for_recheck(integer) FROM authenticated;

  -- ---- record_check: the token match (task control a, C2, C6) -----------------------------
  g := pg_temp.rc(cA, oA, ARRAY['v=spf1 -all'], true, 'manual');
  INSERT INTO r3962 VALUES ('T20_unrelated_txt_not_found', g LIKE '%"result": "not_found"%' AND pg_temp.st(cA) = 'pending', g);
  g := pg_temp.rc(cA, oA, ARRAY[]::text[], true, 'manual');
  INSERT INTO r3962 VALUES ('T21_no_answers_not_found', g LIKE '%"result": "not_found"%', g);
  g := pg_temp.rc(cA, oA, ARRAY[tA], false, 'manual');
  INSERT INTO r3962 VALUES ('T22_resolver_down_not_verified', g LIKE '%resolver_unavailable%' AND pg_temp.st(cA) = 'pending', g);
  -- C6: a value that only CONTAINS the token (a split record joined with a suffix).
  g := pg_temp.rc(cA, oA, ARRAY[tA || 'x', 'x' || tA], true, 'manual');
  INSERT INTO r3962 VALUES ('T23_C6_substring_not_verified', g LIKE '%"result": "mismatch"%' AND pg_temp.st(cA) = 'pending', g);
  -- C6b: the token with extra text after it, or a prefix word before it (whitespace inside the value).
  g := pg_temp.rc(cA, oA, ARRAY[tA || ' extra text', 'v=spf1 ' || tA], true, 'manual');
  INSERT INTO r3962 VALUES ('T23c_token_with_extra_words_not_verified', (g LIKE '%"result": "mismatch"%' OR g LIKE '%"result": "not_found"%') AND g NOT LIKE '%"result": "verified"%' AND pg_temp.st(cA) = 'pending', g);
  g := pg_temp.rc(cA, oA, ARRAY[upper(tA)], true, 'manual');
  INSERT INTO r3962 VALUES ('T23b_case_changed_not_verified', g NOT LIKE '%"result": "verified"%' AND pg_temp.st(cA) = 'pending', g);
  -- C2: B's check with A's token in DNS.
  g := pg_temp.rc(cB, oB, ARRAY[tA], true, 'manual');
  INSERT INTO r3962 VALUES ('T24_C2_other_orgs_token_mismatch', g LIKE '%"result": "mismatch"%' AND pg_temp.st(cB) = 'pending', g);
  -- record_check on a claim of another org
  g := pg_temp.rc(cA, oB, ARRAY[tA], true, 'manual');
  INSERT INTO r3962 VALUES ('T25_record_check_wrong_org', g LIKE '%claim_not_found%' AND pg_temp.st(cA) = 'pending', g);
  -- the real pass: exact token among other TXT values, surrounding spaces trimmed
  g := pg_temp.rc(cA, oA, ARRAY['v=spf1 include:x -all', '  ' || tA || ' '], true, 'manual');
  INSERT INTO r3962 VALUES ('T26_exact_token_verifies', g LIKE '%"result": "verified"%' AND pg_temp.st(cA) = 'verified', g);

  -- ---- one domain, two brokerages (task control c, C3) ------------------------------------
  g := pg_temp.rc(cB, oB, ARRAY[tB], true, 'manual');
  INSERT INTO r3962 VALUES ('T27_C3_second_org_domain_taken', g LIKE '%domain_taken%' AND pg_temp.st(cB) = 'pending', g);
  SELECT count(*) INTO n FROM public.domain_claims WHERE domain = D AND status = 'verified';
  INSERT INTO r3962 VALUES ('T28_one_verified_per_domain', n = 1, n::text);
  g := pg_temp.cr(uC, oC, D);
  INSERT INTO r3962 VALUES ('T29_new_claim_on_verified_domain_taken', g LIKE '%domain_taken%', g);

  -- ---- R5: misses count only on spaced re-checks -----------------------------------------
  FOR i IN 1..3 LOOP
    UPDATE public.domain_claims SET last_checked_at = now() - interval '31 seconds' WHERE id = cA;
    g := pg_temp.rc(cA, oA, ARRAY[]::text[], true, 'manual');
  END LOOP;
  INSERT INTO r3962 VALUES ('T30_R5_three_manual_misses_still_verified', pg_temp.st(cA) = 'verified' AND pg_temp.misses(cA) = 0, pg_temp.st(cA) || ':' || pg_temp.misses(cA));
  g := pg_temp.rc(cA, oA, ARRAY[]::text[], true, 'recheck');
  g := pg_temp.rc(cA, oA, ARRAY[]::text[], true, 'recheck');
  INSERT INTO r3962 VALUES ('T31_R5_back_to_back_rechecks_count_once', pg_temp.st(cA) = 'verified' AND pg_temp.misses(cA) = 1, pg_temp.st(cA) || ':' || pg_temp.misses(cA));
  g := pg_temp.rc(cA, oA, ARRAY[]::text[], false, 'recheck');
  UPDATE public.domain_claims SET last_miss_counted_at = now() - interval '21 hours' WHERE id = cA;
  g := pg_temp.rc(cA, oA, ARRAY[]::text[], false, 'recheck');
  INSERT INTO r3962 VALUES ('T32_resolver_outage_never_counts', pg_temp.misses(cA) = 1, pg_temp.misses(cA)::text);
  g := pg_temp.rc(cA, oA, ARRAY[]::text[], true, 'recheck');
  INSERT INTO r3962 VALUES ('T33_spaced_second_miss', pg_temp.st(cA) = 'verified' AND pg_temp.misses(cA) = 2, pg_temp.st(cA) || ':' || pg_temp.misses(cA));
  UPDATE public.domain_claims SET last_miss_counted_at = now() - interval '21 hours' WHERE id = cA;
  g := pg_temp.rc(cA, oA, ARRAY[]::text[], true, 'recheck');
  INSERT INTO r3962 VALUES ('T34_third_spaced_miss_lapses', pg_temp.st(cA) = 'lapsed' AND pg_temp.misses(cA) = 3, g);
  -- a lapsed claim frees the domain: B's own token now verifies B
  g := pg_temp.rc(cB, oB, ARRAY[tB], true, 'manual');
  INSERT INTO r3962 VALUES ('T35_lapse_frees_domain', g LIKE '%"result": "verified"%' AND pg_temp.st(cB) = 'verified', g);
  g := pg_temp.rc(cA, oA, ARRAY[tA], true, 'manual');
  INSERT INTO r3962 VALUES ('T36_lapsed_cannot_retake', g LIKE '%domain_taken%' AND pg_temp.st(cA) = 'lapsed', g);
  -- a hit on a verified row resets misses
  UPDATE public.domain_claims SET consecutive_misses = 2 WHERE id = cB;
  g := pg_temp.rc(cB, oB, ARRAY[tB], true, 'recheck');
  INSERT INTO r3962 VALUES ('T37_hit_resets_misses', pg_temp.misses(cB) = 0, pg_temp.misses(cB)::text);

  -- ---- due_for_recheck -------------------------------------------------------------------
  UPDATE public.domain_claims SET last_checked_at = now() - interval '21 hours' WHERE id IN (cA, cB);
  g := pg_temp.q(NULL, 'service_role', 'SELECT string_agg(claim_id::text, '','') FROM public._domain_claims_due_for_recheck(50)');
  g2 := pg_temp.q(NULL, 'service_role', 'SELECT coalesce(string_agg(claim_id::text, '',''), '''') FROM public._domain_claims_due_for_recheck(50)');
  INSERT INTO r3962 VALUES ('T38_due_selects_and_stamps',
    position(cA::text IN g) > 0 AND position(cB::text IN g) > 0 AND position(cA::text IN g2) = 0 AND position(cB::text IN g2) = 0, g || ' / ' || g2);

  -- ---- withdraw --------------------------------------------------------------------------
  g := pg_temp.q(uB, 'authenticated', format('SELECT public.domain_claim_withdraw(%L::uuid)::text', cA));
  INSERT INTO r3962 VALUES ('T39_withdraw_other_org_refused', g LIKE '%claim_not_found%' AND pg_temp.st(cA) = 'lapsed', g);
  g := pg_temp.q(uAG, 'authenticated', format('SELECT public.domain_claim_withdraw(%L::uuid)::text', cA));
  INSERT INTO r3962 VALUES ('T40_withdraw_agent_refused', g LIKE '%claim_not_found%', g);
  g := pg_temp.q(uA, 'authenticated', format('SELECT public.domain_claim_withdraw(%L::uuid)::text', cA));
  INSERT INTO r3962 VALUES ('T41_withdraw_admin_ok', g LIKE '%"success": true%' AND pg_temp.st(cA) = 'withdrawn', g);
  UPDATE public.domain_claims SET last_checked_at = NULL WHERE id = cA;
  g := pg_temp.bc(cA, oA);
  INSERT INTO r3962 VALUES ('T42_withdrawn_not_checkable', g LIKE '%not_checkable%', g);
  g := pg_temp.cr(uA, oA, 'second-3962.test');
  cA2 := pg_temp.cid(g);
  INSERT INTO r3962 VALUES ('T43_new_claim_new_token', pg_temp.tok(cA2) IS DISTINCT FROM tA, g);

  -- ---- RLS and table grants --------------------------------------------------------------
  g := pg_temp.q(uA, 'authenticated', 'SELECT count(*)::text || '':'' || count(*) FILTER (WHERE organization_id <> ''' || oA || ''')::text FROM public.domain_claims');
  SELECT count(*) INTO n FROM public.domain_claims WHERE organization_id = oA;
  INSERT INTO r3962 VALUES ('T44_rls_admin_sees_own_org_only', g = n || ':0', g);
  g := pg_temp.q(uAG, 'authenticated', 'SELECT count(*)::text FROM public.domain_claims');
  INSERT INTO r3962 VALUES ('T45_rls_agent_sees_none', g = '0', g);
  g := pg_temp.q(NULL, 'anon', 'SELECT count(*)::text FROM public.domain_claims');
  INSERT INTO r3962 VALUES ('T46_anon_no_select', g LIKE 'ERR 42501%', g);
  g := pg_temp.q(uA, 'authenticated', format('INSERT INTO public.domain_claims (organization_id, domain, token, status) VALUES (%L, %L, %L, %L) RETURNING id::text',
       oA, 'direct-3962.test', 'keepr-domain-verification=' || repeat('a', 48), 'verified'));
  INSERT INTO r3962 VALUES ('T47_direct_insert_denied', g LIKE 'ERR 42501%', g);
  g := pg_temp.q(uA, 'authenticated', format('UPDATE public.domain_claims SET status = %L WHERE id = %L RETURNING id::text', 'verified', cA2));
  INSERT INTO r3962 VALUES ('T48_direct_update_denied', g LIKE 'ERR 42501%' AND pg_temp.st(cA2) = 'pending', g);
  g := pg_temp.q(uA, 'authenticated', 'TRUNCATE public.domain_claims');
  INSERT INTO r3962 VALUES ('T49_truncate_denied', g LIKE 'ERR 42501%', g);
  g := pg_temp.q(uA, 'authenticated', format('SELECT public._normalize_claim_domain(%L)', 'x.test'));
  INSERT INTO r3962 VALUES ('T50_internal_helper_denied', g LIKE 'ERR 42501%', g);

  -- ---- claim limit -----------------------------------------------------------------------
  FOR i IN 1..9 LOOP
    g := pg_temp.cr(uC, oC, 'limit' || i || '-3962.test');
  END LOOP;
  g := pg_temp.cr(uC, oC, 'limit10-3962.test');
  SELECT count(*) INTO n FROM public.domain_claims WHERE organization_id = oC AND status IN ('pending', 'verified', 'lapsed');
  INSERT INTO r3962 VALUES ('T51_eleventh_live_claim_refused', g LIKE '%too_many_claims%' AND n = 10, g || ' n=' || n);

  -- ---- staff functions -------------------------------------------------------------------
  g := pg_temp.q(uA, 'authenticated', format('SELECT public.admin_list_domain_claims(%L::uuid)::text', oA));
  INSERT INTO r3962 VALUES ('T52_list_non_staff_refused', g LIKE '%not_internal_user%', g);
  g := pg_temp.q(uV, 'authenticated', format('SELECT public.admin_list_domain_claims(%L::uuid)::text', oA));
  INSERT INTO r3962 VALUES ('T53_list_view_staff_no_token', g LIKE '%"success": true%' AND g NOT LIKE '%keepr-domain-verification%' AND g NOT LIKE '%"token"%', left(g, 80));
  g := pg_temp.q(uV, 'authenticated', format('SELECT public.admin_revoke_domain_claim(%L::uuid, %L)::text', cB, 'test'));
  INSERT INTO r3962 VALUES ('T54_revoke_view_only_refused', g LIKE '%insufficient_permissions%' AND pg_temp.st(cB) = 'verified', g);
  g := pg_temp.q(uS, 'authenticated', format('SELECT public.admin_revoke_domain_claim(%L::uuid, %L)::text', cB, '   '));
  INSERT INTO r3962 VALUES ('T55_revoke_blank_reason_refused', g LIKE '%invalid_reason%', g);
  g := pg_temp.q(uS, 'authenticated', format('SELECT public.admin_revoke_domain_claim(%L::uuid, %L)::text', cB, 'support request 3962'));
  SELECT count(*) INTO n FROM public.admin_audit_logs
   WHERE action = 'domain_claim.revoke' AND target_type = 'domain_claim' AND target_id = cB::text AND actor_id = uS
     AND metadata ->> 'reason' = 'support request 3962' AND metadata #>> '{before,status}' = 'verified';
  INSERT INTO r3962 VALUES ('T56_revoke_ok_and_logged', g LIKE '%"success": true%' AND pg_temp.st(cB) = 'revoked' AND n = 1, g || ' audit=' || n);
  g := pg_temp.cr(uA, oA, D);
  INSERT INTO r3962 VALUES ('T57_revoke_frees_domain', g LIKE '%"success": true%' AND g LIKE '%"existing": false%', g);

  FOR k IN SELECT * FROM r3962 ORDER BY r3962.k LOOP
    IF k.ok THEN v_pass := v_pass + 1;
    ELSE v_fail := v_fail + 1; reds := reds || jsonb_build_object(k.k, coalesce(k.got, 'NULL'));
    END IF;
  END LOOP;
  RAISE EXCEPTION 'P3962_RESULT %', jsonb_build_object('mode', current_setting('p3962.mode', true),
    'pass', v_pass, 'fail', v_fail, 'reds', reds);
END
$drv$;
