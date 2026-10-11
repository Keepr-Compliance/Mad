-- An override carrying paid_through is accepted by the tier trigger and still reads as enabled.
DO $$ DECLARE m text; BEGIN
  BEGIN
    PERFORM pg_temp.grant_override(pg_temp.id('org_p'), '{"enabled": true, "paid_through": "2026-11-02T17:00:00Z"}'::jsonb);
    PERFORM pg_temp.check('d6 override with paid_through accepted', true);
  EXCEPTION WHEN OTHERS THEN
    PERFORM pg_temp.check('d6 override with paid_through accepted', false, SQLERRM);
  END;
  m := pg_temp.unlimited_as(pg_temp.id('u_owner'), 'org_p');
  PERFORM pg_temp.check('d6 enabled true, source override',
    m LIKE 'OK %"enabled": true%' AND m LIKE '%"source": "override"%', m);
  -- Revoke = remove the key (an override without "enabled" would read as enabled).
  UPDATE public.organization_plans SET feature_overrides = feature_overrides - 'unlimited_transactions'
   WHERE organization_id = pg_temp.id('org_p');
  m := pg_temp.unlimited_as(pg_temp.id('u_owner'), 'org_p');
  PERFORM pg_temp.check('d6 after revoke: enabled false, source plan',
    m LIKE 'OK %"enabled": false%' AND m LIKE '%"source": "plan"%', m);
END $$;
