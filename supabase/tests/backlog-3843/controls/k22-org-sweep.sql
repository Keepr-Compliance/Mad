-- K2: every organizations column NOT on the allow-list, read from the catalogue at
-- run time, is refused by the guard for an O1 admin; the row is unchanged.
DO $$ DECLARE c record; m text; before_o text; expr text; n int := 0; BEGIN
  before_o := pg_temp.osnap(pg_temp.id('org1'));
  FOR c IN SELECT column_name, data_type FROM information_schema.columns
           WHERE table_schema='public' AND table_name='organizations'
             AND column_name NOT IN ('retention_years','jit_provisioning_enabled','graph_admin_consent_granted','graph_admin_consent_at','updated_at')
           ORDER BY ordinal_position LOOP
    expr := CASE
      WHEN c.column_name = 'plan' THEN $v$'enterprise'$v$
      WHEN c.column_name = 'default_member_role' THEN $v$'admin'$v$
      WHEN c.column_name IN ('id', 'personal_owner_user_id') THEN $v$'{u_b}'$v$
      WHEN c.data_type = 'boolean' THEN format('NOT coalesce(%I, false)', c.column_name)
      WHEN c.data_type = 'integer' THEN format('coalesce(%I, 0) + 1', c.column_name)
      WHEN c.data_type IN ('text', 'character varying') THEN format($v$coalesce(%I, '') || '-x3843'$v$, c.column_name)
      WHEN c.data_type = 'timestamp with time zone' THEN format($v$coalesce(%I, now()) - interval '3 days'$v$, c.column_name)
      WHEN c.data_type = 'jsonb' THEN format($v$coalesce(%I, '{}'::jsonb) || '{"k3843": 1}'::jsonb$v$, c.column_name)
      WHEN c.data_type = 'ARRAY' THEN format($v$coalesce(%I, '{}') || array['x3843.test']$v$, c.column_name)
      ELSE NULL END;
    IF expr IS NULL THEN
      PERFORM pg_temp.check('k22 no test value for column ' || c.column_name || ' (' || c.data_type || ')', false);
      CONTINUE;
    END IF;
    m := pg_temp.as_user(pg_temp.uc(), 'admin1-3679@example.test',
      format($q$update public.organizations set %I = %s where id='{org1}'$q$, c.column_name, expr), true);
    PERFORM pg_temp.check('k22 admin UPDATE organizations.' || c.column_name || ' refused by the guard', pg_temp.org_refused(m), m);
    n := n + 1;
  END LOOP;
  PERFORM pg_temp.check('k22 swept 17 columns', n = 17, n::text);
  PERFORM pg_temp.check('k22 organization row unchanged', pg_temp.osnap(pg_temp.id('org1')) = before_o);
END $$;
