-- D03 (3938): broker_get_org_features answers only for the org's members or submitters.
DO $$ DECLARE m text; BEGIN
  m := pg_temp.as_user('u_ps', $q$select public.broker_get_org_features('{org1}')->>'error'$q$);
  PERFORM pg_temp.check('d03 outsider refused (not_member)', m = 'OK not_member', m);
  m := pg_temp.as_user('u_ps', $q$select public.broker_get_org_features('{org1}')->'features' = '{}'::jsonb$q$);
  PERFORM pg_temp.check('d03 outsider gets no features', m = 'OK true', m);
  m := pg_temp.as_user('u_g', $q$select (select (f->>'error') is null and (f->'features') ? 'transaction_checklists' from public.broker_get_org_features('{org1}') f)$q$);
  PERFORM pg_temp.check('d03 active agent gets features', m = 'OK true', m);
  m := pg_temp.as_user('u_g2', $q$select (select (f->>'error') is null and (f->'features') ? 'transaction_checklists' from public.broker_get_org_features('{org1}') f)$q$);
  PERFORM pg_temp.check('d03 active agent with no submission gets features', m = 'OK true', m);
  m := pg_temp.as_user('u_gs', $q$select (select (f->>'error') is null and (f->'features') ? 'transaction_checklists' from public.broker_get_org_features('{org1}') f)$q$);
  PERFORM pg_temp.check('d03 suspended member gets own org features', m = 'OK true', m);
  m := pg_temp.as_user('u_p', $q$select (select (f->>'error') is null and (f->'features') ? 'transaction_checklists' from public.broker_get_org_features('{org1}') f)$q$);
  PERFORM pg_temp.check('d03 submitter with no membership row gets features', m = 'OK true', m);
  m := pg_temp.as_role('anon', NULL, $q$select public.broker_get_org_features('{org1}')->>'error'$q$);
  PERFORM pg_temp.check('d03 anon not_authenticated', m = 'OK not_authenticated', m);
END $$;
