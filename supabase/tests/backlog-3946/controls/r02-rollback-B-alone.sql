-- R02: A + B + C applied, then rollback-B.sql alone. The seven helpers' ACLs and the 28
-- helper policies equal production; A's bodies and C's links grants are untouched.
DO $$ DECLARE r record; s text; BEGIN
  FOR r IN SELECT p.k, split_part(p.v,'|',2) prod_acl, split_part(v.v,'|',2) acl, split_part(p.v,'|',1) prod_md5, split_part(v.v,'|',1) md5
             FROM pg_temp.prod3946() p JOIN pg_temp.venue3946() v USING (k)
            WHERE p.k LIKE 'fn %' AND p.k <> 'fn guard_invite_acceptance()' LOOP
    PERFORM pg_temp.check('r02 ' || r.k || ' ACL equals production', r.acl = r.prod_acl, r.acl);
    IF r.k IN ('fn has_internal_role(uuid)','fn has_permission(uuid,text)','fn has_any_permission(uuid,text[])','fn is_super_admin(uuid)','fn get_user_permissions(uuid)') THEN
      PERFORM pg_temp.check('r02 ' || r.k || ' body still guarded (A untouched)', r.md5 <> r.prod_md5, r.md5);
    END IF;
  END LOOP;
  SELECT coalesce(string_agg(coalesce(p.k, v.k), ', '), '') INTO s
    FROM (SELECT * FROM pg_temp.prod3946() WHERE k LIKE 'pol %') p FULL JOIN (SELECT * FROM pg_temp.venue3946() WHERE k LIKE 'pol %') v USING (k)
   WHERE p.v IS DISTINCT FROM v.v;
  PERFORM pg_temp.check('r02 every helper policy equals production', s = '', s);
  s := pg_temp.links_grants3946();
  PERFORM pg_temp.check('r02 links grants unchanged by rollback-B', s = 'authenticated:DELETE,INSERT,SELECT', s);
END $$;
