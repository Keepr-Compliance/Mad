-- BACKLOG-4168 baseline H1-H8: each reports OPEN when the behaviour the fix removes still works,
-- CLOSED otherwise. Run BEFORE the migration (expect all OPEN) and with --with-migration (expect all
-- CLOSED). Output: RAISE 'P4168_RESULT {total, pass, fail, reds, checks}' where pass counts the
-- expected state given as the first argument of the composed call ('OPEN' or 'CLOSED').

DO $drv$
DECLARE
  r jsonb := '{}'::jsonb;
  want text := current_setting('p4168.want');
  s text; s2 text; n int;
  uA uuid := pg_temp.fx(1); uG uuid := pg_temp.fx(6); uE uuid := pg_temp.fx(9);
  writers text[] := ARRAY['public.admin_add_internal_user(text,text)',
                          'public.admin_update_internal_user_role(uuid,text)',
                          'public.admin_remove_internal_user(uuid)',
                          'public.admin_create_role(text,text,text,text[])',
                          'public.admin_update_role_permissions(uuid,text[])',
                          'public.admin_update_role(uuid,text,text)',
                          'public.admin_delete_role(uuid)'];
  st text;
  checks jsonb := '{}'::jsonb;
BEGIN
  PERFORM pg_temp.setup();

  -- H1: some internal-user / role writer is executable by anon or PUBLIC
  n := (SELECT count(*) FROM unnest(writers) w
         WHERE has_function_privilege('anon', w::regprocedure, 'EXECUTE')
            OR EXISTS (SELECT 1 FROM pg_proc p, aclexplode(p.proacl) a WHERE p.oid = w::regprocedure AND a.grantee = 0));
  checks := checks || jsonb_build_object('H1_anon_or_public_execute', CASE WHEN n > 0 THEN 'OPEN' ELSE 'CLOSED' END || ' n=' || n);

  -- H2: a Support Agent (no internal_users.manage) adds an account as Super Admin
  s := pg_temp.call_rb(uG, format('SELECT public.admin_add_internal_user(%L, %L)', 'p4168-8@example.test', 'super-admin'),
                       format('SELECT pg_temp.role_of(8)'));
  checks := checks || jsonb_build_object('H2_agent_adds_super_admin', CASE WHEN s LIKE '%| super-admin' THEN 'OPEN' ELSE 'CLOSED' END || ' ' || s);

  -- H3: a Support Agent inserts a Super Admin invitation naming someone else as inviter
  s := pg_temp.call_rb(uG, format('WITH i AS (INSERT INTO public.pending_internal_invitations (email, role_id, invited_by) VALUES (%L, (SELECT id FROM public.admin_roles WHERE slug = %L), %L) RETURNING 1) SELECT to_jsonb(count(*)) FROM i',
                       'p4168-inv3@example.test', 'super-admin', uA));
  checks := checks || jsonb_build_object('H3_agent_inserts_sa_invitation', CASE WHEN s = '1' THEN 'OPEN' ELSE 'CLOSED' END || ' ' || s);

  -- H4: a Support Agent re-points an existing invitation at Super Admin
  s := pg_temp.call_rb(uG, format('WITH i AS (UPDATE public.pending_internal_invitations SET role_id = (SELECT id FROM public.admin_roles WHERE slug = %L) WHERE id = %L RETURNING 1) SELECT to_jsonb(count(*)) FROM i',
                       'super-admin', pg_temp.fx(201)));
  checks := checks || jsonb_build_object('H4_agent_updates_invitation_to_sa', CASE WHEN s = '1' THEN 'OPEN' ELSE 'CLOSED' END || ' ' || s);

  -- H5: a Support Agent removes a Super Admin
  s := pg_temp.call_rb(uG, format('SELECT public.admin_remove_internal_user(%L)', uA), 'SELECT pg_temp.role_of(1)');
  checks := checks || jsonb_build_object('H5_agent_removes_super_admin', CASE WHEN s LIKE '%| -' THEN 'OPEN' ELSE 'CLOSED' END || ' ' || s);

  -- H6: the add call answers an unknown email differently from a known one (account-existence oracle)
  s := pg_temp.call_rb(uG, format('SELECT public.admin_add_internal_user(%L, %L)', 'p4168-unknown@example.test', 'p4168-lower'));
  s2 := pg_temp.call_rb(uG, format('SELECT public.admin_add_internal_user(%L, %L)', 'p4168-1@example.test', 'p4168-lower'));
  checks := checks || jsonb_build_object('H6_email_oracle', CASE WHEN s <> s2 THEN 'OPEN' ELSE 'CLOSED' END || ' [' || s || '] vs [' || s2 || ']');

  -- H7: the only Super Admin demotes themself
  s := pg_temp.sole_sa(format('SELECT public.admin_update_internal_user_role(%L, %L)', uA, 'p4168-lower'));
  checks := checks || jsonb_build_object('H7_sole_sa_demotes_self', CASE WHEN s LIKE '{%' THEN 'OPEN' ELSE 'CLOSED' END || ' ' || s);

  -- H8: a role editor adds internal_users.manage (a key they do not hold) to their own role
  s := pg_temp.call_rb(uE, format('SELECT public.admin_update_role_permissions(%L, %L::text[])', pg_temp.fx(106),
                       '{roles.manage,roles.view,dashboard.view,support.view,users.view,internal_users.manage}'));
  checks := checks || jsonb_build_object('H8_editor_adds_unheld_key_to_own_role', CASE WHEN s LIKE '{%' THEN 'OPEN' ELSE 'CLOSED' END || ' ' || s);

  SELECT jsonb_object_agg(key, CASE WHEN value LIKE want || '%' THEN 'PASS' ELSE 'FAIL ' || value END) INTO r FROM jsonb_each_text(checks);
  RAISE EXCEPTION 'P4168_RESULT %', jsonb_build_object(
    'total', (SELECT count(*) FROM jsonb_each_text(r)),
    'pass', (SELECT count(*) FROM jsonb_each_text(r) e WHERE e.value = 'PASS'),
    'fail', (SELECT count(*) FROM jsonb_each_text(r) e WHERE e.value <> 'PASS'),
    'reds', (SELECT coalesce(jsonb_object_agg(e.key, e.value), '{}'::jsonb) FROM jsonb_each_text(r) e WHERE e.value <> 'PASS'),
    'checks', checks);
END
$drv$;
