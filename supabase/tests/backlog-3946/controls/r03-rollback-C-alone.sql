-- R03: A + B + C applied, then rollback-C.sql alone. Links grants equal production; A's
-- bodies and B's ACLs and policy roles are untouched.
DO $$ DECLARE s text; BEGIN
  s := pg_temp.links_grants3946();
  PERFORM pg_temp.check('r03 links grants equal production', s = 'anon:DELETE,INSERT,REFERENCES,SELECT,TRIGGER,UPDATE authenticated:DELETE,INSERT,REFERENCES,SELECT,TRIGGER,UPDATE', s);
  SELECT count(*)::text INTO s FROM pg_temp.prod3946() p JOIN pg_temp.venue3946() v USING (k)
   WHERE p.k IN ('fn has_internal_role(uuid)','fn has_permission(uuid,text)','fn has_any_permission(uuid,text[])','fn is_super_admin(uuid)','fn get_user_permissions(uuid)')
     AND split_part(p.v,'|',1) <> split_part(v.v,'|',1);
  PERFORM pg_temp.check('r03 five helper bodies still guarded (A untouched)', s = '5', s);
  SELECT count(*)::text INTO s FROM pg_temp.venue3946() WHERE k LIKE 'fn %' AND k <> 'fn guard_invite_acceptance()'
     AND split_part(v,'|',2) = '{authenticated=X/postgres,postgres=X/postgres,service_role=X/postgres}';
  PERFORM pg_temp.check('r03 seven helper ACLs still signed-in only (B untouched)', s = '7', s);
  SELECT count(*)::text INTO s FROM pg_temp.venue3946() WHERE k LIKE 'pol %' AND v LIKE '{public}|%';
  PERFORM pg_temp.check('r03 no helper policy is TO public (B untouched)', s = '0', s);
END $$;
