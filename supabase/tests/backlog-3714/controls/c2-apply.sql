-- After one apply: UPDATE privilege per column is exactly 16 for
-- authenticated, none for anon or PUBLIC, all for service_role; attacl on
-- exactly the 16; INSERT / SELECT unchanged; policies unchanged.
DO $$ BEGIN
  PERFORM pg_temp.check('c2 apply: keep (16) + locked (23) = every column, disjoint',
    cardinality(pg_temp.keep_cols()) = 16 AND cardinality(pg_temp.locked_cols()) = 23
    AND pg_temp.sorted(pg_temp.keep_cols() || pg_temp.locked_cols()) = pg_temp.all_cols(),
    cardinality(pg_temp.all_cols())::text);
  PERFORM pg_temp.check('c2 apply: authenticated UPDATE columns = the 16',
    pg_temp.priv_cols('authenticated', 'UPDATE') = pg_temp.sorted(pg_temp.keep_cols()),
    pg_temp.priv_cols('authenticated', 'UPDATE')::text);
  PERFORM pg_temp.check('c2 apply: anon UPDATE columns = none',
    pg_temp.priv_cols('anon', 'UPDATE') = '{}', pg_temp.priv_cols('anon', 'UPDATE')::text);
  PERFORM pg_temp.check('c2 apply: service_role UPDATE columns = every column',
    pg_temp.priv_cols('service_role', 'UPDATE') = pg_temp.all_cols(),
    cardinality(pg_temp.priv_cols('service_role', 'UPDATE'))::text);
  PERFORM pg_temp.check('c2 apply: no table-level UPDATE for anon / authenticated / PUBLIC',
    NOT EXISTS (SELECT 1 FROM pg_class c, aclexplode(c.relacl) a
                 WHERE c.oid = 'public.users'::regclass AND a.privilege_type = 'UPDATE'
                   AND a.grantee IN (0, 'anon'::regrole::oid, 'authenticated'::regrole::oid)),
    (SELECT relacl::text FROM pg_class WHERE oid = 'public.users'::regclass));
  PERFORM pg_temp.check('c2 apply: no column-level UPDATE for PUBLIC or anon',
    NOT EXISTS (SELECT 1 FROM pg_attribute t, aclexplode(t.attacl) a
                 WHERE t.attrelid = 'public.users'::regclass AND t.attnum > 0
                   AND a.grantee IN (0, 'anon'::regrole::oid)));
  PERFORM pg_temp.check('c2 apply: attacl set on exactly the 16',
    pg_temp.attacl_cols() = pg_temp.sorted(pg_temp.keep_cols()), pg_temp.attacl_cols()::text);
  PERFORM pg_temp.check('c2 apply: INSERT and SELECT unchanged (every column, anon and authenticated)',
    pg_temp.priv_cols('authenticated', 'INSERT') = pg_temp.all_cols()
    AND pg_temp.priv_cols('anon', 'INSERT') = pg_temp.all_cols()
    AND pg_temp.priv_cols('authenticated', 'SELECT') = pg_temp.all_cols()
    AND pg_temp.priv_cols('anon', 'SELECT') = pg_temp.all_cols());
  PERFORM pg_temp.check('c2 apply: DELETE privilege unchanged',
    has_table_privilege('authenticated', 'public.users', 'DELETE')
    AND has_table_privilege('anon', 'public.users', 'DELETE'));
  PERFORM pg_temp.check('c2 apply: policies unchanged',
    (SELECT md5(string_agg(policyname || '|' || cmd || '|' || roles::text || '|'
                           || coalesce(qual, '') || '|' || coalesce(with_check, ''), E'\n' ORDER BY policyname))
       FROM pg_policies WHERE schemaname = 'public' AND tablename = 'users')
    = (SELECT policies_md5 FROM t3714_before));
END $$;
