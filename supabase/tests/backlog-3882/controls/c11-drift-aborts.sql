-- harness: drift
SELECT pg_temp.want('c11 migration aborts on an unexpected body', (SELECT err FROM t3882_err), '~^3882 pre-check: auto_provision_it_admin body differs');
SELECT pg_temp.check('c11 drifted body left in place', pg_temp.fn_md5() NOT IN (pg_temp.prod_md5(), pg_temp.new_md5()), pg_temp.fn_md5());
SELECT pg_temp.want('c11 google grants untouched', pg_temp.grants('auto_provision_google_it_admin'), pg_temp.prod_grants());
