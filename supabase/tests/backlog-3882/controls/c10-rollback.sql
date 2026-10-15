-- harness: rollback
SELECT pg_temp.want('c10 rollback restores the production body', pg_temp.fn_md5(), pg_temp.prod_md5());
SELECT pg_temp.want('c10 rollback restores it_admin grants', pg_temp.grants('auto_provision_it_admin'), pg_temp.prod_grants());
SELECT pg_temp.want('c10 rollback restores google grants', pg_temp.grants('auto_provision_google_it_admin'), pg_temp.prod_grants());
