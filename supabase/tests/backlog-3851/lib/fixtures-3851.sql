-- BACKLOG-3851 fixtures (as postgres, BEFORE the stack under test, so the migrations meet
-- existing rows as they would in production). Synthetic users '<name>-3917@example.test';
-- organizations named "Happyhomey Test 3851 ..." (test org naming only; no customer data).
-- Every organization is a brokerage unless named pp_org. Statuses a real writer produces:
-- 'active' / 'pending' / 'suspended' (deactivation) / 'expired' (no writer today; kept as a
-- CHECK value). 'unassigned' does not exist before M1, so controls set it after the stack
-- with pg_temp.set_status (f_un, o_unc, o_tun, o_tunit are 'suspended' until then).
--
-- f_org  max 4, FULL: f_ad admin, f_br broker, f_it it_admin (active, claimed) + f_il a live
--        unclaimed invite = 4 seats. f_ie expired unclaimed invite (no seat under M1, a seat
--        under the old count), f_sus suspended agent, f_un agent (jit origin) set unassigned.
-- o_org  max 20, room to spare: callers o_ad admin, o_br broker, o_it it_admin, o_ag agent
--        (active), o_sad admin suspended, o_unc broker set unassigned; targets o_tact agent
--        active, o_tun agent set unassigned, o_tpen pending unclaimed invite, o_tsus agent
--        suspended, o_texp agent expired, o_tit it_admin active, o_tbr broker active,
--        o_tunit it_admin set unassigned.
-- w_org  max 2, white-glove: two live unclaimed invites (w_i1, w_i2), no claimed member.
-- x_org  max 2: x_ad admin active + x_ie expired unclaimed invite (full under the old count).
-- m2_org max 5: two admins only (m2_a1, m2_a2).
-- pp_org u_pp's personal organization.
-- Tenants (auto_provision_it_admin): f_org t_f, o_org t_o, w_org t_w.
DO $fx$
DECLARE n text;
BEGIN
  FOREACH n IN ARRAY ARRAY['u_fad','u_fbr','u_fit','u_fil','u_fsus','u_fun',
    'u_oad','u_obr','u_oit','u_oag','u_osad','u_ounc','u_otact','u_otun','u_otsus','u_otexp','u_otit','u_otbr','u_otunit',
    'u_w1','u_w2','u_xad','u_m1','u_m2','u_pp','u_x1','u_x2','u_x3','u_x4','u_n','u_st','u_w3','u_w4'] LOOP
    PERFORM pg_temp.mk_user3851(n);
  END LOOP;
  PERFORM pg_temp.mk_azure3851('u_fil', 't_f');
  PERFORM pg_temp.mk_azure3851('u_x1', 't_f');
  PERFORM pg_temp.mk_azure3851('u_x2', 't_o');
  PERFORM pg_temp.mk_azure3851('u_n', 't_o');
  PERFORM pg_temp.mk_azure3851('u_w1', 't_w');
  PERFORM pg_temp.mk_azure3851('u_w2', 't_w');
  PERFORM pg_temp.mk_azure3851('u_w3', 't_w2');
  PERFORM pg_temp.mk_azure3851('u_w4', 't_w2');
END $fx$;

INSERT INTO public.organizations (id, name, slug, max_seats, microsoft_tenant_id) VALUES
  (pg_temp.id('f_org'),  'Happyhomey Test 3851 F', 'happyhomey-test-3851-f', 4,  pg_temp.tid('t_f')),
  (pg_temp.id('o_org'),  'Happyhomey Test 3851 O', 'happyhomey-test-3851-o', 20, pg_temp.tid('t_o')),
  (pg_temp.id('w_org'),  'Happyhomey Test 3851 W', 'happyhomey-test-3851-w', 2,  pg_temp.tid('t_w')),
  (pg_temp.id('x_org'),  'Happyhomey Test 3851 X', 'happyhomey-test-3851-x', 2,  NULL),
  (pg_temp.id('m2_org'), 'Happyhomey Test 3851 M', 'happyhomey-test-3851-m', 5,  NULL);
INSERT INTO public.organizations (id, name, slug, max_seats, personal_owner_user_id) VALUES
  (pg_temp.id('pp_org'), 'Personal', 'personal-3851-pp', 1, pg_temp.id('u_pp'));

