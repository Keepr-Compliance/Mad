-- c19 SCIM seat writes (M3, BACKLOG-3851 PR-2c). Stack: M1 + M3 (+ M2 is not needed).
-- Every SCIM write the edge function makes, in its real shape (service_role, provisioned_by
-- 'scim'), against the seat trigger. Fixture people (u_x3, u_x4, u_w3, u_fil) have an
-- auth.users row, i.e. an existing Keepr account (SCIM POST S1). S2's shape (a public.users
-- row with a generated id and no auth.users row) is c19 s2.

-- p1 full organization: a scim INSERT is refused and leaves no row.
SELECT pg_temp.check('c19 p1 f_org full', pg_temp.seats('f_org') = 4, pg_temp.seats('f_org')::text);
SELECT pg_temp.check('c19 p1 scim INSERT into full f_org refused',
  pg_temp.as_service(format('insert into public.organization_members (organization_id, user_id, role, license_status, provisioned_by, joined_at) values (%L, %L, %L, %L, %L, now())',
    pg_temp.id('f_org'), pg_temp.id('u_x3'), 'agent', 'active', 'scim')) = 'ERR P0001 seat_limit_reached', NULL);
SELECT pg_temp.check('c19 p1 ... no row for u_x3 in f_org',
  NOT EXISTS (SELECT 1 FROM public.organization_members WHERE organization_id = pg_temp.id('f_org') AND user_id = pg_temp.id('u_x3')), NULL);
SELECT pg_temp.check('c19 p1 ... seats still 4', pg_temp.seats('f_org') = 4, pg_temp.seats('f_org')::text);

-- p2 free seat: a scim INSERT is active with license_assigned_at.
SELECT pg_temp.check('c19 p2 scim INSERT into o_org (free seat) accepted',
  pg_temp.keep('service_role', NULL, format('insert into public.organization_members (organization_id, user_id, role, license_status, provisioned_by, joined_at) values (%L, %L, %L, %L, %L, now())',
    pg_temp.id('o_org'), pg_temp.id('u_x3'), 'agent', 'active', 'scim')) = 'OK rows=1', NULL);
SELECT pg_temp.check('c19 p2 ... active with license_assigned_at',
  (SELECT license_status = 'active' AND license_assigned_at IS NOT NULL
     FROM public.organization_members WHERE organization_id = pg_temp.id('o_org') AND user_id = pg_temp.id('u_x3')), NULL);

-- p3 first-member rule (R4, L9): an organization full of invites with no access-granting
-- claimed member admits its first scim member over the limit by one, and only the first.
SELECT pg_temp.check('c19 p3 R4: first scim INSERT into white-glove w_org accepted',
  pg_temp.keep('service_role', NULL, format('insert into public.organization_members (organization_id, user_id, role, license_status, provisioned_by, joined_at) values (%L, %L, %L, %L, %L, now())',
    pg_temp.id('w_org'), pg_temp.id('u_x4'), 'admin', 'active', 'scim')) = 'OK rows=1', NULL);
SELECT pg_temp.check('c19 p3 ... and active',
  (SELECT license_status FROM public.organization_members WHERE organization_id = pg_temp.id('w_org') AND user_id = pg_temp.id('u_x4')) = 'active',
  (SELECT string_agg(coalesce(user_id::text, '-') || ':' || license_status, ' ') FROM public.organization_members WHERE organization_id = pg_temp.id('w_org')));
SELECT pg_temp.check('c19 p3b second scim INSERT into w_org refused',
  pg_temp.as_service(format('insert into public.organization_members (organization_id, user_id, role, license_status, provisioned_by, joined_at) values (%L, %L, %L, %L, %L, now())',
    pg_temp.id('w_org'), pg_temp.id('u_w3'), 'agent', 'active', 'scim')) = 'ERR P0001 seat_limit_reached', NULL);

-- p4 SCIM reactivation (PATCH active:true on a suspended member) in a full organization.
SELECT pg_temp.check('c19 p4 scim reactivate suspended f_sus in full f_org refused',
  pg_temp.as_service(format('update public.organization_members set license_status = %L, scim_synced_at = now() where id = %L', 'active', pg_temp.id('f_sus'))) = 'ERR P0001 seat_limit_reached', NULL);
SELECT pg_temp.check('c19 p4 ... f_sus still suspended', pg_temp.status('f_sus') = 'suspended', pg_temp.status('f_sus'));

