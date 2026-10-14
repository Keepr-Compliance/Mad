-- R01: A + B + C applied, then rollback-A.sql alone. The five guarded helpers' bodies equal
-- production; B's ACLs and policy roles and C's links grants are untouched.
DO $$ DECLARE r record; s text; BEGIN
  FOR r IN SELECT p.k, split_part(p.v,'|',1) prod_md5, split_part(v.v,'|',1) md5, split_part(v.v,'|',2) acl
             FROM pg_temp.prod3946() p JOIN pg_temp.venue3946() v USING (k)
            WHERE p.k IN ('fn has_internal_role(uuid)','fn has_permission(uuid,text)','fn has_any_permission(uuid,text[])','fn is_super_admin(uuid)','fn get_user_permissions(uuid)') LOOP
    PERFORM pg_temp.check('r01 ' || r.k || ' body equals production', r.md5 = r.prod_md5, r.md5);
    PERFORM pg_temp.check('r01 ' || r.k || ' ACL still signed-in only', r.acl = '{authenticated=X/postgres,postgres=X/postgres,service_role=X/postgres}', r.acl);
  END LOOP;
  SELECT count(*)::text INTO s FROM pg_temp.venue3946() WHERE k LIKE 'pol %' AND v LIKE '{public}|%';
  PERFORM pg_temp.check('r01 no helper policy is TO public (B untouched)', s = '0', s);
  s := pg_temp.links_grants3946();
  PERFORM pg_temp.check('r01 links grants unchanged by rollback-A', s = 'authenticated:DELETE,INSERT,SELECT', s);
END $$;
