-- BACKLOG-3976 (20261110130000): DB tests and controls for admin_update_org_member_role.
-- Venue: keepr-test, ONE kt-sql call, ONE transaction ending in RAISE, so nothing persists.
-- compose.py prepends the migration (--with-migration) and the mode's mutation.
-- Mutations are exact-once text replacements on the live function body; md5(prosrc) must change,
-- else 'MUTATION NOT APPLIED' (BACKLOG-2645, PR-SOP 4.4).
-- Output: RAISE 'P3976_RESULT {"mode":..., "mutation":..., "pass":n, "fail":n, "reds":{case:got}}'.

CREATE FUNCTION pg_temp.id(t text) RETURNS uuid LANGUAGE sql IMMUTABLE AS $b$ SELECT md5('bl3976:' || t)::uuid $b$;

CREATE FUNCTION pg_temp.as_user(u uuid, r text) RETURNS void LANGUAGE plpgsql AS $b$
BEGIN
  PERFORM set_config('request.jwt.claims', json_build_object('sub', u, 'role', r)::text, true);
  PERFORM set_config('request.jwt.claim.sub', coalesce(u::text, ''), true);
  PERFORM set_config('request.jwt.claim.role', r, true);
END $b$;

-- call the RPC as u with database role r: the jsonb text, or 'ERR <sqlstate> <message>'
CREATE FUNCTION pg_temp.call_as(u uuid, r text, o uuid, t uuid, nr text) RETURNS text LANGUAGE plpgsql AS $b$
DECLARE v jsonb;
BEGIN
  BEGIN
    PERFORM pg_temp.as_user(u, r);
    EXECUTE format('SET LOCAL ROLE %I', r);
    EXECUTE 'SELECT public.admin_update_org_member_role($1, $2, $3)' INTO v USING o, t, nr;
    EXECUTE 'RESET ROLE';
    RETURN coalesce(v::text, 'null');
  EXCEPTION WHEN OTHERS THEN
    EXECUTE 'RESET ROLE';
    RETURN 'ERR ' || SQLSTATE || ' ' || left(SQLERRM, 80);
  END;
END $b$;

-- exact-once replace inside one function's definition; md5(prosrc) must change
CREATE FUNCTION pg_temp.mutate(fn regprocedure, a text, b text) RETURNS void LANGUAGE plpgsql AS $b$
DECLARE d text; n int; before text; after text;
BEGIN
  SELECT pg_get_functiondef(fn), md5(prosrc) INTO d, before FROM pg_proc WHERE oid = fn;
  n := (length(d) - length(replace(d, a, ''))) / length(a);
  IF n <> 1 THEN RAISE EXCEPTION 'MUTATION NOT APPLIED: % matched % times', fn, n; END IF;
  EXECUTE replace(d, a, b);
  SELECT md5(prosrc) INTO after FROM pg_proc WHERE oid = fn;
  IF after = before THEN RAISE EXCEPTION 'MUTATION NOT APPLIED: % body unchanged', fn; END IF;
  RAISE NOTICE 'MUTATION APPLIED % : %', fn, b;
END $b$;

-- compose.py replaces the next line with the mode's pg_temp.mutate calls.
-- __MUTATION__

-- Fixtures. Staff u_s holds users.edit; staff u_n is internal with a role that lacks it.
INSERT INTO auth.users (id, email, aud, role) SELECT pg_temp.id(k), k || '-3976@example.test', 'authenticated', 'authenticated'
  FROM unnest(ARRAY['u_s','u_n','u_a1','u_a2','u_a3','u_b1','u_b2','u_c1','u_c2']) k;
INSERT INTO public.users (id, email, oauth_provider, oauth_id) SELECT pg_temp.id(k), k || '-3976@example.test', 'google', k || '3976'
  FROM unnest(ARRAY['u_s','u_n','u_a1','u_a2','u_a3','u_b1','u_b2','u_c1','u_c2']) k
  ON CONFLICT DO NOTHING;  -- an auth.users trigger may already have created the row
INSERT INTO public.admin_roles (id, name, slug) VALUES
  (pg_temp.id('role_edit'), 'role edit 3976', 'role-edit-3976'),
  (pg_temp.id('role_view'), 'role view 3976', 'role-view-3976');
INSERT INTO public.admin_role_permissions (role_id, permission_id)
  SELECT pg_temp.id('role_edit'), id FROM public.admin_permissions WHERE key IN ('users.edit', 'users.view');
INSERT INTO public.admin_role_permissions (role_id, permission_id)
  SELECT pg_temp.id('role_view'), id FROM public.admin_permissions WHERE key = 'users.view';
INSERT INTO public.internal_roles (user_id, role_id) VALUES
  (pg_temp.id('u_s'), pg_temp.id('role_edit')),
  (pg_temp.id('u_n'), pg_temp.id('role_view'));
INSERT INTO public.organizations (id, name, slug) VALUES
  (pg_temp.id('o1'), 'Org One 3976', 'org-one-3976'),
  (pg_temp.id('o2'), 'Org Two 3976', 'org-two-3976'),
  (pg_temp.id('o3'), 'Org Three 3976', 'org-three-3976');
