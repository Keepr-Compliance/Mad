-- harness: rollback
-- ROLLBACK_FILE after the migration: relacl and the column ACLs equal the
-- state before the migration, and c1's UPDATE is stored again.
DO $$ DECLARE m text; BEGIN
  PERFORM pg_temp.check('c7 rollback: relacl = before the migration',
    (SELECT relacl::text FROM pg_class WHERE oid = 'public.users'::regclass) = (SELECT relacl FROM t3714_before),
    (SELECT relacl::text FROM pg_class WHERE oid = 'public.users'::regclass));
  PERFORM pg_temp.check('c7 rollback: column ACLs = before the migration',
    pg_temp.attacl_cols() = (SELECT attacl_cols FROM t3714_before), pg_temp.attacl_cols()::text);
  PERFORM pg_temp.check('c7 rollback: anon and authenticated hold UPDATE on every column',
    pg_temp.priv_cols('authenticated', 'UPDATE') = pg_temp.all_cols()
    AND pg_temp.priv_cols('anon', 'UPDATE') = pg_temp.all_cols());
  m := pg_temp.as_role('authenticated', pg_temp.id('u_self'),
    'update public.users set subscription_tier = ''enterprise'' where id = ''{u_self}''', true);
  PERFORM pg_temp.check('c7 rollback: authenticated UPDATE of subscription_tier stored again',
    m = 'OK rows=1' AND pg_temp.snap('u_self')->>'subscription_tier' = 'enterprise', m);
END $$;
