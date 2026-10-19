-- D01 (3938): no caller learns another user's memberships. "Closed" = 0 rows / false,
-- or a permission error on a direct call (either one answers nothing about another user).
DO $$ DECLARE m text; BEGIN
  m := pg_temp.as_role('anon', NULL, $q$select (select count(*) from public.get_user_org_ids('{u_s}'))$q$);
  PERFORM pg_temp.check('d01 anon get_user_org_ids(other) closed', m = 'OK 0' OR m LIKE 'ERR 42501%', m);
  m := pg_temp.as_role('anon', NULL, $q$select public.is_org_admin('{u_a}', '{org1}')$q$);
  PERFORM pg_temp.check('d01 anon is_org_admin(other) closed', m = 'OK false' OR m LIKE 'ERR 42501%', m);
  m := pg_temp.as_user('u_g', $q$select (select count(*) from public.get_user_org_ids('{u_s}'))$q$);
  PERFORM pg_temp.check('d01 signed-in get_user_org_ids(other) closed', m = 'OK 0' OR m LIKE 'ERR 42501%', m);
  m := pg_temp.as_user('u_g', $q$select public.is_org_admin('{u_a}', '{org1}')$q$);
  PERFORM pg_temp.check('d01 signed-in is_org_admin(other) closed', m = 'OK false' OR m LIKE 'ERR 42501%', m);
  -- same-org pairs (SR R3): the asker shares the target's organization.
  m := pg_temp.as_user('u_a', $q$select (select count(*) from public.get_user_org_ids('{u_g}'))$q$);
  PERFORM pg_temp.check('d01 same-org admin get_user_org_ids(agent) closed', m = 'OK 0' OR m LIKE 'ERR 42501%', m);
  m := pg_temp.as_user('u_g', $q$select (select count(*) from public.get_user_org_ids('{u_a}'))$q$);
  PERFORM pg_temp.check('d01 same-org agent get_user_org_ids(admin) closed', m = 'OK 0' OR m LIKE 'ERR 42501%', m);
  m := pg_temp.as_user('u_a', $q$select public.is_org_admin('{u_ta}', '{org1}')$q$);
  PERFORM pg_temp.check('d01 admin asks is_org_admin(fellow admin) closed', m = 'OK false' OR m LIKE 'ERR 42501%', m);
  m := pg_temp.as_user('u_ta', $q$select public.is_org_admin('{u_a}', '{org1}')$q$);
  PERFORM pg_temp.check('d01 it_admin asks is_org_admin(fellow admin) closed', m = 'OK false' OR m LIKE 'ERR 42501%', m);
  m := pg_temp.as_user('u_a', $q$select public.is_org_admin('{u_g}', '{org1}')$q$);
  PERFORM pg_temp.check('d01 admin asks is_org_admin(agent) = false', m = 'OK false' OR m LIKE 'ERR 42501%', m);
  -- positives: own id still answers
  m := pg_temp.as_user('u_a', $q$select (select count(*) from public.get_user_org_ids('{u_a}'))$q$);
  PERFORM pg_temp.check('d01 own get_user_org_ids = 1', m = 'OK 1', m);
  m := pg_temp.as_user('u_s', $q$select (select string_agg(x::text, ',') from public.get_user_org_ids('{u_s}') x)$q$);
  PERFORM pg_temp.check('d01 own get_user_org_ids active-only = org2', m = 'OK {org2}', m);
  m := pg_temp.as_user('u_a', $q$select public.is_org_admin('{u_a}', '{org1}')$q$);
  PERFORM pg_temp.check('d01 own is_org_admin = true', m = 'OK true', m);
  m := pg_temp.as_user('u_g', $q$select public.is_org_admin('{u_g}', '{org1}')$q$);
  PERFORM pg_temp.check('d01 own is_org_admin as agent = false', m = 'OK false', m);
  m := pg_temp.as_user('u_s', $q$select public.is_org_admin('{u_s}', '{org1}')$q$);
  PERFORM pg_temp.check('d01 own is_org_admin as suspended admin = false', m = 'OK false', m);
END $$;
