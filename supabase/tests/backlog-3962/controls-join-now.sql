-- BACKLOG-3962 "Join now" (20261112114500) DB tests and controls.
-- Venue: keepr-test via ~/.claude/bin/kt-sql. ONE call, one implicit transaction that always ends
-- in RAISE, so nothing persists. compose.py prepends the migration (or a mutant of it).
-- Own fixtures (keys bl3962j:, domain j-3962j.test); nothing outside them is read or written.
-- Output: RAISE 'P3962_RESULT {"mode":..., "pass":n, "fail":n, "reds":{case: got}}'.

CREATE FUNCTION pg_temp.id(t text) RETURNS uuid LANGUAGE sql IMMUTABLE AS $b$ SELECT md5('bl3962j:' || t)::uuid $b$;

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

-- join now as the server role, for switch s, session user u
CREATE FUNCTION pg_temp.jn(s uuid, u uuid) RETURNS text LANGUAGE sql AS $b$
  SELECT pg_temp.q(NULL, 'service_role', format('SELECT public._domain_capture_join_now(%L::uuid, %L::uuid)::text', s, u))
$b$;
CREATE FUNCTION pg_temp.sid(u uuid) RETURNS uuid LANGUAGE sql AS $b$
  SELECT id FROM public.domain_capture_switches WHERE user_id = u ORDER BY created_at DESC, id LIMIT 1 $b$;
-- status:reason:switch_at-offset-in-days:last_defer_reason
CREATE FUNCTION pg_temp.st(u uuid) RETURNS text LANGUAGE sql AS $b$
  SELECT status || ':' || coalesce(reason, '-') || ':' || extract(day FROM (switch_at - now()))::int || ':' || coalesce(last_defer_reason, '-')
    FROM public.domain_capture_switches WHERE user_id = u ORDER BY created_at DESC, id LIMIT 1 $b$;
CREATE FUNCTION pg_temp.members(o uuid, u uuid) RETURNS int LANGUAGE sql AS $b$
  SELECT count(*)::int FROM public.organization_members WHERE organization_id = o AND user_id = u $b$;

-- Fixtures ----------------------------------------------------------------------------------
-- Brokerage J (domain j-3962j.test, verified claim with a fresh verified DNS answer).
-- Personal accounts p_j1..p_j7, each with one scheduled move 10 days out, notice delivered
-- (p_j7: notice still queued, notice_delivered NULL). p_j3 carries last_defer_reason
-- billing_not_ready from an earlier hourly run, so a dropped restore is visible.
CREATE TEMP TABLE fxj (k text, e text) ON COMMIT DROP;
INSERT INTO fxj VALUES
  ('u_admJ', 'admj@corp-3962j.test'),
  ('p_j1', 'j1@j-3962j.test'), ('p_j2', 'j2@j-3962j.test'), ('p_j3', 'j3@j-3962j.test'),
  ('p_j4', 'j4@j-3962j.test'), ('p_j5', 'j5@j-3962j.test'), ('p_j7', 'j7@j-3962j.test');

INSERT INTO auth.users (id, email, instance_id, aud, role, email_confirmed_at)
  SELECT pg_temp.id(k), e, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', now() FROM fxj;
INSERT INTO public.users (id, email, oauth_provider, oauth_id)
  SELECT pg_temp.id(k), e, 'google', k || '3962j' FROM fxj ON CONFLICT DO NOTHING;
INSERT INTO auth.identities (provider_id, user_id, identity_data, provider)
  SELECT k || '-pid-3962j', pg_temp.id(k), jsonb_build_object('sub', pg_temp.id(k), 'email', e), 'email' FROM fxj;

INSERT INTO public.organizations (id, name, slug, is_test, max_seats, microsoft_tenant_id)
  VALUES (pg_temp.id('oJ'), 'Capture J 3962', 'cap-j-3962j', true, 10, NULL);
