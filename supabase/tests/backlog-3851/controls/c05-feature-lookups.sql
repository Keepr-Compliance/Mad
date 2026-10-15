-- c05 get_org_features / check_feature_access answer only for an access-granting
-- membership: active yes; suspended, expired, unassigned not_authorized.
SELECT pg_temp.set_status('o_tun', 'unassigned');
CREATE TEMP TABLE t05 (u text, want_ok boolean) ON COMMIT DROP;
INSERT INTO t05 VALUES ('u_oag', true), ('u_oad', true), ('u_otsus', false), ('u_otexp', false), ('u_otun', false), ('u_fad', false);
SELECT pg_temp.check('c05 get_org_features as ' || u,
  (pg_temp.as_user(u, format('select public.get_org_features(%L::uuid) ->> ''error''', pg_temp.id('o_org'))) = 'OK not_authorized') = NOT want_ok,
  pg_temp.as_user(u, format('select public.get_org_features(%L::uuid) ->> ''error''', pg_temp.id('o_org'))))
  FROM t05;
SELECT pg_temp.check('c05 check_feature_access as ' || u,
  (pg_temp.as_user(u, format('select public.check_feature_access(%L::uuid, %L) ->> ''error''', pg_temp.id('o_org'), 'probe_3851')) = 'OK not_authorized') = NOT want_ok,
  pg_temp.as_user(u, format('select public.check_feature_access(%L::uuid, %L) ->> ''error''', pg_temp.id('o_org'), 'probe_3851')))
  FROM t05;
SELECT pg_temp.check('c05 active answer carries features',
  pg_temp.as_user('u_oag', format('select (public.get_org_features(%L::uuid) ? ''features'')::text', pg_temp.id('o_org'))) = 'OK true', NULL);
SELECT pg_temp.check('c05 personal org member still answered',
  pg_temp.as_user('u_pp', format('select public.get_org_features(%L::uuid) ->> ''error''', pg_temp.id('pp_org'))) = 'OK <null>', NULL);
