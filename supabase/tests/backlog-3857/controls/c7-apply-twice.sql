-- harness: apply-twice
-- C7: a second apply passes its pre-checks and leaves the same end state;
-- privileges on admin_update_license are unchanged from production.
SELECT pg_temp.want('c7 CHECK after two applies', pg_temp.type_check_def(), pg_temp.new_check_def());
SELECT pg_temp.want('c7 defaults after two applies', pg_temp.defaults(), pg_temp.new_defaults());
SELECT pg_temp.want('c7 function body after two applies', pg_temp.fn_md5(), pg_temp.new_md5());
SELECT pg_temp.want('c7 ACL/secdef/search_path unchanged', pg_temp.fn_acl(), pg_temp.prod_acl());