INSERT INTO public.organizations (id, name, slug, is_test, max_seats, personal_owner_user_id)
  SELECT pg_temp.id('po_' || k), 'Personal', 'po-' || replace(k, '_', '-') || '-3962j', true, 1, pg_temp.id(k)
    FROM fxj WHERE k LIKE 'p\_%';
INSERT INTO public.organization_members (organization_id, user_id, role, license_status)
  SELECT pg_temp.id('po_' || k), pg_temp.id(k), 'admin', 'active' FROM fxj WHERE k LIKE 'p\_%';
INSERT INTO public.organization_members (organization_id, user_id, role, license_status)
  VALUES (pg_temp.id('oJ'), pg_temp.id('u_admJ'), 'admin', 'active');

INSERT INTO public.domain_claims (id, organization_id, domain, token, status, verified_at, last_checked_at, last_check_result)
  VALUES (pg_temp.id('cJ'), pg_temp.id('oJ'), 'j-3962j.test',
          'keepr-domain-verification=' || substr(md5('t3962j') || md5('u3962j'), 1, 48),
          'verified', now() - interval '20 days', now(), 'verified');

INSERT INTO public.domain_capture_switches
  (organization_id, claim_id, user_id, email_at_start, attestation, status, notice_sent_at, notice_delivered,
   switch_at, started_by, last_defer_reason)
  SELECT pg_temp.id('oJ'), pg_temp.id('cJ'), pg_temp.id(k), e, 'email_confirmed', 'scheduled', now(),
         CASE WHEN k = 'p_j7' THEN NULL ELSE true END,
         now() + interval '10 days', pg_temp.id('u_admJ'),
         CASE WHEN k = 'p_j3' THEN 'billing_not_ready' ELSE NULL END
    FROM fxj WHERE k LIKE 'p\_%';

-- __MODE__

DO $drv$
DECLARE
  oJ uuid := pg_temp.id('oJ'); cJ uuid := pg_temp.id('cJ');
  pJ1 uuid := pg_temp.id('p_j1'); pJ2 uuid := pg_temp.id('p_j2'); pJ3 uuid := pg_temp.id('p_j3');
  pJ4 uuid := pg_temp.id('p_j4'); pJ5 uuid := pg_temp.id('p_j5'); pJ7 uuid := pg_temp.id('p_j7');
  g text; j jsonb; orig timestamptz;
  v_pass int := 0; v_fail int := 0; reds jsonb := '{}'::jsonb; k record;