-- O1: two active admins, an agent, a pending invite. O2: ONE active admin (non-personal) + an agent.
-- O3: identity provider with group sync; u_c2 was provisioned by SCIM.
INSERT INTO public.organization_members (id, organization_id, user_id, role, license_status, provisioned_by) VALUES
  (pg_temp.id('m_a1'), pg_temp.id('o1'), pg_temp.id('u_a1'), 'admin', 'active', 'manual'),
  (pg_temp.id('m_a2'), pg_temp.id('o1'), pg_temp.id('u_a2'), 'agent', 'active', 'manual'),
  (pg_temp.id('m_a3'), pg_temp.id('o1'), pg_temp.id('u_a3'), 'admin', 'active', 'manual'),
  (pg_temp.id('m_b1'), pg_temp.id('o2'), pg_temp.id('u_b1'), 'admin', 'active', 'manual'),
  (pg_temp.id('m_b2'), pg_temp.id('o2'), pg_temp.id('u_b2'), 'agent', 'active', 'manual'),
  (pg_temp.id('m_c1'), pg_temp.id('o3'), pg_temp.id('u_c1'), 'admin', 'active', 'manual'),
  (pg_temp.id('m_c2'), pg_temp.id('o3'), pg_temp.id('u_c2'), 'agent', 'active', 'scim');
-- The SCIM handler writes group_sync_enabled = roleFromGroups (supabase/functions/scim/handlers/users.ts:242).
UPDATE public.organization_members SET group_sync_enabled = true WHERE id = pg_temp.id('m_c2');
INSERT INTO public.organization_members (id, organization_id, user_id, role, license_status, invited_email, provisioned_by) VALUES
  (pg_temp.id('m_inv'), pg_temp.id('o1'), NULL, 'agent', 'pending', 'invitee-3976@example.test', 'invite');
INSERT INTO public.organization_identity_providers (organization_id, provider_type, display_name, attribute_mapping, is_active)
  VALUES (pg_temp.id('o3'), 'azure_ad', 'IdP 3976', '{"group_sync_enabled": true}'::jsonb, true);

DO $t$
DECLARE
  res jsonb := '{}'::jsonb;
  reds jsonb := '{}'::jsonb;
  p int := 0; f int := 0;
  g text;
  S uuid := pg_temp.id('u_s');
  o1 uuid := pg_temp.id('o1'); o2 uuid := pg_temp.id('o2'); o3 uuid := pg_temp.id('o3');
  role_of text;
  n int;
