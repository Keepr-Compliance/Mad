-- r05 after M1 + M3 + rollback-3851-m3.sql: the seat trigger is the M1 body again, the M3
-- helper is gone, and a scim INSERT into a full organization is written 'unassigned' (M1).
SELECT pg_temp.check('r05 seat trigger body is the M1 body (md5 36378add)',
  (SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public._enforce_member_seat_limit()'::regprocedure) = '36378addf67c120c00e4aa5a4afeb662',
  (SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public._enforce_member_seat_limit()'::regprocedure));
SELECT pg_temp.check('r05 member_origin_joins_unlicensed dropped',
  to_regprocedure('public.member_origin_joins_unlicensed(text)') IS NULL, NULL);
SELECT pg_temp.check('r05 seat trigger ACL unchanged (service_role only, SECURITY DEFINER)',
  (SELECT prosecdef FROM pg_proc WHERE oid = 'public._enforce_member_seat_limit()'::regprocedure)
  AND NOT has_function_privilege('authenticated', 'public._enforce_member_seat_limit()', 'EXECUTE')
  AND has_function_privilege('service_role', 'public._enforce_member_seat_limit()', 'EXECUTE'), NULL);
SELECT pg_temp.check('r05 scim INSERT into full f_org accepted again',
  pg_temp.keep('service_role', NULL, format('insert into public.organization_members (organization_id, user_id, role, license_status, provisioned_by, joined_at) values (%L, %L, %L, %L, %L, now())',
    pg_temp.id('f_org'), pg_temp.id('u_x3'), 'agent', 'active', 'scim')) = 'OK rows=1', NULL);
SELECT pg_temp.check('r05 ... written unassigned (M1 rule)',
  (SELECT license_status FROM public.organization_members WHERE organization_id = pg_temp.id('f_org') AND user_id = pg_temp.id('u_x3')) = 'unassigned', NULL);
