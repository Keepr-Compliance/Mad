-- The issuer reads paid_through AS the caller: a member sees his organization's overrides, a non-member does not.
DO $$ DECLARE m text; BEGIN
  PERFORM pg_temp.grant_override(pg_temp.id('org_p'), '{"enabled": true, "paid_through": "2026-11-02T17:00:00Z"}'::jsonb);
  m := pg_temp.as_user(pg_temp.id('u_owner'),
    $q$select (select count(*) from public.organization_plans where organization_id = '{org_p}')$q$);
  PERFORM pg_temp.check('d5 member reads 1 organization_plans row', m = 'OK 1', m);
  m := pg_temp.as_user(pg_temp.id('u_owner'),
    $q$select (select feature_overrides -> 'unlimited_transactions' ->> 'paid_through' from public.organization_plans where organization_id = '{org_p}')$q$);
  PERFORM pg_temp.check('d5 member reads paid_through', m = 'OK 2026-11-02T17:00:00Z', m);
  m := pg_temp.as_user(pg_temp.id('u_other'),
    $q$select (select count(*) from public.organization_plans where organization_id = '{org_p}')$q$);
  PERFORM pg_temp.check('d5 non-member reads 0 rows', m = 'OK 0', m);
END $$;