BEGIN
  CREATE TEMP TABLE r3976 (k text, ok boolean, got text) ON COMMIT DROP;

  -- T1 a valid change: agent -> broker, role updated, one audit row with old and new role and actor.
  g := pg_temp.call_as(S, 'authenticated', o1, pg_temp.id('u_a2'), 'broker');
  INSERT INTO r3976 VALUES ('T1_valid_change', g LIKE '%"success": true%' AND g LIKE '%"old_role": "agent"%', g);
  SELECT role INTO role_of FROM public.organization_members WHERE id = pg_temp.id('m_a2');
  INSERT INTO r3976 VALUES ('T1_role_updated', role_of = 'broker', role_of);
  SELECT count(*) INTO n FROM public.admin_audit_logs
   WHERE action = 'org_member.role_change' AND target_type = 'organization_member'
     AND target_id = pg_temp.id('m_a2')::text AND actor_id = S
     AND metadata #>> '{before,role}' = 'agent' AND metadata #>> '{after,role}' = 'broker'
     AND metadata ->> 'organization_id' = o1::text AND metadata ->> 'user_id' = pg_temp.id('u_a2')::text;
  INSERT INTO r3976 VALUES ('T1_audit_row', n = 1, n::text);

  -- T2 internal staff WITHOUT users.edit -> refused by the server, nothing changed, nothing logged.
  g := pg_temp.call_as(pg_temp.id('u_n'), 'authenticated', o1, pg_temp.id('u_a2'), 'agent');
  INSERT INTO r3976 VALUES ('T2_no_users_edit_refused', g LIKE '%insufficient_permissions%', g);
  SELECT role INTO role_of FROM public.organization_members WHERE id = pg_temp.id('m_a2');
  INSERT INTO r3976 VALUES ('T2_role_unchanged', role_of = 'broker', role_of);
  SELECT count(*) INTO n FROM public.admin_audit_logs WHERE actor_id = pg_temp.id('u_n');
  INSERT INTO r3976 VALUES ('T2_no_audit', n = 0, n::text);

  -- T3 a brokerage admin who is not staff -> refused.
  g := pg_temp.call_as(pg_temp.id('u_a1'), 'authenticated', o1, pg_temp.id('u_a2'), 'agent');
  INSERT INTO r3976 VALUES ('T3_not_staff_refused', g LIKE '%not_internal_user%', g);

  -- T4 signed out (anon) -> no EXECUTE.
  g := pg_temp.call_as(NULL, 'anon', o1, pg_temp.id('u_a2'), 'agent');
  INSERT INTO r3976 VALUES ('T4_anon_no_execute', g LIKE 'ERR 42501%', g);

  -- T5 demoting the brokerage's last active admin -> refused (the _guard_last_admin trigger).
  g := pg_temp.call_as(S, 'authenticated', o2, pg_temp.id('u_b1'), 'agent');
  INSERT INTO r3976 VALUES ('T5_last_admin_refused', g LIKE 'ERR P0001 last_admin%', g);
  SELECT role INTO role_of FROM public.organization_members WHERE id = pg_temp.id('m_b1');
  INSERT INTO r3976 VALUES ('T5_role_unchanged', role_of = 'admin', role_of);

  -- T6 demoting an admin when another active admin remains -> allowed.
  g := pg_temp.call_as(S, 'authenticated', o1, pg_temp.id('u_a3'), 'agent');
  INSERT INTO r3976 VALUES ('T6_other_admin_remains_ok', g LIKE '%"success": true%', g);

  -- T7 a user who is not a member of THAT organization -> refused.
  g := pg_temp.call_as(S, 'authenticated', o1, pg_temp.id('u_b2'), 'broker');
  INSERT INTO r3976 VALUES ('T7_not_member_refused', g LIKE '%not_a_member%', g);
  SELECT role INTO role_of FROM public.organization_members WHERE id = pg_temp.id('m_b2');
  INSERT INTO r3976 VALUES ('T7_other_org_unchanged', role_of = 'agent', role_of);

  -- T8 a pending invite (no user) cannot be targeted.
  g := pg_temp.call_as(S, 'authenticated', o1, NULL, 'broker');
  INSERT INTO r3976 VALUES ('T8_pending_invite_refused', g LIKE '%not_a_member%', g);
  SELECT role INTO role_of FROM public.organization_members WHERE id = pg_temp.id('m_inv');
  INSERT INTO r3976 VALUES ('T8_invite_unchanged', role_of = 'agent', role_of);

  -- T9 it_admin: staff may grant it (the _guard_it_admin_grant trigger exempts internal staff)
  -- and change it back.
  g := pg_temp.call_as(S, 'authenticated', o1, pg_temp.id('u_a2'), 'it_admin');
  INSERT INTO r3976 VALUES ('T9_grant_it_admin_ok', g LIKE '%"success": true%', g);
  g := pg_temp.call_as(S, 'authenticated', o1, pg_temp.id('u_a2'), 'agent');
  INSERT INTO r3976 VALUES ('T9_demote_it_admin_ok', g LIKE '%"old_role": "it_admin"%', g);

  -- T10 a role the identity provider manages -> refused (the _guard_idp_role trigger).
  g := pg_temp.call_as(S, 'authenticated', o3, pg_temp.id('u_c2'), 'broker');
  INSERT INTO r3976 VALUES ('T10_idp_managed_refused', g LIKE 'ERR 42501 managed_by_idp%', g);

  -- T11 own role, T12 unknown role, T13 same role.
  g := pg_temp.call_as(S, 'authenticated', o1, S, 'admin');
  INSERT INTO r3976 VALUES ('T11_own_role_refused', g LIKE '%cannot_change_own_role%', g);
  g := pg_temp.call_as(S, 'authenticated', o1, pg_temp.id('u_a2'), 'owner');
  INSERT INTO r3976 VALUES ('T12_invalid_role_refused', g LIKE '%invalid_role%', g);
  g := pg_temp.call_as(S, 'authenticated', o1, pg_temp.id('u_a2'), 'agent');
  INSERT INTO r3976 VALUES ('T13_same_role_refused', g LIKE '%role_unchanged%', g);

  -- T14 ACL: no PUBLIC/anon EXECUTE, authenticated has it; SECURITY DEFINER with search_path.
  SELECT count(*) INTO n FROM pg_proc pr
   WHERE pr.oid = 'public.admin_update_org_member_role(uuid,uuid,text)'::regprocedure
     AND pr.prosecdef AND pr.proconfig @> ARRAY['search_path=public']
     AND NOT has_function_privilege('anon', pr.oid, 'EXECUTE')
     AND has_function_privilege('authenticated', pr.oid, 'EXECUTE')
     AND NOT EXISTS (SELECT 1 FROM aclexplode(pr.proacl) a WHERE a.grantee = 0);
  INSERT INTO r3976 VALUES ('T14_acl', n = 1, n::text);

  SELECT count(*) FILTER (WHERE ok), count(*) FILTER (WHERE NOT ok OR ok IS NULL) INTO p, f FROM r3976;
  SELECT coalesce(jsonb_object_agg(k, got), '{}'::jsonb) INTO reds FROM r3976 WHERE NOT ok OR ok IS NULL;
  RAISE EXCEPTION 'P3976_RESULT %', jsonb_build_object('mode', '__MODE__', 'pass', p, 'fail', f, 'reds', reds);
END $t$;
