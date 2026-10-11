-- A signed-in user cannot grant himself the feature.
DO $$ DECLARE m text; BEGIN
  m := pg_temp.as_user(pg_temp.id('u_owner'),
    $q$update public.organization_plans set feature_overrides = coalesce(feature_overrides,'{}'::jsonb) || '{"unlimited_transactions":{"enabled":true}}' where organization_id = '{org_p}'$q$);
  PERFORM pg_temp.check('d1 owner UPDATE of own organization_plans refused', pg_temp.refused(m), m);
  m := pg_temp.as_user(pg_temp.id('u_owner'),
    $q$update public.plan_features set enabled = true where feature_id = (select id from public.feature_definitions where key = 'unlimited_transactions')$q$);
  PERFORM pg_temp.check('d1 UPDATE of plan_features refused', pg_temp.refused(m), m);
  m := pg_temp.as_user(pg_temp.id('u_owner'),
    $q$update public.feature_definitions set default_value = 'true' where key = 'unlimited_transactions'$q$);
  PERFORM pg_temp.check('d1 UPDATE of feature_definitions refused', pg_temp.refused(m), m);
  m := pg_temp.unlimited_as(pg_temp.id('u_owner'), 'org_p');
  PERFORM pg_temp.check('d1 still not entitled afterwards', m LIKE 'OK %"enabled": false%', m);
END $$;
