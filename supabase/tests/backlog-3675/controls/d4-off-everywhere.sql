-- After the apply every plan has the feature OFF; the definition is shaped as approved.
DO $$ DECLARE m text; BEGIN
  PERFORM pg_temp.check('d4 feature row: default false, min_tier NULL, export, boolean, built',
    (SELECT default_value = 'false' AND min_tier IS NULL AND category = 'export' AND value_type = 'boolean' AND is_built
       FROM public.feature_definitions WHERE key = 'unlimited_transactions'));
  PERFORM pg_temp.check('d4 every plan has a row and every row is off',
    (SELECT count(*) FILTER (WHERE pf.enabled = false) = count(*) AND count(*) = (SELECT count(*) FROM public.plans)
       FROM public.plan_features pf JOIN public.feature_definitions fd ON fd.id = pf.feature_id
      WHERE fd.key = 'unlimited_transactions'));
  PERFORM pg_temp.check('d4 no organization override carries the key',
    (SELECT count(*) FROM public.organization_plans WHERE feature_overrides ? 'unlimited_transactions') = 0);
  m := pg_temp.unlimited_as(pg_temp.id('u_owner'), 'org_p');
  PERFORM pg_temp.check('d4 the solo account reads enabled false', m LIKE 'OK %"enabled": false%', m);
END $$;
