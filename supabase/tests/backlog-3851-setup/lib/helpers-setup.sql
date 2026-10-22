-- BACKLOG-3851 setup harness helpers (after the 3851 prelude and M1; before the new
-- migration, so the same helpers run against today's body and the new one).

-- auto_provision_it_admin as p_user (role authenticated, JWT sub + email), tenant
-- pg_temp.tid(p_tenant) (or p_raw_tenant verbatim). Kept. Returns the function's jsonb,
-- or {sqlstate, msg} when it raised.
CREATE FUNCTION pg_temp.prov(p_user text, p_tenant text, p_raw_tenant text DEFAULT NULL) RETURNS jsonb LANGUAGE plpgsql AS $f$
DECLARE r jsonb; st text; msg text; BEGIN
  PERFORM set_config('request.jwt.claims', json_build_object('sub', pg_temp.id(p_user), 'role', 'authenticated',
    'email', p_user || '-3917@example.test')::text, true);
  PERFORM set_config('role', 'authenticated', true);
  BEGIN
    r := public.auto_provision_it_admin(coalesce(p_raw_tenant, pg_temp.tid(p_tenant)), 'Probe 3851 setup', 'probe-3851-setup');
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS st = RETURNED_SQLSTATE; msg := SQLERRM;
    r := jsonb_build_object('sqlstate', st, 'msg', msg);
  END;
  PERFORM set_config('role', 'postgres', true);
  PERFORM set_config('request.jwt.claims', '', true);
  RETURN r;
END $f$;

-- 'success' | the error code | 'ERR <sqlstate>'.
CREATE FUNCTION pg_temp.outcome(r jsonb) RETURNS text LANGUAGE sql IMMUTABLE AS $f$
  SELECT CASE WHEN r ? 'sqlstate' THEN 'ERR ' || (r->>'sqlstate')
              WHEN (r->>'success')::boolean THEN 'success'
              ELSE coalesce(r->>'error', '<none>') END $f$;

-- An auth.users row only (no public.users row): a first-time caller.
CREATE FUNCTION pg_temp.mk_auth_only(p_user text, p_email text, p_meta jsonb DEFAULT '{}'::jsonb) RETURNS void LANGUAGE sql AS $f$
  INSERT INTO auth.users (id, email, aud, role, raw_user_meta_data, raw_app_meta_data)
  VALUES (pg_temp.id(p_user), p_email, 'authenticated', 'authenticated', p_meta,
          '{"provider":"azure","providers":["azure"]}'::jsonb) $f$;

-- A brokerage (no personal owner) with tenant p_tenant (NULL = none).
CREATE FUNCTION pg_temp.mk_org(p_org text, p_tenant text, p_max integer DEFAULT 10) RETURNS void LANGUAGE sql AS $f$
  INSERT INTO public.organizations (id, name, slug, max_seats, microsoft_tenant_id)
  VALUES (pg_temp.id(p_org), 'Happyhomey Test 3851 setup ' || p_org, 'happyhomey-test-3851-setup-' || replace(p_org, '_', '-'), p_max, p_tenant) $f$;

-- An unclaimed invite row shaped like inviteUser.ts / admin_invite_user (as postgres).
CREATE FUNCTION pg_temp.mk_invite(p_id text, p_org text, p_email text, p_role text,
                                  p_expires timestamptz DEFAULT now() + interval '3 days') RETURNS void LANGUAGE sql AS $f$
  INSERT INTO public.organization_members (id, organization_id, invited_email, role, license_status, invitation_token,
                                           invitation_expires_at, invited_at, provisioned_by)
  VALUES (pg_temp.id(p_id), pg_temp.id(p_org), p_email, p_role, 'pending', 'tok-3851-setup-' || p_id, p_expires, now(), 'invite') $f$;

-- A claimed member row (as postgres).
CREATE FUNCTION pg_temp.mk_member(p_id text, p_org text, p_user text, p_role text, p_status text) RETURNS void LANGUAGE sql AS $f$
  INSERT INTO public.organization_members (id, organization_id, user_id, role, license_status, provisioned_by, joined_at)
  VALUES (pg_temp.id(p_id), pg_temp.id(p_org), pg_temp.id(p_user), p_role, p_status, 'invite', now()) $f$;

-- One-line state of a member row: user|status|token-null|provisioned_by.
CREATE FUNCTION pg_temp.row_state(p_id text) RETURNS text LANGUAGE sql AS $f$
  SELECT coalesce(user_id::text, '<null>') || '|' || coalesce(license_status, '<null>') || '|'
         || (invitation_token IS NULL)::text || '|' || coalesce(provisioned_by, '<null>')
    FROM public.organization_members WHERE id = pg_temp.id(p_id) $f$;
CREATE FUNCTION pg_temp.org_tenant(p_org text) RETURNS text LANGUAGE sql AS $f$
  SELECT coalesce(microsoft_tenant_id, '<null>') FROM public.organizations WHERE id = pg_temp.id(p_org) $f$;
CREATE FUNCTION pg_temp.orgs_for(p_tenant text) RETURNS integer LANGUAGE sql AS $f$
  SELECT count(*)::int FROM public.organizations WHERE lower(microsoft_tenant_id) = pg_temp.tid(p_tenant) $f$;
CREATE FUNCTION pg_temp.member_rows(p_user text) RETURNS integer LANGUAGE sql AS $f$
  SELECT count(*)::int FROM public.organization_members WHERE user_id = pg_temp.id(p_user) $f$;

CREATE TEMP TABLE t3851s_orgs0 AS SELECT count(*)::int AS n FROM public.organizations;
SELECT 'HELPERSSETUP OK';