-- p5 SCIM claims an invite instead of inserting beside it.
SELECT pg_temp.check('c19 p5 scim claims live invite f_il in full f_org',
  pg_temp.keep('service_role', NULL, format('update public.organization_members set user_id = %L, license_status = %L, provisioned_by = %L, provisioned_at = now(), joined_at = now(), scim_synced_at = now(), invitation_token = NULL where id = %L and user_id is null',
    pg_temp.id('u_fil'), 'active', 'scim', pg_temp.id('f_il'))) = 'OK rows=1', NULL);
SELECT pg_temp.check('c19 p5 ... seat-neutral: seats still 4', pg_temp.seats('f_org') = 4, pg_temp.seats('f_org')::text);
SELECT pg_temp.check('c19 p5 ... active with license_assigned_at',
  (SELECT license_status = 'active' AND license_assigned_at IS NOT NULL FROM public.organization_members WHERE id = pg_temp.id('f_il')), NULL);
SELECT pg_temp.check('c19 p5b scim claim of the EXPIRED invite f_ie in full f_org refused (it takes a seat)',
  pg_temp.as_service(format('update public.organization_members set user_id = %L, license_status = %L, provisioned_by = %L, joined_at = now() where id = %L and user_id is null',
    pg_temp.id('u_x4'), 'active', 'scim', pg_temp.id('f_ie'))) = 'ERR P0001 seat_limit_reached', NULL);
SELECT pg_temp.check('c19 p5b ... f_ie still unclaimed and pending',
  (SELECT user_id IS NULL AND license_status = 'pending' FROM public.organization_members WHERE id = pg_temp.id('f_ie')), NULL);

-- p6 deactivation always succeeds and frees the seat; the next scim INSERT then fits.
SELECT pg_temp.check('c19 p6 scim suspend f_br (PATCH active:false / DELETE)',
  pg_temp.keep('service_role', NULL, format('update public.organization_members set license_status = %L, scim_synced_at = now() where id = %L', 'suspended', pg_temp.id('f_br'))) = 'OK rows=1', NULL);
SELECT pg_temp.check('c19 p6 ... seats 3', pg_temp.seats('f_org') = 3, pg_temp.seats('f_org')::text);
SELECT pg_temp.check('c19 p6 ... the refused scim INSERT now fits',
  pg_temp.keep('service_role', NULL, format('insert into public.organization_members (organization_id, user_id, role, license_status, provisioned_by, joined_at) values (%L, %L, %L, %L, %L, now())',
    pg_temp.id('f_org'), pg_temp.id('u_x3'), 'agent', 'active', 'scim')) = 'OK rows=1', NULL);
SELECT pg_temp.check('c19 p6 ... active', (SELECT license_status FROM public.organization_members WHERE organization_id = pg_temp.id('f_org') AND user_id = pg_temp.id('u_x3')) = 'active', NULL);

-- p7 the other origins are unchanged: jit is still rewritten, manual is still refused.
SELECT pg_temp.check('c19 p7 f_org full again', pg_temp.seats('f_org') = 4, pg_temp.seats('f_org')::text);
SELECT pg_temp.check('c19 p7 jit INSERT into full f_org accepted',
  pg_temp.keep('service_role', NULL, format('insert into public.organization_members (organization_id, user_id, role, license_status, provisioned_by, joined_at) values (%L, %L, %L, %L, %L, now())',
    pg_temp.id('f_org'), pg_temp.id('u_x2'), 'agent', 'active', 'jit')) = 'OK rows=1', NULL);
SELECT pg_temp.check('c19 p7 ... written unassigned',
  (SELECT license_status FROM public.organization_members WHERE organization_id = pg_temp.id('f_org') AND user_id = pg_temp.id('u_x2')) = 'unassigned', NULL);
SELECT pg_temp.check('c19 p7 manual INSERT into full f_org refused',
  pg_temp.as_service(format('insert into public.organization_members (organization_id, user_id, role, license_status, provisioned_by, joined_at) values (%L, %L, %L, %L, %L, now())',
    pg_temp.id('f_org'), pg_temp.id('u_x1'), 'agent', 'active', 'manual')) = 'ERR P0001 seat_limit_reached', NULL);

-- s2 SCIM POST for a brand-new email (users.ts S2): a public.users row with a generated id
-- and no auth.users row. Full organization: the seat trigger refuses first (P0001). Free
-- organization: the auth.users foreign key refuses (23503). No membership either way.
INSERT INTO public.users (email, oauth_provider, oauth_id, provisioning_source, is_managed, status, is_active)
VALUES ('c19-s2-3851@example.test', 'azure', 'c19-s2-ext', 'scim', true, 'active', true);
SELECT pg_temp.check('c19 s2 the generated users.id has no auth.users row',
  NOT EXISTS (SELECT 1 FROM auth.users a JOIN public.users u ON u.id = a.id WHERE u.email = 'c19-s2-3851@example.test'), NULL);
