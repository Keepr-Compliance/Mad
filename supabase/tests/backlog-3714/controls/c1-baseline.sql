-- harness: baseline
-- Before 3714 (3673 applied): anon and authenticated hold UPDATE on every
-- column, and an UPDATE of subscription_tier on the own row is stored. This
-- shows the harness can observe a stored write before the change.
DO $$ DECLARE m text; BEGIN
  PERFORM pg_temp.check('c1 baseline: authenticated holds UPDATE on every column',
    pg_temp.priv_cols('authenticated', 'UPDATE') = pg_temp.all_cols(),
    cardinality(pg_temp.priv_cols('authenticated', 'UPDATE'))::text);
  PERFORM pg_temp.check('c1 baseline: anon holds UPDATE on every column',
    pg_temp.priv_cols('anon', 'UPDATE') = pg_temp.all_cols(),
    cardinality(pg_temp.priv_cols('anon', 'UPDATE'))::text);
  m := pg_temp.as_role('authenticated', pg_temp.id('u_self'),
    'update public.users set subscription_tier = ''enterprise'' where id = ''{u_self}''', true);
  PERFORM pg_temp.check('c1 baseline: authenticated UPDATE of subscription_tier on own row is stored',
    m = 'OK rows=1' AND pg_temp.snap('u_self')->>'subscription_tier' = 'enterprise', m);
END $$;