INSERT INTO public.organization_members (id, organization_id, user_id, role, license_status, provisioned_by, joined_at) VALUES
  (pg_temp.id('f_ad'),  pg_temp.id('f_org'), pg_temp.id('u_fad'),  'admin',    'active',    'manual', now()),
  (pg_temp.id('f_br'),  pg_temp.id('f_org'), pg_temp.id('u_fbr'),  'broker',   'active',    'invite', now()),
  (pg_temp.id('f_it'),  pg_temp.id('f_org'), pg_temp.id('u_fit'),  'it_admin', 'active',    'manual', now()),
  (pg_temp.id('f_sus'), pg_temp.id('f_org'), pg_temp.id('u_fsus'), 'agent',    'suspended', 'invite', now()),
  (pg_temp.id('f_un'),  pg_temp.id('f_org'), pg_temp.id('u_fun'),  'agent',    'suspended', 'jit',    now()),
  (pg_temp.id('o_ad'),  pg_temp.id('o_org'), pg_temp.id('u_oad'),  'admin',    'active',    'manual', now()),
  (pg_temp.id('o_br'),  pg_temp.id('o_org'), pg_temp.id('u_obr'),  'broker',   'active',    'invite', now()),
  (pg_temp.id('o_it'),  pg_temp.id('o_org'), pg_temp.id('u_oit'),  'it_admin', 'active',    'manual', now()),
  (pg_temp.id('o_ag'),  pg_temp.id('o_org'), pg_temp.id('u_oag'),  'agent',    'active',    'invite', now()),
  (pg_temp.id('o_sad'), pg_temp.id('o_org'), pg_temp.id('u_osad'), 'admin',    'suspended', 'invite', now()),
  (pg_temp.id('o_unc'), pg_temp.id('o_org'), pg_temp.id('u_ounc'), 'broker',   'suspended', 'invite', now()),
  (pg_temp.id('o_tact'),pg_temp.id('o_org'), pg_temp.id('u_otact'),'agent',    'active',    'invite', now()),
  (pg_temp.id('o_tun'), pg_temp.id('o_org'), pg_temp.id('u_otun'), 'agent',    'suspended', 'jit',    now()),
  (pg_temp.id('o_tsus'),pg_temp.id('o_org'), pg_temp.id('u_otsus'),'agent',    'suspended', 'invite', now()),
  (pg_temp.id('o_texp'),pg_temp.id('o_org'), pg_temp.id('u_otexp'),'agent',    'expired',   'invite', now()),
  (pg_temp.id('o_tit'), pg_temp.id('o_org'), pg_temp.id('u_otit'), 'it_admin', 'active',    'manual', now()),
  (pg_temp.id('o_tbr'), pg_temp.id('o_org'), pg_temp.id('u_otbr'), 'broker',   'active',    'invite', now()),
  (pg_temp.id('o_tunit'),pg_temp.id('o_org'),pg_temp.id('u_otunit'),'it_admin','suspended', 'jit',    now()),
  (pg_temp.id('x_ad'),  pg_temp.id('x_org'), pg_temp.id('u_xad'),  'admin',    'active',    'manual', now()),
  (pg_temp.id('m2_a1'), pg_temp.id('m2_org'),pg_temp.id('u_m1'),   'admin',    'active',    'manual', now()),
  (pg_temp.id('m2_a2'), pg_temp.id('m2_org'),pg_temp.id('u_m2'),   'admin',    'active',    'manual', now()),
  (pg_temp.id('pp_m'),  pg_temp.id('pp_org'),pg_temp.id('u_pp'),   'agent',    'active',    NULL,     now());

-- Unclaimed invites (user_id NULL), shaped like inviteUser.ts / admin_invite_user rows.
INSERT INTO public.organization_members (id, organization_id, invited_email, role, license_status, invitation_token, invitation_expires_at, invited_by, provisioned_by) VALUES
  (pg_temp.id('f_il'),  pg_temp.id('f_org'), 'u_fil-3917@example.test', 'agent', 'pending', 'tok-3851-f-il', now() + interval '3 days', pg_temp.id('u_fad'), 'invite'),
  (pg_temp.id('f_ie'),  pg_temp.id('f_org'), 'f-ie-3851@example.test',  'agent', 'pending', 'tok-3851-f-ie', now() - interval '3 days', pg_temp.id('u_fad'), 'invite'),
  (pg_temp.id('o_tpen'),pg_temp.id('o_org'), 'o-tpen-3851@example.test','agent', 'pending', 'tok-3851-o-tp', now() + interval '3 days', pg_temp.id('u_oad'), 'invite'),
  (pg_temp.id('w_i1'),  pg_temp.id('w_org'), 'w-i1-3851@example.test',  'admin', 'pending', 'tok-3851-w-i1', now() + interval '3 days', NULL, 'invite'),
  (pg_temp.id('w_i2'),  pg_temp.id('w_org'), 'w-i2-3851@example.test',  'agent', 'pending', 'tok-3851-w-i2', now() + interval '3 days', NULL, 'invite'),
  (pg_temp.id('x_ie'),  pg_temp.id('x_org'), 'x-ie-3851@example.test',  'agent', 'pending', 'tok-3851-x-ie', now() - interval '3 days', pg_temp.id('u_xad'), 'invite');

-- w2_org (c12, R4 with a deactivated claimed member): max 1, one live invite, one
-- suspended claimed member, no access-granting claimed member.
INSERT INTO public.organizations (id, name, slug, max_seats, microsoft_tenant_id) VALUES
  (pg_temp.id('w2_org'), 'Happyhomey Test 3851 W2', 'happyhomey-test-3851-w2', 1, pg_temp.tid('t_w2'));
INSERT INTO public.organization_members (id, organization_id, user_id, role, license_status, provisioned_by, joined_at) VALUES
  (pg_temp.id('w2_s'), pg_temp.id('w2_org'), pg_temp.id('u_w4'), 'admin', 'suspended', 'invite', now());
INSERT INTO public.organization_members (id, organization_id, invited_email, role, license_status, invitation_token, invitation_expires_at, provisioned_by) VALUES
  (pg_temp.id('w2_i1'), pg_temp.id('w2_org'), 'w2-i1-3851@example.test', 'agent', 'pending', 'tok-3851-w2-i1', now() + interval '3 days', 'invite');

-- u_st: internal staff with users.edit (admin_invite_user's caller).
INSERT INTO public.admin_permissions (key, label, category)
  SELECT 'users.edit', 'users.edit', 'probe'
   WHERE NOT EXISTS (SELECT 1 FROM public.admin_permissions WHERE key = 'users.edit');
INSERT INTO public.admin_roles (id, name, slug, is_system) VALUES (pg_temp.id('strole'), 'Staff 3851', 'staff-3851', false);
INSERT INTO public.admin_role_permissions (role_id, permission_id)
  SELECT pg_temp.id('strole'), id FROM public.admin_permissions WHERE key = 'users.edit';
INSERT INTO public.internal_roles (user_id, role_id) VALUES (pg_temp.id('u_st'), pg_temp.id('strole'));

SELECT 'FIXTURES3851 OK';
