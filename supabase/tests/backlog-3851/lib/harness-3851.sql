-- BACKLOG-3851 harness helpers, loaded after the 3917 helpers (pg_temp.id, as_user,
-- as_role, check, refused, set_status, t3917_r). Adds the 3851 fixture names to the
-- {name} substitution list.
CREATE OR REPLACE FUNCTION pg_temp.id_names() RETURNS SETOF text LANGUAGE sql IMMUTABLE AS $f$
  SELECT unnest(ARRAY['org1','org2','org_p','org_p2','plan','u_s','u_a','u_g','u_gs','u_ts','u_ta','u_p','u_ps',
                      'm_s','m_a','m_g','m_gs','m_ts','m_ta','m_p','m_ps','m_s2','m_gs2','scl','scl_item','sub','sub_p','tpl_org','tpl_own_p','tpl_own_s',
                      'idp','tok','log','att','msg','new_sub',
                      'u_i','arole','tk','bl','bl2','lnk','u_g2','m_g2','u_sa','srole','u_x','pinv','lnk2',
    -- 3851
    'f_org','o_org','w_org','x_org','m2_org','pp_org',
    'u_fad','u_fbr','u_fit','u_fil','u_fsus','u_fun',
    'f_ad','f_br','f_it','f_il','f_ie','f_sus','f_un',
    'u_oad','u_obr','u_oit','u_oag','u_osad','u_ounc','u_otact','u_otun','u_otsus','u_otexp','u_otit','u_otbr','u_otunit',
    'o_ad','o_br','o_it','o_ag','o_sad','o_unc','o_tact','o_tun','o_tpen','o_tsus','o_texp','o_tit','o_tbr','o_tunit',
    'u_w1','u_w2','w_i1','w_i2',
    'u_xad','x_ad','x_ie',
    'u_m1','u_m2','m2_a1','m2_a2',
    'u_pp','pp_m','u_x1','u_x2','u_x3','u_x4','u_n','u_st','strole','w2_org','w2_i1','w2_s','u_w3','u_w4','r_org']) $f$;

CREATE FUNCTION pg_temp.tid(p_name text) RETURNS text LANGUAGE sql IMMUTABLE AS $f$
  SELECT md5('backlog-3851-tenant:' || p_name)::uuid::text $f$;

-- A user with auth.users + public.users rows; email '<name>-3917@example.test' (the
-- address pg_temp.as_role puts in the JWT).
CREATE FUNCTION pg_temp.mk_user3851(p_user text) RETURNS void LANGUAGE sql AS $f$
  INSERT INTO auth.users (id, email, aud, role, raw_user_meta_data, raw_app_meta_data)
  VALUES (pg_temp.id(p_user), p_user || '-3917@example.test', 'authenticated', 'authenticated', '{}'::jsonb,
          '{"provider":"azure","providers":["azure"]}'::jsonb);
  INSERT INTO public.users (id, email, oauth_provider, oauth_id)
  VALUES (pg_temp.id(p_user), p_user || '-3917@example.test', 'azure', 'oauth-3851-' || p_user);
$f$;
-- An azure identity for tenant p_tenant (auto_provision_it_admin reads auth.identities).
CREATE FUNCTION pg_temp.mk_azure3851(p_user text, p_tenant text) RETURNS void LANGUAGE sql AS $f$
  INSERT INTO auth.identities (provider_id, user_id, identity_data, provider, last_sign_in_at, created_at, updated_at)
  VALUES ('sub-3851-' || p_user, pg_temp.id(p_user),
          jsonb_build_object('sub', 'sub-3851-' || p_user, 'email', p_user || '-3917@example.test',
                             'custom_claims', jsonb_build_object('tid', pg_temp.tid(p_tenant))),
          'azure', now(), now(), now());
$f$;

-- Seats used in an organization, counted with the plan's rule (independent of the
-- migration's helper, so a wrong helper cannot make this agree with itself).
CREATE FUNCTION pg_temp.seats(p_org text) RETURNS integer LANGUAGE sql AS $f$
  SELECT count(*)::int FROM public.organization_members m
   WHERE m.organization_id = pg_temp.id(p_org)
     AND (m.license_status = 'active'
          OR (m.license_status = 'pending' AND (m.user_id IS NOT NULL OR m.invitation_expires_at IS NULL OR m.invitation_expires_at >= now()))) $f$;
CREATE FUNCTION pg_temp.status(p_member text) RETURNS text LANGUAGE sql AS $f$
  SELECT license_status FROM public.organization_members WHERE id = pg_temp.id(p_member) $f$;
-- set_member_license as user p_user; returns the jsonb's error (or 'success') or ERR <state>.
CREATE FUNCTION pg_temp.sml(p_user text, p_member text, p_action text) RETURNS text LANGUAGE sql AS $f$
  SELECT pg_temp.as_user(p_user,
    format('select (public.set_member_license(%L::uuid, %L) ->> ''error'')', pg_temp.id(p_member), p_action)) $f$;
