-- c11 a seat-taking UPDATE is never rewritten to 'unassigned': it is refused. The RPC
-- returns seat_limit_reached, not success.
SELECT pg_temp.set_status('f_un', 'unassigned');
SELECT pg_temp.check('c11 assign a jit-origin unassigned member into a full org -> seat_limit_reached',
  pg_temp.sml('u_fad', 'f_un', 'assign') = 'OK seat_limit_reached', pg_temp.sml('u_fad', 'f_un', 'assign'));
SELECT pg_temp.check('c11 RPC result success=false',
  pg_temp.as_user('u_fad', format('select public.set_member_license(%L::uuid, %L) ->> ''success''', pg_temp.id('f_un'), 'assign')) = 'OK false', NULL);
SELECT pg_temp.check('c11 row unchanged', pg_temp.status('f_un') = 'unassigned', pg_temp.status('f_un'));
SELECT pg_temp.check('c11 service_role UPDATE unassigned->active (jit origin) refused, not rewritten',
  pg_temp.as_service(format('update public.organization_members set license_status = %L where id = %L', 'active', pg_temp.id('f_un'))) = 'ERR P0001 seat_limit_reached',
  pg_temp.as_service(format('update public.organization_members set license_status = %L where id = %L', 'active', pg_temp.id('f_un'))));
SELECT pg_temp.check('c11 service_role UPDATE suspended->active (scim-style reactivate) refused',
  pg_temp.as_service(format('update public.organization_members set license_status = %L, provisioned_by = %L where id = %L', 'active', 'scim', pg_temp.id('f_sus'))) = 'ERR P0001 seat_limit_reached', NULL);
