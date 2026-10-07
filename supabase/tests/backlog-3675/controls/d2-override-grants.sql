-- An override on the personal (Individual) organization grants it; without it, the plan row (false) decides.
DO $$ DECLARE m text; BEGIN
  m := pg_temp.unlimited_as(pg_temp.id('u_owner'), 'org_p');
  PERFORM pg_temp.check('d2 without override: enabled false, source plan',
    m LIKE 'OK %"enabled": false%' AND m LIKE '%"source": "plan"%', m);
  -- A refused write is a FAIL of this check, not an aborted run (the tier trigger raises 23514).
  BEGIN
    PERFORM pg_temp.grant_override(pg_temp.id('org_p'), '{"enabled": true}'::jsonb);
    PERFORM pg_temp.check('d2 override write accepted', true);
  EXCEPTION WHEN OTHERS THEN
    PERFORM pg_temp.check('d2 override write accepted', false, SQLERRM);
  END;
  m := pg_temp.unlimited_as(pg_temp.id('u_owner'), 'org_p');
  PERFORM pg_temp.check('d2 with override: enabled true, source override',
    m LIKE 'OK %"enabled": true%' AND m LIKE '%"source": "override"%' AND m NOT LIKE '%override_ignored%', m);
  m := pg_temp.unlimited_as(pg_temp.id('u_other'), 'org_o');
  PERFORM pg_temp.check('d2 the other organization is unaffected', m LIKE 'OK %"enabled": false%', m);
  m := pg_temp.as_user(pg_temp.id('u_other'), $q$select public.get_org_features('{org_p}') ->> 'error'$q$);
  PERFORM pg_temp.check('d2 a non-member cannot read the personal organization', m = 'OK not_authorized', m);
END $$;