-- Same, but keeps the change (runs as the user inside the control's transaction).
CREATE FUNCTION pg_temp.sml_keep(p_user text, p_member text, p_action text) RETURNS jsonb LANGUAGE plpgsql AS $f$
DECLARE r jsonb; BEGIN
  PERFORM set_config('request.jwt.claims', json_build_object('sub', pg_temp.id(p_user), 'role', 'authenticated')::text, true);
  PERFORM set_config('role', 'authenticated', true);
  r := public.set_member_license(pg_temp.id(p_member), p_action);
  PERFORM set_config('role', 'postgres', true);
  PERFORM set_config('request.jwt.claims', '', true);
  RETURN r;
END $f$;
-- auto_provision_it_admin as user p_user for tenant p_tenant, kept.
CREATE FUNCTION pg_temp.provision3851(p_user text, p_tenant text) RETURNS jsonb LANGUAGE plpgsql AS $f$
DECLARE r jsonb; BEGIN
  PERFORM set_config('request.jwt.claims', json_build_object('sub', pg_temp.id(p_user), 'role', 'authenticated')::text, true);
  PERFORM set_config('role', 'authenticated', true);
  r := public.auto_provision_it_admin(pg_temp.tid(p_tenant), 'Happyhomey Test 3851', 'happyhomey-test-3851');
  PERFORM set_config('role', 'postgres', true);
  PERFORM set_config('request.jwt.claims', '', true);
  RETURN r;
END $f$;
-- Run p_sql as service_role (no JWT user); 'OK rows=N' / 'ERR <state> <msg>'; rolled back.
CREATE FUNCTION pg_temp.as_service(p_sql text) RETURNS text LANGUAGE sql AS $f$
  SELECT pg_temp.as_role('service_role', NULL, p_sql) $f$;
-- Run p_sql as postgres; result string; rolled back.
CREATE FUNCTION pg_temp.as_pg(p_sql text) RETURNS text LANGUAGE plpgsql AS $f$
DECLARE n int; msg text; st text; BEGIN
  p_sql := pg_temp.subst(p_sql);
  BEGIN
    EXECUTE p_sql; GET DIAGNOSTICS n = ROW_COUNT; msg := 'OK rows=' || n;
    RAISE EXCEPTION 't3851_undo' USING DETAIL = msg;
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM = 't3851_undo' THEN GET STACKED DIAGNOSTICS msg = PG_EXCEPTION_DETAIL;
    ELSE GET STACKED DIAGNOSTICS st = RETURNED_SQLSTATE; msg := 'ERR ' || st || ' ' || SQLERRM; END IF;
  END;
  RETURN pg_temp.unsubst(msg);
END $f$;

-- Run p_sql as p_role (JWT sub p_user, or none) and KEEP the effect. Returns 'OK rows=N',
-- 'OK <value>' (select) or 'ERR <state> <msg>' (the failed statement alone is undone).
CREATE FUNCTION pg_temp.keep(p_role text, p_user text, p_sql text) RETURNS text LANGUAGE plpgsql AS $f$
DECLARE n int; msg text; st text; BEGIN
  p_sql := pg_temp.subst(p_sql);
  BEGIN
    IF p_user IS NOT NULL THEN
      PERFORM set_config('request.jwt.claims', json_build_object('sub', pg_temp.id(p_user), 'role', p_role,
        'email', p_user || '-3917@example.test')::text, true);
    ELSE
      PERFORM set_config('request.jwt.claims', json_build_object('role', p_role)::text, true);
    END IF;
    IF p_role <> 'postgres' THEN PERFORM set_config('role', p_role, true); END IF;
    IF p_sql ILIKE 'select%' THEN
      EXECUTE 'select (' || substr(p_sql, 8) || ')::text' INTO msg; msg := 'OK ' || coalesce(msg, '<null>');
    ELSE
      EXECUTE p_sql; GET DIAGNOSTICS n = ROW_COUNT; msg := 'OK rows=' || n;
    END IF;
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS st = RETURNED_SQLSTATE; msg := 'ERR ' || st || ' ' || SQLERRM;
  END;
  PERFORM set_config('role', 'postgres', true);
  PERFORM set_config('request.jwt.claims', '', true);
  RETURN pg_temp.unsubst(msg);
END $f$;
-- The client invite INSERT broker-portal inviteUser.ts makes, as admin p_admin.
CREATE FUNCTION pg_temp.client_invite_sql(p_admin text, p_org text, p_email text) RETURNS text LANGUAGE sql AS $f$
  SELECT format('insert into public.organization_members (organization_id, invited_email, role, license_status, invitation_token, invitation_expires_at, invited_by, invited_at, provisioned_by) values (%L, %L, %L, %L, %L, now() + interval ''7 days'', %L, now(), %L)',
    pg_temp.id(p_org), p_email, 'agent', 'pending', 'tok-' || p_email, pg_temp.id(p_admin), 'invite') $f$;
-- The Resend UPDATE (broker-portal resendInvite.ts): new token and expiry only.
CREATE FUNCTION pg_temp.resend_sql(p_member text) RETURNS text LANGUAGE sql AS $f$
  SELECT format('update public.organization_members set invitation_token = %L, invitation_expires_at = now() + interval ''7 days'' where id = %L',
    'tok-resend-' || p_member, pg_temp.id(p_member)) $f$;
