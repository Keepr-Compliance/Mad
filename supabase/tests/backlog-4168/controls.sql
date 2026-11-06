-- BACKLOG-4168 post-fix controls. Run with compose.py controls --with-migration (migration applied
-- TWICE in front), or after 20261107100000 is applied. Fixtures: see prelude.sql. Every state-changing
-- call runs through call_rb / sole_sa, so each control starts from the same fixture state.
-- Output: RAISE 'P4168_RESULT {total, pass, fail, reds}'.

CREATE FUNCTION pg_temp.run() RETURNS jsonb LANGUAGE plpgsql AS $f$
DECLARE
  r jsonb := '{}'::jsonb;
  s text; s2 text; n int; ok boolean; d0 text; a0 text; p0 text;
  uA uuid := pg_temp.fx(1); uD uuid := pg_temp.fx(2); uM uuid := pg_temp.fx(3); uP uuid := pg_temp.fx(4);
  uL uuid := pg_temp.fx(5); uG uuid := pg_temp.fx(6); uN uuid := pg_temp.fx(7); uX uuid := pg_temp.fx(8);
  uE uuid := pg_temp.fx(9); uQ uuid := pg_temp.fx(10);
  r_sa uuid := (SELECT id FROM public.admin_roles WHERE is_system ORDER BY created_at LIMIT 1);
  NP text := 'ERR 42501 Not permitted';
  refusals text[] := '{}';
  add_q text := 'SELECT public.admin_add_internal_user(%L, %L)';
  upd_q text := 'SELECT public.admin_update_internal_user_role(%L, %L)';
  rem_q text := 'SELECT public.admin_remove_internal_user(%L)';
  acc_q text := 'SELECT public.admin_accept_internal_invitation(%L, %L)';
  ins_q text := 'WITH i AS (INSERT INTO public.pending_internal_invitations (email, role_id, invited_by) VALUES (%L, %L, %L) RETURNING 1) SELECT to_jsonb(count(*)) FROM i';
  inv_probe text := 'SELECT coalesce((SELECT ar.slug || ''/'' || right(i.invited_by::text, 2) FROM public.pending_internal_invitations i JOIN public.admin_roles ar ON ar.id = i.role_id WHERE i.email = ''p4168-unknown@example.test''), ''none'')';
  pub text[] := ARRAY['public.admin_add_internal_user(text,text)',
                      'public.admin_update_internal_user_role(uuid,text)',
                      'public.admin_remove_internal_user(uuid)',
                      'public.admin_create_role(text,text,text,text[])',
                      'public.admin_update_role_permissions(uuid,text[])',
                      'public.admin_update_role(uuid,text,text)',
                      'public.admin_delete_role(uuid)',
                      'public.can_grant_role(uuid)'];
  priv text[] := ARRAY['public._admin_keys_held(uuid,text[])', 'public._admin_can_grant_role_as(uuid,uuid)'];
  acc text := 'public.admin_accept_internal_invitation(uuid,text)';
  allf text[];
