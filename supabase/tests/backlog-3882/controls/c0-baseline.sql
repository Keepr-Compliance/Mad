-- harness: baseline
-- Before the migration: body md5, EXECUTE grants and body behaviour equal
-- production's.
SELECT pg_temp.want('c0 it_admin body md5 is production''s', pg_temp.fn_md5(), pg_temp.prod_md5());
SELECT pg_temp.want('c0 google body md5 is production''s', pg_temp.fn_md5('auto_provision_google_it_admin'), pg_temp.google_md5());
SELECT pg_temp.want('c0 it_admin grants are production''s', pg_temp.grants('auto_provision_it_admin'), pg_temp.prod_grants());
SELECT pg_temp.want('c0 google grants are production''s', pg_temp.grants('auto_provision_google_it_admin'), pg_temp.prod_grants());
SELECT pg_temp.want('c0 baseline: caller with a different tenant gets success', pg_temp.provision(pg_temp.id('u_x'), pg_temp.tid('t_b')), '~^OK .*"success": true');
SELECT pg_temp.want('c0 baseline: caller has role agent in org_b', pg_temp.role_in(pg_temp.id('u_x'), pg_temp.tid('t_b')), 'agent');
