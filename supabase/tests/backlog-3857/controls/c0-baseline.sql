-- harness: baseline
-- C0: before the migration the venue matches production for everything the
-- migration touches.
SELECT pg_temp.want('c0 license_type CHECK is the production one', pg_temp.type_check_def(), pg_temp.prod_check_def());
SELECT pg_temp.want('c0 defaults are the production ones', pg_temp.defaults(), pg_temp.prod_defaults());
SELECT pg_temp.want('c0 admin_update_license body md5 is the production one', pg_temp.fn_md5(), pg_temp.prod_md5());
SELECT pg_temp.want('c0 admin_update_license ACL/secdef/search_path are the production ones', pg_temp.fn_acl(), pg_temp.prod_acl());
