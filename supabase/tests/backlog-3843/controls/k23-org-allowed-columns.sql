-- K3: the broker-portal organization writes still work as an O1 admin, and are stored.
DO $$ DECLARE m text; r record; BEGIN
  m := pg_temp.as_user(pg_temp.uc(), 'admin1-3679@example.test',
    $q$select current_user || '|' || auth.uid()::text$q$);
  PERFORM pg_temp.check('k23 harness runs as authenticated with the admin uid', m = 'OK authenticated|{u_c}', m);
  -- scim.ts updateRetentionPolicy
  m := pg_temp.as_user(pg_temp.uc(), 'admin1-3679@example.test',
    $q$update public.organizations set retention_years = 3 where id='{org1}'$q$, true);
  PERFORM pg_temp.check('k23 retention_years write succeeds', m = 'OK rows=1', m);
  -- scim.ts updateJitStatus
  m := pg_temp.as_user(pg_temp.uc(), 'admin1-3679@example.test',
    $q$update public.organizations set jit_provisioning_enabled = false where id='{org1}'$q$, true);
  PERFORM pg_temp.check('k23 jit_provisioning_enabled write succeeds', m = 'OK rows=1', m);
  -- app/setup/consent/callback/route.ts
  m := pg_temp.as_user(pg_temp.uc(), 'admin1-3679@example.test',
    $q$update public.organizations set graph_admin_consent_granted = true, graph_admin_consent_at = '2026-01-02T03:04:05Z' where id='{org1}'$q$, true);
  PERFORM pg_temp.check('k23 admin-consent write succeeds', m = 'OK rows=1', m);
  m := pg_temp.as_user(pg_temp.uc(), 'admin1-3679@example.test',
    $q$update public.organizations set updated_at = now() where id='{org1}'$q$, true);
  PERFORM pg_temp.check('k23 updated_at write succeeds', m = 'OK rows=1', m);
  SELECT * INTO r FROM public.organizations WHERE id = pg_temp.id('org1');
  PERFORM pg_temp.check('k23 values stored',
    r.retention_years = 3 AND r.jit_provisioning_enabled = false AND r.graph_admin_consent_granted
    AND r.graph_admin_consent_at = '2026-01-02T03:04:05Z'::timestamptz,
    concat_ws(',', r.retention_years, r.jit_provisioning_enabled, r.graph_admin_consent_granted, r.graph_admin_consent_at));
  -- a non-admin member still updates nothing (row-level policy, unchanged)
  m := pg_temp.as_user(pg_temp.id('u_e'), 'member-3679@example.test',
    $q$update public.organizations set retention_years = 1 where id='{org1}'$q$);
  PERFORM pg_temp.check('k23 non-admin member updates 0 rows', m = 'OK rows=0', m);
END $$;