BEGIN
  allf := pub || priv || acc;
  PERFORM pg_temp.setup();

  -- ================= ADD (admin_add_internal_user) =================
  s := pg_temp.call_rb(uA, format(add_q, 'p4168-8@example.test', 'super-admin'), 'SELECT pg_temp.role_of(8)');
  r := r || jsonb_build_object('A1_sa_adds_super_admin', pg_temp.pass(s = '{"role": "super-admin", "success": true, "user_id": "' || uX || '"} | super-admin', s));
  s := pg_temp.call_rb(uM, format(add_q, 'p4168-8@example.test', 'p4168-lower'), 'SELECT pg_temp.role_of(8)');
  r := r || jsonb_build_object('A2_manager_adds_lower', pg_temp.pass(s LIKE '{%"success": true%} | p4168-lower', s));
  s := pg_temp.call_rb(uM, format(add_q, 'p4168-8@example.test', 'p4168-peer'), 'SELECT pg_temp.role_of(8)');
  refusals := refusals || split_part(s, ' | ', 1);
  r := r || jsonb_build_object('A3_manager_equal_role_refused', pg_temp.pass(s = NP || ' | -', s));
  s := pg_temp.call_rb(uM, format(add_q, 'p4168-8@example.test', 'p4168-side'), 'SELECT pg_temp.role_of(8)');
  refusals := refusals || split_part(s, ' | ', 1);
  r := r || jsonb_build_object('A4_manager_side_role_refused', pg_temp.pass(s = NP || ' | -', s));
  s := pg_temp.call_rb(uM, format(add_q, 'p4168-8@example.test', 'super-admin'), 'SELECT pg_temp.role_of(8)');
  refusals := refusals || split_part(s, ' | ', 1);
  r := r || jsonb_build_object('A5_manager_super_admin_refused', pg_temp.pass(s = NP || ' | -', s));
  s := pg_temp.call_rb(uG, format(add_q, 'p4168-8@example.test', 'p4168-lower2'), 'SELECT pg_temp.role_of(8)');
  refusals := refusals || split_part(s, ' | ', 1);
  r := r || jsonb_build_object('A6_no_manage_refused', pg_temp.pass(s = NP || ' | -', s));
  s := pg_temp.call_rb(uM, format(add_q, 'P4168-Unknown@Example.test ', 'p4168-lower'), inv_probe);
  r := r || jsonb_build_object('A7_manager_unknown_email_pending', pg_temp.pass(
    s = '{"role": "p4168-lower", "email": "p4168-unknown@example.test", "pending": true, "success": true} | p4168-lower/03', s));
  s := pg_temp.call_rb(uM, format(add_q, 'p4168-unknown@example.test', 'super-admin'), inv_probe);
  refusals := refusals || split_part(s, ' | ', 1);
  r := r || jsonb_build_object('A8_manager_unknown_email_sa_refused', pg_temp.pass(s = NP || ' | none', s));
  s := pg_temp.call_rb(uM, format(add_q, 'p4168-inv2@example.test', 'p4168-lower'),
                       'SELECT ar.slug FROM public.pending_internal_invitations i JOIN public.admin_roles ar ON ar.id = i.role_id WHERE i.id = pg_temp.fx(202)');
  refusals := refusals || split_part(s, ' | ', 1);
  r := r || jsonb_build_object('A9_manager_cannot_overwrite_sa_invitation', pg_temp.pass(s = NP || ' | super-admin', s));
  s := pg_temp.call_rb(uQ, format(add_q, 'p4168-8@example.test', 'p4168-lower2'));
  refusals := refusals || s;
  r := r || jsonb_build_object('A10_outsider_refused', pg_temp.pass(s = NP, s));
  s := pg_temp.call_rb(uL, format(add_q, 'p4168-8@example.test', 'p4168-lower2'));
  refusals := refusals || s;
  r := r || jsonb_build_object('A11_internal_no_manage_refused', pg_temp.pass(s = NP, s));
  s := pg_temp.call_rb(uM, format(add_q, 'p4168-8@example.test', 'p4168-manager'));
  refusals := refusals || s;
  r := r || jsonb_build_object('A12_manager_own_role_refused', pg_temp.pass(s = NP, s));
  s := pg_temp.call_rb(uM, format(add_q, 'p4168-5@example.test', 'p4168-lower2'), 'SELECT pg_temp.role_of(5)');
  refusals := refusals || split_part(s, ' | ', 1);
  r := r || jsonb_build_object('A13_already_internal_refused', pg_temp.pass(s = NP || ' | p4168-lower', s));
  s := pg_temp.call_rb(NULL, format(add_q, 'p4168-8@example.test', 'p4168-lower2'), NULL, 'anon');
  r := r || jsonb_build_object('A14_anon_no_execute', pg_temp.pass(s LIKE 'ERR 42501 permission denied for function%', s));

  -- ================= UPDATE (admin_update_internal_user_role) =================
  s := pg_temp.call_rb(uM, format(upd_q, uL, 'p4168-lower2'), 'SELECT pg_temp.role_of(5)');
  r := r || jsonb_build_object('U1_manager_lower_to_lower2', pg_temp.pass(s LIKE '{%"success": true%} | p4168-lower2', s));
  s := pg_temp.call_rb(uM, format(upd_q, uL, 'super-admin'), 'SELECT pg_temp.role_of(5)');
  refusals := refusals || split_part(s, ' | ', 1);
  r := r || jsonb_build_object('U2_manager_to_sa_refused', pg_temp.pass(s = NP || ' | p4168-lower', s));
  s := pg_temp.call_rb(uM, format(upd_q, uL, 'p4168-peer'), 'SELECT pg_temp.role_of(5)');
  refusals := refusals || split_part(s, ' | ', 1);
  r := r || jsonb_build_object('U3_manager_to_equal_refused', pg_temp.pass(s = NP || ' | p4168-lower', s));
  s := pg_temp.call_rb(uM, format(upd_q, uP, 'p4168-lower'), 'SELECT pg_temp.role_of(4)');
  refusals := refusals || split_part(s, ' | ', 1);
  r := r || jsonb_build_object('U4_manager_peer_current_role_refused', pg_temp.pass(s = NP || ' | p4168-manager', s));
  s := pg_temp.call_rb(uM, format(upd_q, uA, 'p4168-lower'), 'SELECT pg_temp.role_of(1)');
  refusals := refusals || split_part(s, ' | ', 1);
  r := r || jsonb_build_object('U5_manager_demotes_sa_refused', pg_temp.pass(s = NP || ' | super-admin', s));
  s := pg_temp.call_rb(uA, format(upd_q, uA, 'p4168-lower'), 'SELECT pg_temp.role_of(1)');
  refusals := refusals || split_part(s, ' | ', 1);
  r := r || jsonb_build_object('U6_sa_self_change_refused', pg_temp.pass(s = NP || ' | super-admin', s));
  s := pg_temp.call_rb(uG, format(upd_q, uL, 'p4168-lower2'), 'SELECT pg_temp.role_of(5)');
  refusals := refusals || split_part(s, ' | ', 1);
  r := r || jsonb_build_object('U7_no_manage_refused', pg_temp.pass(s = NP || ' | p4168-lower', s));
  s := pg_temp.call_rb(uA, format(upd_q, uD, 'p4168-lower'), 'SELECT pg_temp.role_of(2)');
  r := r || jsonb_build_object('U8_sa_demotes_other_sa', pg_temp.pass(s LIKE '{%"success": true%} | p4168-lower', s));
  s := pg_temp.sole_sa(format(upd_q, uA, 'p4168-lower'));
  refusals := refusals || split_part(s, ' | ', 1);
  r := r || jsonb_build_object('U9_sole_sa_self_demote_refused', pg_temp.pass(s = NP || ' | sa_holders=1', s));
  s := pg_temp.call_rb(uM, format(upd_q, uX, 'p4168-lower'), 'SELECT pg_temp.role_of(8)');
  refusals := refusals || split_part(s, ' | ', 1);
  r := r || jsonb_build_object('U10_target_without_role_refused', pg_temp.pass(s = NP || ' | -', s));

  -- ================= REMOVE (admin_remove_internal_user) =================
  s := pg_temp.call_rb(uM, format(rem_q, uL), 'SELECT pg_temp.role_of(5)');
  r := r || jsonb_build_object('R1_manager_removes_lower', pg_temp.pass(s LIKE '{%"success": true%} | -', s));
  s := pg_temp.call_rb(uM, format(rem_q, uP), 'SELECT pg_temp.role_of(4)');
  refusals := refusals || split_part(s, ' | ', 1);
  r := r || jsonb_build_object('R2_manager_removes_peer_refused', pg_temp.pass(s = NP || ' | p4168-manager', s));
  s := pg_temp.call_rb(uM, format(rem_q, uA), 'SELECT pg_temp.role_of(1)');
  refusals := refusals || split_part(s, ' | ', 1);
  r := r || jsonb_build_object('R3_manager_removes_sa_refused', pg_temp.pass(s = NP || ' | super-admin', s));
  s := pg_temp.call_rb(uG, format(rem_q, uL), 'SELECT pg_temp.role_of(5)');
  refusals := refusals || split_part(s, ' | ', 1);
  r := r || jsonb_build_object('R4_no_manage_refused', pg_temp.pass(s = NP || ' | p4168-lower', s));
  s := pg_temp.call_rb(uA, format(rem_q, uA), 'SELECT pg_temp.role_of(1)');
  refusals := refusals || split_part(s, ' | ', 1);
  r := r || jsonb_build_object('R5_sa_self_remove_refused', pg_temp.pass(s = NP || ' | super-admin', s));
  s := pg_temp.call_rb(uA, format(rem_q, uD), 'SELECT pg_temp.role_of(2)');
  r := r || jsonb_build_object('R6_sa_removes_other_sa', pg_temp.pass(s LIKE '{%"success": true%} | -', s));
  s := pg_temp.sole_sa(format(rem_q, uA));
  refusals := refusals || split_part(s, ' | ', 1);
  r := r || jsonb_build_object('R7_sole_sa_self_remove_refused', pg_temp.pass(s = NP || ' | sa_holders=1', s));

  -- ================= INVITATIONS (direct table, RLS) =================
  s := pg_temp.call_rb(uM, format(ins_q, 'p4168-inv3@example.test', pg_temp.fx(102), uM));
  r := r || jsonb_build_object('I1_manager_inserts_lower', pg_temp.pass(s = '1', s));
  s := pg_temp.call_rb(uM, format(ins_q, 'p4168-inv3@example.test', r_sa, uM));
  r := r || jsonb_build_object('I2_manager_inserts_sa_refused', pg_temp.pass(s LIKE 'ERR 42501 new row violates row-level security%', s));
  s := pg_temp.call_rb(uM, format(ins_q, 'p4168-inv3@example.test', pg_temp.fx(102), uA));
  r := r || jsonb_build_object('I3_manager_forged_inviter_refused', pg_temp.pass(s LIKE 'ERR 42501 new row violates row-level security%', s));
  s := pg_temp.call_rb(uG, format(ins_q, 'p4168-inv3@example.test', pg_temp.fx(105), uG));
  r := r || jsonb_build_object('I4_no_manage_insert_refused', pg_temp.pass(s LIKE 'ERR 42501 new row violates row-level security%', s));
  s := pg_temp.call_rb(uM, format('WITH i AS (UPDATE public.pending_internal_invitations SET role_id = %L WHERE id = %L RETURNING 1) SELECT to_jsonb(count(*)) FROM i', r_sa, pg_temp.fx(201)));
  r := r || jsonb_build_object('I5_manager_update_to_sa_refused', pg_temp.pass(s LIKE 'ERR 42501 new row violates row-level security%', s));
  s := pg_temp.call_rb(uM, format('WITH i AS (UPDATE public.pending_internal_invitations SET role_id = %L, invited_by = %L WHERE id = %L RETURNING 1) SELECT to_jsonb(count(*)) FROM i', pg_temp.fx(102), uM, pg_temp.fx(202)));
  r := r || jsonb_build_object('I6_manager_cannot_touch_sa_invitation', pg_temp.pass(s = '0', s));
  s := pg_temp.call_rb(uM, format('WITH i AS (UPDATE public.pending_internal_invitations SET role_id = %L WHERE id = %L RETURNING 1) SELECT to_jsonb(count(*)) FROM i', pg_temp.fx(105), pg_temp.fx(201)));
  r := r || jsonb_build_object('I7_manager_updates_lower_invitation', pg_temp.pass(s = '1', s));
  s := pg_temp.call_rb(uG, format('WITH i AS (UPDATE public.pending_internal_invitations SET role_id = %L WHERE id = %L RETURNING 1) SELECT to_jsonb(count(*)) FROM i', pg_temp.fx(105), pg_temp.fx(201)));
  r := r || jsonb_build_object('I8_no_manage_update_zero_rows', pg_temp.pass(s = '0', s));
  s := pg_temp.call_rb(uM, format('WITH i AS (UPDATE public.pending_internal_invitations SET invited_by = %L WHERE id = %L RETURNING 1) SELECT to_jsonb(count(*)) FROM i', uA, pg_temp.fx(201)));
  r := r || jsonb_build_object('I9_manager_forges_inviter_on_update_refused', pg_temp.pass(s LIKE 'ERR 42501 new row violates row-level security%', s));
  s := pg_temp.call_rb(uG, format('WITH i AS (DELETE FROM public.pending_internal_invitations WHERE id = %L RETURNING 1) SELECT to_jsonb(count(*)) FROM i', pg_temp.fx(201)));
  s2 := pg_temp.call_rb(uM, format('WITH i AS (DELETE FROM public.pending_internal_invitations WHERE id = %L RETURNING 1) SELECT to_jsonb(count(*)) FROM i', pg_temp.fx(201)));
  r := r || jsonb_build_object('I10_cancel_needs_manage', pg_temp.pass(s = '0' AND s2 = '1', s || ' / ' || s2));
  s := pg_temp.call_rb(uL, 'SELECT to_jsonb(count(*)) FROM public.pending_internal_invitations WHERE email LIKE ''p4168-%''');
  s2 := pg_temp.call_rb(uQ, 'SELECT to_jsonb(count(*)) FROM public.pending_internal_invitations WHERE email LIKE ''p4168-%''');
  r := r || jsonb_build_object('I11_internal_reads_outsider_does_not', pg_temp.pass(s = '2' AND s2 = '0', s || ' / ' || s2));

  -- ================= ACCEPT (admin_accept_internal_invitation, service role) =================
  -- each case inserts its invitation for N (p4168-7) as postgres inside the rolled-back call
  s := pg_temp.call_rb(NULL, format('SELECT public.admin_accept_internal_invitation(%L, %L)', uN, 'p4168-7@example.test'),
                       'SELECT pg_temp.role_of(7)', 'service_role');
  r := r || jsonb_build_object('C1_no_invitation_not_assigned', pg_temp.pass(s = '{"success": true, "assigned": false} | -', s));
  -- C2..C6: invitation (role, inviter) -> expected
  FOR n IN 2..7 LOOP
    BEGIN
      INSERT INTO public.pending_internal_invitations (email, role_id, invited_by)
      VALUES ('p4168-7@example.test',
              CASE n WHEN 2 THEN pg_temp.fx(102) WHEN 3 THEN r_sa WHEN 4 THEN pg_temp.fx(102) WHEN 5 THEN pg_temp.fx(103) WHEN 6 THEN r_sa ELSE pg_temp.fx(102) END,
              CASE n WHEN 2 THEN uM WHEN 3 THEN uM WHEN 4 THEN uG WHEN 5 THEN uM WHEN 6 THEN uA ELSE uM END);
      -- the call and the probes are separate statements, so the probes see the call's writes
      s := pg_temp.call_as(NULL, format(acc_q, CASE WHEN n = 7 THEN uX ELSE uN END, 'P4168-7@example.test'), 'service_role');
      s := s || ' | ' || pg_temp.role_of(7);
      s := s || ' | inv=' || (SELECT count(*) FROM public.pending_internal_invitations WHERE email = 'p4168-7@example.test');
      s := s || ' | by=' || coalesce((SELECT right(created_by::text, 2) FROM public.internal_roles WHERE user_id = uN), '-');
      RAISE EXCEPTION 'RB_DONE' USING DETAIL = s;
    EXCEPTION WHEN OTHERS THEN
      IF SQLERRM = 'RB_DONE' THEN GET STACKED DIAGNOSTICS s = PG_EXCEPTION_DETAIL;
      ELSE s := 'ERRRB ' || SQLSTATE || ' ' || left(SQLERRM, 80); END IF;
    END;
    IF n IN (3, 4, 5, 7) THEN refusals := refusals || split_part(s, ' | ', 1); END IF;
    r := r || CASE n
      WHEN 2 THEN jsonb_build_object('C2_manager_lower_invite_accepted', pg_temp.pass(s LIKE '{"role": "p4168-lower", "success": true, "user_id": "%", "assigned": true} | p4168-lower | inv=0 | by=03', s))
      WHEN 3 THEN jsonb_build_object('C3_manager_sa_invite_refused', pg_temp.pass(s = NP || ' | - | inv=1 | by=-', s))
      WHEN 4 THEN jsonb_build_object('C4_inviter_without_manage_refused', pg_temp.pass(s = NP || ' | - | inv=1 | by=-', s))
      WHEN 5 THEN jsonb_build_object('C5_manager_equal_role_invite_refused', pg_temp.pass(s = NP || ' | - | inv=1 | by=-', s))
      WHEN 6 THEN jsonb_build_object('C6_sa_sa_invite_accepted', pg_temp.pass(s LIKE '{"role": "super-admin", "success": true, "user_id": "%", "assigned": true} | super-admin | inv=0 | by=01', s))
      ELSE jsonb_build_object('C7_wrong_account_for_email_refused', pg_temp.pass(s = NP || ' | - | inv=1 | by=-', s))
    END;
  END LOOP;
  s := pg_temp.call_rb(uA, format(acc_q, uN, 'p4168-7@example.test'));
  s2 := pg_temp.call_rb(NULL, format(acc_q, uN, 'p4168-7@example.test'), NULL, 'anon');
  r := r || jsonb_build_object('C8_accept_not_callable_by_clients', pg_temp.pass(
    s LIKE 'ERR 42501 permission denied for function%' AND s2 LIKE 'ERR 42501 permission denied for function%', s || ' / ' || s2));

  -- ================= ROLE CRUD =================
  s := pg_temp.call_rb(uE, format('SELECT public.admin_create_role(%L, %L, %L, %L::text[])', 'P4168 New', 'p4168-new', 'x', '{dashboard.view}'));
  r := r || jsonb_build_object('K1_editor_creates_held_keys', pg_temp.pass(s LIKE '{%"success": true}', s));
  s := pg_temp.call_rb(uE, format('SELECT public.admin_create_role(%L, %L, %L, %L::text[])', 'P4168 New', 'p4168-new', 'x', '{dashboard.view,billing.manage}'),
                       'SELECT count(*)::text FROM public.admin_roles WHERE slug = ''p4168-new''');
  refusals := refusals || split_part(s, ' | ', 1);
  r := r || jsonb_build_object('K2_editor_create_unheld_key_refused', pg_temp.pass(s = NP || ' | 0', s));
  s := pg_temp.call_rb(uE, format('SELECT public.admin_update_role_permissions(%L, %L::text[])', pg_temp.fx(102), '{dashboard.view,support.view,users.view}'));
  r := r || jsonb_build_object('K3_editor_sets_held_keys', pg_temp.pass(s LIKE '{%"success": true}', s));
  s := pg_temp.call_rb(uE, format('SELECT public.admin_update_role_permissions(%L, %L::text[])', pg_temp.fx(102), '{dashboard.view,billing.manage}'));
  refusals := refusals || s;
  r := r || jsonb_build_object('K4_editor_unheld_key_refused', pg_temp.pass(s = NP, s));
  s := pg_temp.call_rb(uE, format('SELECT public.admin_update_role_permissions(%L, %L::text[])', pg_temp.fx(106), '{roles.manage,roles.view,dashboard.view}'));
  refusals := refusals || s;
  r := r || jsonb_build_object('K5_editor_own_role_refused', pg_temp.pass(s = NP, s));
  s := pg_temp.call_rb(uE, format('SELECT public.admin_update_role_permissions(%L, %L::text[])', r_sa, '{dashboard.view}'));
  refusals := refusals || s;
  r := r || jsonb_build_object('K6_editor_system_role_refused', pg_temp.pass(s = NP, s));
  s := pg_temp.call_rb(uG, format('SELECT public.admin_create_role(%L, %L, %L, %L::text[])', 'P4168 New', 'p4168-new', 'x', '{dashboard.view}'));
  refusals := refusals || s;
  r := r || jsonb_build_object('K7_no_roles_manage_refused', pg_temp.pass(s = NP, s));
  s := pg_temp.call_rb(uA, format('SELECT public.admin_create_role(%L, %L, %L, %L::text[])', 'P4168 New', 'p4168-new', 'x', '{dashboard.view,billing.manage}'));
  r := r || jsonb_build_object('K8_sa_creates_any_keys', pg_temp.pass(s LIKE '{%"success": true}', s));
  s := pg_temp.call_rb(uA, format('SELECT public.admin_update_role_permissions(%L, %L::text[])', r_sa, '{dashboard.view}'));
  refusals := refusals || s;
  r := r || jsonb_build_object('K9_sa_system_role_still_read_only', pg_temp.pass(s = NP, s));
  s := pg_temp.call_rb(uM, format('SELECT public.admin_update_role_permissions(%L, %L::text[])', pg_temp.fx(106), '{roles.manage,internal_users.manage}'));
  r := r || jsonb_build_object('K10_manager_attaches_held_keys_to_other_role', pg_temp.pass(s LIKE '{%"success": true}', s));

  -- ================= can_grant_role (caller-bound) =================
  s := pg_temp.call_as(uM, format('SELECT to_jsonb(ARRAY[public.can_grant_role(%L), public.can_grant_role(%L), public.can_grant_role(%L), public.can_grant_role(%L), public.can_grant_role(%L)])',
                       pg_temp.fx(102), pg_temp.fx(103), r_sa, pg_temp.fx(104), pg_temp.fx(101)));
  s2 := pg_temp.call_as(uA, format('SELECT to_jsonb(ARRAY[public.can_grant_role(%L), public.can_grant_role(%L), public.can_grant_role(%L), public.can_grant_role(%L), public.can_grant_role(%L)])',
                       pg_temp.fx(102), pg_temp.fx(103), r_sa, pg_temp.fx(104), pg_temp.fx(101)));
  r := r || jsonb_build_object('G1_can_grant_role_matrix', pg_temp.pass(
    s = '[true, false, false, false, false]' AND s2 = '[true, true, true, true, true]', 'M ' || s || ' A ' || s2));

  -- ================= one refusal =================
  r := r || jsonb_build_object('X1_one_refusal_everywhere', pg_temp.pass(
    cardinality(refusals) >= 25 AND (SELECT count(DISTINCT x) FROM unnest(refusals) x) = 1 AND refusals[1] = NP,
    cardinality(refusals) || ' refusals: ' || (SELECT string_agg(DISTINCT x, ' || ') FROM unnest(refusals) x)));
  s := pg_temp.call_rb(uM, format(add_q, 'p4168-unknown@example.test', 'super-admin'));
  s2 := pg_temp.call_rb(uM, format(add_q, 'p4168-8@example.test', 'super-admin'));
  r := r || jsonb_build_object('X2_unknown_and_known_email_refused_alike', pg_temp.pass(s = s2 AND s = NP, s || ' / ' || s2));

  -- ================= catalog =================
  n := (SELECT count(*) FROM unnest(allf) f JOIN pg_proc p ON p.oid = f::regprocedure
         WHERE p.prosecdef AND p.proconfig = ARRAY['search_path=public']
           AND NOT has_function_privilege('anon', p.oid, 'EXECUTE')
           AND NOT EXISTS (SELECT 1 FROM aclexplode(p.proacl) a WHERE a.grantee = 0)
           AND has_function_privilege('authenticated', p.oid, 'EXECUTE') = (f = ANY(pub))
           AND has_function_privilege('service_role', p.oid, 'EXECUTE') = (f <> ALL(priv)));
  r := r || jsonb_build_object('Z1_execute_grants', pg_temp.pass(n = 11,
    n || ' of 11 compliant; ' || (SELECT string_agg(f || '=' || coalesce(p.proacl::text, 'null'), ' ') FROM unnest(allf) f JOIN pg_proc p ON p.oid = f::regprocedure)));
  s := (SELECT string_agg(policyname || ':' || cmd || ':' || roles::text, ',' ORDER BY policyname)
          FROM pg_policies WHERE schemaname = 'public' AND tablename = 'pending_internal_invitations');
  ok := s = 'internal_managers_insert_invitations:INSERT:{authenticated},internal_managers_remove_invitations:DELETE:{authenticated},'
            'internal_managers_update_invitations:UPDATE:{authenticated},internal_users_read_invitations:SELECT:{authenticated},'
            'service_role_full_access_invitations:ALL:{service_role},users_can_delete_own_invitation:DELETE:{public},'
            'users_can_read_own_invitation:SELECT:{public}'
        AND (SELECT with_check FROM pg_policies WHERE schemaname = 'public' AND policyname = 'internal_managers_insert_invitations') LIKE '%can_grant_role(role_id)%invited_by = ( SELECT auth.uid()%'
        AND (SELECT with_check FROM pg_policies WHERE schemaname = 'public' AND policyname = 'internal_managers_update_invitations') LIKE '%can_grant_role(role_id)%invited_by = ( SELECT auth.uid()%'
        AND (SELECT qual FROM pg_policies WHERE schemaname = 'public' AND policyname = 'internal_managers_update_invitations') LIKE '%internal_users.manage%can_grant_role(role_id)%'
        AND (SELECT qual FROM pg_policies WHERE schemaname = 'public' AND policyname = 'internal_managers_remove_invitations') LIKE '%internal_users.manage%';
  r := r || jsonb_build_object('Z2_invitation_policies', pg_temp.pass(ok, s));

  -- ================= re-apply changes nothing =================
  d0 := (SELECT string_agg(md5(p.prosrc), ',' ORDER BY f) FROM unnest(allf) f JOIN pg_proc p ON p.oid = f::regprocedure);
  a0 := (SELECT string_agg(coalesce(p.proacl::text, 'null'), ',' ORDER BY f) FROM unnest(allf) f JOIN pg_proc p ON p.oid = f::regprocedure);
  p0 := (SELECT string_agg(policyname || cmd || coalesce(qual, '') || coalesce(with_check, ''), ',' ORDER BY policyname) FROM pg_policies WHERE schemaname = 'public' AND tablename = 'pending_internal_invitations');
  BEGIN
    EXECUTE $mg$__MIGRATION__$mg$;
    s := CASE WHEN (SELECT string_agg(md5(p.prosrc), ',' ORDER BY f) FROM unnest(allf) f JOIN pg_proc p ON p.oid = f::regprocedure) = d0
               AND (SELECT string_agg(coalesce(p.proacl::text, 'null'), ',' ORDER BY f) FROM unnest(allf) f JOIN pg_proc p ON p.oid = f::regprocedure) = a0
               AND (SELECT string_agg(policyname || cmd || coalesce(qual, '') || coalesce(with_check, ''), ',' ORDER BY policyname) FROM pg_policies WHERE schemaname = 'public' AND tablename = 'pending_internal_invitations') = p0
          THEN 'same' ELSE 'changed' END;
    RAISE EXCEPTION 'RB_DONE' USING DETAIL = s;
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM = 'RB_DONE' THEN GET STACKED DIAGNOSTICS s = PG_EXCEPTION_DETAIL;
    ELSE s := 'ERR ' || SQLSTATE || ' ' || left(SQLERRM, 80); END IF;
  END;
  r := r || jsonb_build_object('K16_reapply_idempotent', pg_temp.pass(s = 'same', s));

  -- ================= rollback restores the pre-migration state =================
  BEGIN
    EXECUTE $rb$__ROLLBACK__$rb$;
    s := CASE WHEN (SELECT string_agg(p.proname || '=' || md5(p.prosrc), ',' ORDER BY p.proname) FROM pg_proc p
                     WHERE p.pronamespace = 'public'::regnamespace
                       AND p.proname IN ('admin_add_internal_user','admin_update_internal_user_role','admin_remove_internal_user','admin_create_role','admin_update_role_permissions'))
                   = 'admin_add_internal_user=d104c223d7e75ee270540b044203e9cd,admin_create_role=40b964203481ae5d739cf5b1ca9733ad,'
                     'admin_remove_internal_user=8f5c1432b733e4f8bf0eb135ef9cd469,admin_update_internal_user_role=fb28ab2dde65e03161d4cce1e31129d5,'
                     'admin_update_role_permissions=b0224e6582ddcf933f9e48dafd513454'
               AND to_regprocedure(acc) IS NULL
               AND to_regprocedure('public.can_grant_role(uuid)') IS NULL
               AND NOT EXISTS (SELECT 1 FROM unnest(priv) x WHERE to_regprocedure(x) IS NOT NULL)
               AND (SELECT string_agg(policyname || ':' || cmd, ',' ORDER BY policyname) FROM pg_policies WHERE schemaname = 'public' AND tablename = 'pending_internal_invitations')
                   = 'internal_users_can_manage_invitations:ALL,service_role_full_access_invitations:ALL,users_can_delete_own_invitation:DELETE,users_can_read_own_invitation:SELECT'
               AND NOT has_function_privilege('anon', 'public.admin_add_internal_user(text,text)'::regprocedure, 'EXECUTE')
               AND (SELECT bool_and(has_function_privilege('anon', x::regprocedure, 'EXECUTE')) FROM unnest(pub[2:7]) x)
               AND NOT EXISTS (SELECT 1 FROM supabase_migrations.schema_migrations WHERE version = '20261107100000')
          THEN 'restored' ELSE 'not restored' END;
    RAISE EXCEPTION 'RB_DONE' USING DETAIL = s;
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM = 'RB_DONE' THEN GET STACKED DIAGNOSTICS s = PG_EXCEPTION_DETAIL;
    ELSE s := 'ERR ' || SQLSTATE || ' ' || left(SQLERRM, 80); END IF;
  END;
  r := r || jsonb_build_object('K17_rollback_restores', pg_temp.pass(s = 'restored', s));

  RETURN r;
END $f$;

DO $drv$
DECLARE v_r jsonb;
BEGIN
  v_r := pg_temp.run();
  RAISE EXCEPTION 'P4168_RESULT %', jsonb_build_object(
    'total', (SELECT count(*) FROM jsonb_each_text(v_r)),
    'pass', (SELECT count(*) FROM jsonb_each_text(v_r) e WHERE e.value = 'PASS'),
    'fail', (SELECT count(*) FROM jsonb_each_text(v_r) e WHERE e.value <> 'PASS'),
    'reds', (SELECT coalesce(jsonb_object_agg(e.key, e.value), '{}'::jsonb) FROM jsonb_each_text(v_r) e WHERE e.value <> 'PASS'));
END
$drv$;