BEGIN
  CREATE TEMP TABLE rj (k text, ok boolean, got text) ON COMMIT DROP;

  -- ---- J6 grants and the role check ------------------------------------------------------------
  INSERT INTO rj VALUES ('J6a_no_execute_authenticated_anon',
    NOT has_function_privilege('authenticated', 'public._domain_capture_join_now(uuid, uuid)', 'EXECUTE')
      AND NOT has_function_privilege('anon', 'public._domain_capture_join_now(uuid, uuid)', 'EXECUTE')
      AND has_function_privilege('service_role', 'public._domain_capture_join_now(uuid, uuid)', 'EXECUTE'), '');
  g := pg_temp.q(pJ1, 'authenticated', format('SELECT public._domain_capture_join_now(%L::uuid, %L::uuid)::text', pg_temp.sid(pJ1), pJ1));
  INSERT INTO rj VALUES ('J6b_authenticated_call_refused', g LIKE 'ERR 42501%' AND pg_temp.st(pJ1) = 'scheduled:-:10:-', g);
  g := pg_temp.q(NULL, 'anon', format('SELECT public._domain_capture_join_now(%L::uuid, %L::uuid)::text', pg_temp.sid(pJ1), pJ1));
  INSERT INTO rj VALUES ('J6c_anon_call_refused', g LIKE 'ERR 42501%', g);
  -- the role check inside holds on its own: granted for this one call (rolled back with the rest),
  -- a client call with a wrong user still raises 42501, not a switch_not_found reply.
  GRANT EXECUTE ON FUNCTION public._domain_capture_join_now(uuid, uuid) TO authenticated;
  g := pg_temp.q(pJ1, 'authenticated', format('SELECT public._domain_capture_join_now(%L::uuid, %L::uuid)::text', pg_temp.sid(pJ2), pJ1));
  REVOKE EXECUTE ON FUNCTION public._domain_capture_join_now(uuid, uuid) FROM authenticated;
  INSERT INTO rj VALUES ('J6d_role_check_inside', g LIKE 'ERR 42501%', g);

  -- ---- J2 another person's switch ---------------------------------------------------------------
  g := pg_temp.jn(pg_temp.sid(pJ2), pJ1);
  INSERT INTO rj VALUES ('J2_other_users_switch_not_found',
    g LIKE '%switch_not_found%' AND pg_temp.st(pJ2) = 'scheduled:-:10:-' AND pg_temp.members(oJ, pJ2) = 0
      AND pg_temp.members(oJ, pJ1) = 0, g);
  g := pg_temp.jn(pg_temp.sid(pJ2), NULL);
  INSERT INTO rj VALUES ('J2b_null_user_not_found', g LIKE '%switch_not_found%' AND pg_temp.st(pJ2) = 'scheduled:-:10:-', g);

  -- ---- J3 stale DNS: deferred, nothing changes, the person can still opt out --------------------
  UPDATE public.domain_claims SET last_checked_at = now() - interval '2 hours' WHERE id = cJ;
  g := pg_temp.jn(pg_temp.sid(pJ3), pJ3);
  INSERT INTO rj VALUES ('J3a_stale_dns_deferred_unchanged',
    g LIKE '%dns_not_fresh%' AND pg_temp.st(pJ3) = 'scheduled:-:10:billing_not_ready' AND pg_temp.members(oJ, pJ3) = 0,
    g || ' | ' || pg_temp.st(pJ3));
  INSERT INTO rj VALUES ('J3b_not_due_for_hourly_job',
    NOT EXISTS (SELECT 1 FROM public.domain_capture_switches WHERE user_id = pJ3 AND status = 'scheduled' AND switch_at <= now()), '');
  g := pg_temp.q(pJ3, 'authenticated', format('SELECT public.domain_capture_opt_out_self(%L::uuid)::text', pg_temp.sid(pJ3)));
  INSERT INTO rj VALUES ('J3c_opt_out_still_succeeds', g LIKE '%"success": true%' AND pg_temp.st(pJ3) LIKE 'opted_out:opted_out:%', g);
  UPDATE public.domain_claims SET last_checked_at = now() WHERE id = cJ;

  -- ---- J4 billing deferrals ---------------------------------------------------------------------
  ALTER FUNCTION public._billing_enqueue_agent_cancel_on_join(uuid, uuid, uuid) RENAME TO _bl3962j_tmp;
  g := pg_temp.jn(pg_temp.sid(pJ4), pJ4);
  ALTER FUNCTION public._bl3962j_tmp(uuid, uuid, uuid) RENAME TO _billing_enqueue_agent_cancel_on_join;
  INSERT INTO rj VALUES ('J4a_billing_not_ready_unchanged',
    (CASE WHEN g LIKE '{%' THEN (g::jsonb) ->> 'error' END) = 'billing_not_ready'
      AND pg_temp.st(pJ4) = 'scheduled:-:10:-' AND pg_temp.members(oJ, pJ4) = 0, g || ' | ' || pg_temp.st(pJ4));

  INSERT INTO public.org_deals (organization_id, stripe_mode, seats, status) VALUES (oJ, 'test', 5, 'draft');
  INSERT INTO public.org_deal_lines (organization_id, item_key, quantity_rule, unit_price_cents)
    VALUES (oJ, 'brokerage_seat', 'seats', 5000);
  g := pg_temp.jn(pg_temp.sid(pJ4), pJ4);
  INSERT INTO rj VALUES ('J4b_billing_setup_incomplete_unchanged',
    (CASE WHEN g LIKE '{%' THEN (g::jsonb) ->> 'error' END) = 'billing_setup_incomplete'
      AND pg_temp.st(pJ4) = 'scheduled:-:10:-' AND pg_temp.members(oJ, pJ4) = 0, g || ' | ' || pg_temp.st(pJ4));
  DELETE FROM public.org_deals WHERE organization_id = oJ;

  -- ---- J1 owner + fresh DNS: switched now -------------------------------------------------------
  orig := (SELECT switch_at FROM public.domain_capture_switches WHERE id = pg_temp.sid(pJ1));
  g := pg_temp.jn(pg_temp.sid(pJ1), pJ1);
  j := CASE WHEN g LIKE '{%' THEN g::jsonb ELSE '{}'::jsonb END;
  INSERT INTO rj VALUES ('J1a_switched_now',
    j ->> 'outcome' = 'switched' AND j ->> 'joined_early' = 'true' AND pg_temp.members(oJ, pJ1) = 1
      AND (SELECT provisioned_by FROM public.organization_members WHERE organization_id = oJ AND user_id = pJ1) = 'domain_capture', g);
  INSERT INTO rj VALUES ('J1b_joined_early_recorded_switch_at_kept',
    (SELECT status = 'switched' AND joined_early_at = now() AND switched_at = now() AND switch_at = orig
       FROM public.domain_capture_switches WHERE id = pg_temp.sid(pJ1)) IS TRUE, pg_temp.st(pJ1));
  g := pg_temp.jn(pg_temp.sid(pJ1), pJ1);
  INSERT INTO rj VALUES ('J1c_second_join_not_scheduled', g LIKE '%not_scheduled%' AND g LIKE '%switched%'
    AND pg_temp.members(oJ, pJ1) = 1, g);

  -- ---- J5 no longer eligible: cancelled, switch_at kept -----------------------------------------
  orig := (SELECT switch_at FROM public.domain_capture_switches WHERE id = pg_temp.sid(pJ5));
  UPDATE auth.users SET email = 'j5@elsewhere-3962j.test' WHERE id = pJ5;
  g := pg_temp.jn(pg_temp.sid(pJ5), pJ5);
  INSERT INTO rj VALUES ('J5_ineligible_cancelled_switch_at_original',
    g LIKE '%"outcome": "cancelled"%' AND g LIKE '%not_eligible%' AND pg_temp.members(oJ, pJ5) = 0
      AND (SELECT status || ':' || reason || ':' || (switch_at = orig)::text || ':' || (joined_early_at IS NULL)::text
             FROM public.domain_capture_switches WHERE id = pg_temp.sid(pJ5)) = 'cancelled:not_eligible:true:true',
    g || ' | ' || pg_temp.st(pJ5));

  -- ---- J7 a notice still queued: joining in the portal counts as delivered ----------------------
  g := pg_temp.jn(pg_temp.sid(pJ7), pJ7);
  INSERT INTO rj VALUES ('J7_queued_notice_joins_not_cancelled',
    g LIKE '%"outcome": "switched"%' AND pg_temp.members(oJ, pJ7) = 1
      AND (SELECT notice_delivered FROM public.domain_capture_switches WHERE id = pg_temp.sid(pJ7)) IS TRUE,
    g || ' | ' || pg_temp.st(pJ7));

  FOR k IN SELECT * FROM rj ORDER BY 1 LOOP
    IF k.ok IS TRUE THEN v_pass := v_pass + 1;
    ELSE v_fail := v_fail + 1; reds := reds || jsonb_build_object(k.k, left(coalesce(k.got, 'null'), 300));
    END IF;
  END LOOP;
  RAISE EXCEPTION 'P3962_RESULT %', jsonb_build_object('mode', current_setting('p3962.mode', true),
    'pass', v_pass, 'fail', v_fail, 'reds', reds);
END
$drv$;
