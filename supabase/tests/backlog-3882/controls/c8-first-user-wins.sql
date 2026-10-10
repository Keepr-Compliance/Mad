-- BACKLOG-3096 behaviour with matching identities: first caller admin, the
-- next colleague the default role, unclaimed invites do not count, an existing
-- member keeps their role. The row lock is proved by race.sh (a second
-- session), not here: xmax is also set by the KEY SHARE lock the membership
-- INSERT's foreign key takes, so it cannot tell FOR UPDATE apart.
SELECT pg_temp.want('c8 first caller admin', pg_temp.provision(pg_temp.id('u_a1'), pg_temp.tid('t_a')), '~^OK .*"role": "admin"');
SELECT pg_temp.want('c8 second colleague gets the default role', pg_temp.provision(pg_temp.id('u_a2'), pg_temp.tid('t_a')), '~^OK .*"role": "agent"');
SELECT pg_temp.want('c8 stored roles', pg_temp.role_in(pg_temp.id('u_a1'), pg_temp.tid('t_a')) || ',' || pg_temp.role_in(pg_temp.id('u_a2'), pg_temp.tid('t_a')), 'admin,agent');
SELECT pg_temp.want('c8 pre-created org with unclaimed invites: first caller admin', pg_temp.provision(pg_temp.id('u_p'), pg_temp.tid('t_p')), '~^OK .*"role": "admin"');
SELECT pg_temp.want('c8 existing admin of org_b keeps admin', pg_temp.provision(pg_temp.id('u_badmin'), pg_temp.tid('t_b')), '~^OK .*"role": "admin"');
SELECT pg_temp.want('c8 org_b still one member',
  (SELECT count(*)::text FROM public.organization_members WHERE organization_id = pg_temp.id('org_b')), '1');
