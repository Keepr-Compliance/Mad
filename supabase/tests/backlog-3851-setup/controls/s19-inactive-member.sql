-- S19: a placed admin whose membership is not active (suspended, unassigned, NULL) is
-- refused with membership_inactive and nothing is written, even though each also holds
-- a live admin invite to another brokerage (no tenant).
SELECT pg_temp.mk_org('org_s19', NULL);
SELECT pg_temp.mk_org('org_s19x', NULL);
SELECT pg_temp.mk_user3851('u_s19a'); SELECT pg_temp.mk_user3851('u_s19b'); SELECT pg_temp.mk_user3851('u_s19c');
SELECT pg_temp.mk_member('mb_s19a', 'org_s19', 'u_s19a', 'admin', 'suspended');
SELECT pg_temp.mk_member('mb_s19b', 'org_s19', 'u_s19b', 'admin', 'suspended');
SELECT pg_temp.set_status('mb_s19b', 'unassigned');
SELECT pg_temp.mk_member('mb_s19c', 'org_s19', 'u_s19c', 'admin', 'suspended');
SELECT pg_temp.set_status('mb_s19c', NULL);
SELECT pg_temp.check('S19 fixture statuses suspended / unassigned / NULL',
  (SELECT string_agg(coalesce(license_status, '<null>'), ',' ORDER BY id) FROM public.organization_members WHERE id IN (pg_temp.id('mb_s19a'), pg_temp.id('mb_s19b'), pg_temp.id('mb_s19c')))
  IS NOT NULL AND pg_temp.status('mb_s19a') = 'suspended' AND pg_temp.status('mb_s19b') = 'unassigned' AND pg_temp.status('mb_s19c') IS NULL, NULL);
SELECT pg_temp.mk_invite('i_s19a', 'org_s19x', 'u_s19a-3917@example.test', 'admin');
SELECT pg_temp.mk_invite('i_s19b', 'org_s19x', 'u_s19b-3917@example.test', 'admin');
SELECT pg_temp.mk_invite('i_s19c', 'org_s19x', 'u_s19c-3917@example.test', 'admin');
SELECT pg_temp.mk_azure3851(u, 't_' || u) FROM unnest(ARRAY['u_s19a','u_s19b','u_s19c']) u;
CREATE TEMP TABLE r_s19 AS SELECT u, pg_temp.prov(u, 't_' || u) AS r FROM unnest(ARRAY['u_s19a','u_s19b','u_s19c']) u;
SELECT pg_temp.check('S19 ' || u || ' -> membership_inactive', pg_temp.outcome(r) = 'membership_inactive', r::text) FROM r_s19 ORDER BY u;
SELECT pg_temp.check('S19 org_s19 tenant still NULL', pg_temp.org_tenant('org_s19') = '<null>', pg_temp.org_tenant('org_s19'));
SELECT pg_temp.check('S19 org_s19x tenant still NULL', pg_temp.org_tenant('org_s19x') = '<null>', pg_temp.org_tenant('org_s19x'));
SELECT pg_temp.check('S19 ' || i || ' still pending, unclaimed', pg_temp.row_state(i) = '<null>|pending|false|invite', pg_temp.row_state(i))
  FROM unnest(ARRAY['i_s19a','i_s19b','i_s19c']) i;
SELECT pg_temp.check('S19 memberships unchanged',
  pg_temp.status('mb_s19a') = 'suspended' AND pg_temp.status('mb_s19b') = 'unassigned' AND pg_temp.status('mb_s19c') IS NULL
  AND (SELECT count(*) FROM public.organization_members WHERE user_id IN (pg_temp.id('u_s19a'), pg_temp.id('u_s19b'), pg_temp.id('u_s19c'))) = 3, NULL);
