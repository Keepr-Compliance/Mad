-- c03 identity-provider joins: a jit INSERT into a full organization is written
-- 'unassigned'; with a free seat it is 'active'; a scim or non-IdP INSERT is refused (M3).
-- Main leg: auto_provision_it_admin (the /setup callback, the only live IdP join).
SELECT pg_temp.check('c03 f_org full', pg_temp.seats('f_org') = 4, NULL);
CREATE TEMP TABLE t03 ON COMMIT DROP AS SELECT pg_temp.provision3851('u_x1', 't_f') AS r;
SELECT pg_temp.check('c03 /setup join into a full org succeeds', (SELECT r ->> 'success' FROM t03) = 'true', (SELECT r::text FROM t03));
SELECT pg_temp.check('c03 ... as unassigned, no license_assigned_at',
  (SELECT license_status = 'unassigned' AND license_assigned_at IS NULL AND provisioned_by = 'jit'
     FROM public.organization_members WHERE organization_id = pg_temp.id('f_org') AND user_id = pg_temp.id('u_x1')),
  (SELECT license_status FROM public.organization_members WHERE organization_id = pg_temp.id('f_org') AND user_id = pg_temp.id('u_x1')));
SELECT pg_temp.check('c03 seats unchanged', pg_temp.seats('f_org') = 4, pg_temp.seats('f_org')::text);

CREATE TEMP TABLE t03b ON COMMIT DROP AS SELECT pg_temp.provision3851('u_x2', 't_o') AS r;
SELECT pg_temp.check('c03 /setup join with a free seat -> active with license_assigned_at',
  (SELECT license_status = 'active' AND license_assigned_at IS NOT NULL
     FROM public.organization_members WHERE organization_id = pg_temp.id('o_org') AND user_id = pg_temp.id('u_x2')),
  (SELECT r::text FROM t03b));

-- service_role SCIM-origin INSERT into the full org -> refused (M3, BACKLOG-3851 PR-2c;
-- before M3 it was written 'unassigned'). c19 covers the SCIM paths in full.
SELECT pg_temp.check('c03 service_role scim INSERT into the full org refused',
  pg_temp.as_service(format('insert into public.organization_members (organization_id, user_id, role, license_status, provisioned_by, joined_at) values (%L, %L, %L, %L, %L, now())',
    pg_temp.id('f_org'), pg_temp.id('u_x3'), 'agent', 'active', 'scim')) = 'ERR P0001 seat_limit_reached', NULL);
SELECT pg_temp.check('c03 ... no scim row written',
  NOT EXISTS (SELECT 1 FROM public.organization_members WHERE organization_id = pg_temp.id('f_org') AND user_id = pg_temp.id('u_x3')), NULL);
-- jit_join_organization (unreachable today; pins the trigger behaviour only).
SELECT pg_temp.check('c03 jit_join_organization into the full org succeeds',
  pg_temp.keep('service_role', 'u_n', format('select public.jit_join_organization(%L) ->> ''success''', pg_temp.tid('t_f'))) = 'OK true', NULL);
SELECT pg_temp.check('c03 ... written unassigned',
  (SELECT license_status FROM public.organization_members WHERE organization_id = pg_temp.id('f_org') AND user_id = pg_temp.id('u_n')) = 'unassigned', NULL);
-- Non-IdP INSERTs are refused, not rewritten.
SELECT pg_temp.check('c03 service_role manual-origin active INSERT into the full org refused',
  pg_temp.as_service(format('insert into public.organization_members (organization_id, user_id, role, license_status, provisioned_by) values (%L, %L, %L, %L, %L)',
    pg_temp.id('f_org'), pg_temp.id('u_x4'), 'agent', 'active', 'manual')) = 'ERR P0001 seat_limit_reached', NULL);
SELECT pg_temp.check('c03 service_role NULL-origin active INSERT into the full org refused',
  pg_temp.as_service(format('insert into public.organization_members (organization_id, user_id, role, license_status) values (%L, %L, %L, %L)',
    pg_temp.id('f_org'), pg_temp.id('u_x4'), 'agent', 'active')) = 'ERR P0001 seat_limit_reached', NULL);
SELECT pg_temp.check('c03 seats still 4', pg_temp.seats('f_org') = 4, pg_temp.seats('f_org')::text);
-- directory_sync origin: the provisioned_by CHECK refuses the value today (BACKLOG-3950);
-- c07 pins member_origin_is_idp('directory_sync') = true.
