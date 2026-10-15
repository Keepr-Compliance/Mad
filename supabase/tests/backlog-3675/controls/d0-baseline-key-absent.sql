-- harness: baseline
-- Before the migration the key is absent: the desktop reads absent as "not entitled".
DO $$ DECLARE m text; BEGIN
  PERFORM pg_temp.check('d0 baseline: no feature row',
    (SELECT count(*) FROM public.feature_definitions WHERE key = 'unlimited_transactions') = 0);
  m := pg_temp.unlimited_as(pg_temp.id('u_owner'), 'org_p');
  PERFORM pg_temp.check('d0 baseline: get_org_features has no unlimited_transactions entry', m = 'OK <null>', m);
END $$;
