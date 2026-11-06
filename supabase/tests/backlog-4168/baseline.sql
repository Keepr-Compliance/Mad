-- BACKLOG-4168 baseline B1-B8: eight calls whose result differs between the pre-migration and the
-- post-migration functions. Each reports PRE when the result matches the pre-migration value and POST
-- otherwise. Run with --pre (expect all PRE) and with --with-migration (expect all POST).
-- Output: RAISE 'P4168_RESULT {total, pass, fail, reds, checks}'; pass counts the state given by
-- --want.

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

  -- B1: count of the listed functions with anon or PUBLIC EXECUTE (PRE: > 0)
  n := (SELECT count(*) FROM unnest(writers) w
         WHERE has_function_privilege('anon', w::regprocedure, 'EXECUTE')
            OR EXISTS (SELECT 1 FROM pg_proc p, aclexplode(p.proacl) a WHERE p.oid = w::regprocedure AND a.grantee = 0));
  checks := checks || jsonb_build_object('B1_anon_public_execute_count', CASE WHEN n > 0 THEN 'PRE' ELSE 'POST' END || ' n=' || n);

  -- B2: admin_add_internal_user called by a support-agent fixture, role super-admin (PRE: success)
  s := pg_temp.call_rb(uG, format('SELECT public.admin_add_internal_user(%L, %L)', 'p4168-8@example.test', 'super-admin'),
                       format('SELECT pg_temp.role_of(8)'));
  checks := checks || jsonb_build_object('B2_add_by_support_agent', CASE WHEN s LIKE '%| super-admin' THEN 'PRE' ELSE 'POST' END || ' ' || s);

  -- B3: invitation INSERT by a support-agent fixture, invited_by another user (PRE: 1 row)
  s := pg_temp.call_rb(uG, format('WITH i AS (INSERT INTO public.pending_internal_invitations (email, role_id, invited_by) VALUES (%L, (SELECT id FROM public.admin_roles WHERE slug = %L), %L) RETURNING 1) SELECT to_jsonb(count(*)) FROM i',
                       'p4168-inv3@example.test', 'super-admin', uA));
  checks := checks || jsonb_build_object('B3_invitation_insert_by_support_agent', CASE WHEN s = '1' THEN 'PRE' ELSE 'POST' END || ' ' || s);

  -- B4: invitation UPDATE of role_id by a support-agent fixture (PRE: 1 row)
  s := pg_temp.call_rb(uG, format('WITH i AS (UPDATE public.pending_internal_invitations SET role_id = (SELECT id FROM public.admin_roles WHERE slug = %L) WHERE id = %L RETURNING 1) SELECT to_jsonb(count(*)) FROM i',
                       'super-admin', pg_temp.fx(201)));
  checks := checks || jsonb_build_object('B4_invitation_update_by_support_agent', CASE WHEN s = '1' THEN 'PRE' ELSE 'POST' END || ' ' || s);

  -- B5: admin_remove_internal_user called by a support-agent fixture (PRE: success)
  s := pg_temp.call_rb(uG, format('SELECT public.admin_remove_internal_user(%L)', uA), 'SELECT pg_temp.role_of(1)');
  checks := checks || jsonb_build_object('B5_remove_by_support_agent', CASE WHEN s LIKE '%| -' THEN 'PRE' ELSE 'POST' END || ' ' || s);

  -- B6: admin_add_internal_user replies for two emails compared (PRE: replies differ)
  s := pg_temp.call_rb(uG, format('SELECT public.admin_add_internal_user(%L, %L)', 'p4168-unknown@example.test', 'p4168-lower'));
  s2 := pg_temp.call_rb(uG, format('SELECT public.admin_add_internal_user(%L, %L)', 'p4168-1@example.test', 'p4168-lower'));
  checks := checks || jsonb_build_object('B6_add_reply_two_emails', CASE WHEN s <> s2 THEN 'PRE' ELSE 'POST' END || ' [' || s || '] vs [' || s2 || ']');

  -- B7: admin_update_internal_user_role on the caller, single is_system holder (PRE: success)
  s := pg_temp.sole_sa(format('SELECT public.admin_update_internal_user_role(%L, %L)', uA, 'p4168-lower'));
  checks := checks || jsonb_build_object('B7_update_own_role_single_holder', CASE WHEN s LIKE '{%' THEN 'PRE' ELSE 'POST' END || ' ' || s);

  -- B8: admin_update_role_permissions by the editor fixture on its own role (PRE: success)
  s := pg_temp.call_rb(uE, format('SELECT public.admin_update_role_permissions(%L, %L::text[])', pg_temp.fx(106),
                       '{roles.manage,roles.view,dashboard.view,support.view,users.view,internal_users.manage}'));
  checks := checks || jsonb_build_object('B8_role_permissions_own_role', CASE WHEN s LIKE '{%' THEN 'PRE' ELSE 'POST' END || ' ' || s);

  SELECT jsonb_object_agg(key, CASE WHEN value LIKE want || '%' THEN 'PASS' ELSE 'FAIL ' || value END) INTO r FROM jsonb_each_text(checks);
  RAISE EXCEPTION 'P4168_RESULT %', jsonb_build_object(
    'total', (SELECT count(*) FROM jsonb_each_text(r)),
    'pass', (SELECT count(*) FROM jsonb_each_text(r) e WHERE e.value = 'PASS'),
    'fail', (SELECT count(*) FROM jsonb_each_text(r) e WHERE e.value <> 'PASS'),
    'reds', (SELECT coalesce(jsonb_object_agg(e.key, e.value), '{}'::jsonb) FROM jsonb_each_text(r) e WHERE e.value <> 'PASS'),
    'checks', checks);
END
$drv$;