SELECT pg_temp.check('c19 s2 new-email membership into full f_org refused by the seat rule',
  pg_temp.as_service(format('insert into public.organization_members (organization_id, user_id, role, license_status, provisioned_by, joined_at) values (%L, %L, %L, %L, %L, now())',
    pg_temp.id('f_org'), (SELECT id FROM public.users WHERE email = 'c19-s2-3851@example.test'), 'agent', 'active', 'scim')) = 'ERR P0001 seat_limit_reached', NULL);
SELECT pg_temp.check('c19 s2 new-email membership into o_org (free) refused by the auth.users key',
  pg_temp.as_service(format('insert into public.organization_members (organization_id, user_id, role, license_status, provisioned_by, joined_at) values (%L, %L, %L, %L, %L, now())',
    pg_temp.id('o_org'), (SELECT id FROM public.users WHERE email = 'c19-s2-3851@example.test'), 'agent', 'active', 'scim')) LIKE 'ERR 23503%', NULL);
SELECT pg_temp.check('c19 s2 ... no membership for the new email',
  NOT EXISTS (SELECT 1 FROM public.organization_members m JOIN public.users u ON u.id = m.user_id WHERE u.email = 'c19-s2-3851@example.test'), NULL);
SELECT pg_temp.check('c19 s2 the fresh users row can be removed (nothing references it)',
  pg_temp.as_service('delete from public.users where email = ''c19-s2-3851@example.test''') = 'OK rows=1', NULL);

-- h helper: corpus and grants. Written so a stack without M3 reds (helper absent) instead
-- of stopping psql: the helper is called through pg_temp.keep, privileges by oid.
SELECT pg_temp.check('c19 h member_origin_joins_unlicensed corpus',
  pg_temp.keep('service_role', NULL, 'select public.member_origin_joins_unlicensed(''jit'') AND public.member_origin_joins_unlicensed(''directory_sync'')
    AND NOT public.member_origin_joins_unlicensed(''scim'') AND NOT public.member_origin_joins_unlicensed(''manual'')
    AND NOT public.member_origin_joins_unlicensed(''invite'') AND NOT coalesce(public.member_origin_joins_unlicensed(NULL), true)
    AND NOT public.member_origin_joins_unlicensed(''bogus'')') = 'OK true', NULL);
SELECT pg_temp.check('c19 h member_origin_is_idp unchanged (scim is still an IdP origin)',
  public.member_origin_is_idp('scim') AND public.member_origin_is_idp('jit') AND public.member_origin_is_idp('directory_sync'), NULL);
SELECT pg_temp.check('c19 h helper EXECUTE: anon no, PUBLIC no, authenticated yes, service_role yes',
  coalesce((SELECT NOT has_function_privilege('anon', p.oid, 'EXECUTE')
     AND NOT EXISTS (SELECT 1 FROM aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a WHERE a.grantee = 0)
     AND has_function_privilege('authenticated', p.oid, 'EXECUTE')
     AND has_function_privilege('service_role', p.oid, 'EXECUTE')
     FROM pg_proc p WHERE p.oid = to_regprocedure('public.member_origin_joins_unlicensed(text)')), false), NULL);
SELECT pg_temp.check('c19 h helper is IMMUTABLE, SECURITY INVOKER, search_path empty',
  coalesce((SELECT provolatile = 'i' AND NOT prosecdef AND proconfig = ARRAY['search_path=""']
     FROM pg_proc WHERE oid = to_regprocedure('public.member_origin_joins_unlicensed(text)')), false),
  (SELECT provolatile::text || ' ' || prosecdef::text || ' ' || coalesce(array_to_string(proconfig, ','), '-')
     FROM pg_proc WHERE oid = to_regprocedure('public.member_origin_joins_unlicensed(text)')));
SELECT pg_temp.check('c19 h seat trigger body is the M3 body',
  (SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public._enforce_member_seat_limit()'::regprocedure) = '2080be6b61fb35e5e3b933bf88f71c00',
  (SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public._enforce_member_seat_limit()'::regprocedure));
SELECT pg_temp.check('c19 h seat trigger ACL and flags unchanged (service_role only, SECURITY DEFINER, VOLATILE)',
  (SELECT prosecdef AND provolatile = 'v' FROM pg_proc WHERE oid = 'public._enforce_member_seat_limit()'::regprocedure)
  AND NOT has_function_privilege('authenticated', 'public._enforce_member_seat_limit()', 'EXECUTE')
  AND NOT has_function_privilege('anon', 'public._enforce_member_seat_limit()', 'EXECUTE')
  AND has_function_privilege('service_role', 'public._enforce_member_seat_limit()', 'EXECUTE'), NULL);
