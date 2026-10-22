-- BACKLOG-3684 harness helpers (after the stack under test; the 3851 and 3851-setup
-- helpers are already loaded: pg_temp.id, tid, keep, check, mk_org, mk_invite,
-- mk_member, mk_auth_only, mk_azure3851, row_state, org_tenant, member_rows).

-- accept_invitation as p_user (role authenticated, JWT sub + email). Returns the jsonb,
-- or {sqlstate, msg} when it raised.
CREATE FUNCTION pg_temp.acc(p_user text, p_token text, p_tenant text DEFAULT NULL, p_raw_tenant text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql AS $f$
DECLARE r jsonb; st text; msg text; BEGIN
  PERFORM set_config('request.jwt.claims', json_build_object('sub', pg_temp.id(p_user), 'role', 'authenticated',
    'email', p_user || '-3917@example.test')::text, true);
  PERFORM set_config('role', 'authenticated', true);
  BEGIN
    IF p_tenant IS NULL AND p_raw_tenant IS NULL THEN
      r := public.accept_invitation(p_token);
    ELSE
      r := public.accept_invitation(p_token, coalesce(p_raw_tenant, pg_temp.tid(p_tenant)));
    END IF;
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS st = RETURNED_SQLSTATE; msg := SQLERRM;
    r := jsonb_build_object('sqlstate', st, 'msg', msg);
  END;
  PERFORM set_config('role', 'postgres', true);
  PERFORM set_config('request.jwt.claims', '', true);
  RETURN r;
END $f$;

-- caller_has_pending_invite() as p_user: 'true' | 'false' | 'ERR <sqlstate>'.
CREATE FUNCTION pg_temp.det(p_user text) RETURNS text LANGUAGE plpgsql AS $f$
DECLARE v boolean; st text; out text; BEGIN
  PERFORM set_config('request.jwt.claims', json_build_object('sub', pg_temp.id(p_user), 'role', 'authenticated',
    'email', p_user || '-3917@example.test')::text, true);
  PERFORM set_config('role', 'authenticated', true);
  BEGIN
    v := public.caller_has_pending_invite(); out := v::text;
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS st = RETURNED_SQLSTATE; out := 'ERR ' || st;
  END;
  PERFORM set_config('role', 'postgres', true);
  PERFORM set_config('request.jwt.claims', '', true);
  RETURN out;
END $f$;

-- The token pg_temp.mk_invite writes for invite p_id.
CREATE FUNCTION pg_temp.tok(p_id text) RETURNS text LANGUAGE sql IMMUTABLE AS $f$
  SELECT 'tok-3851-setup-' || p_id $f$;

-- A personal organization owned by p_user, with p_user's owner membership (as postgres).
CREATE FUNCTION pg_temp.mk_personal(p_org text, p_user text) RETURNS void LANGUAGE sql AS $f$
  INSERT INTO public.organizations (id, name, slug, max_seats, personal_owner_user_id)
  VALUES (pg_temp.id(p_org), 'Happyhomey Test 3684 personal ' || p_org, 'happyhomey-test-3684-' || replace(p_org, '_', '-'), 1, pg_temp.id(p_user));
  INSERT INTO public.organization_members (id, organization_id, user_id, role, license_status, provisioned_by, joined_at)
  VALUES (pg_temp.id('pm_' || p_org), pg_temp.id(p_org), pg_temp.id(p_user), 'agent', 'active', 'invite', now());
$f$;

SELECT 'HELPERS3684 OK';
