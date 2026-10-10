-- k3: users who already held a membership (active, pending, suspended in a
-- brokerage; d_desk in a personal org), the no-licence user, the brokerage and
-- the expired invite row are byte-identical after the run; none of them gained
-- a personal organization.
SELECT pg_temp.check('k3 ' || n || ' membership rows unchanged',
  (SELECT jsonb_agg(m ORDER BY m->>'id') FROM jsonb_array_elements(pg_temp.snapshot('pre')->'organization_members') m
    WHERE m->>'user_id' = pg_temp.id(n)::text) IS NOT DISTINCT FROM
  (SELECT jsonb_agg(m ORDER BY m->>'id') FROM jsonb_array_elements(pg_temp.snapshot('after1')->'organization_members') m
    WHERE m->>'user_id' = pg_temp.id(n)::text),
  pg_temp.members_of(n)::text)
FROM unnest(ARRAY['m_active','m_pending','m_susp','d_desk','u_nolic']) n;
SELECT pg_temp.check('k3 ' || n || ' gained no personal org',
  pg_temp.porg(n) IS NULL, pg_temp.porg(n)::text)
FROM unnest(ARRAY['m_active','m_pending','m_susp','u_nolic']) n;
SELECT pg_temp.check('k3 d_desk personal org row unchanged',
  (SELECT o FROM jsonb_array_elements(pg_temp.snapshot('pre')->'organizations') o WHERE o->>'id' = pg_temp.porg('d_desk')::text)
  = (SELECT o FROM jsonb_array_elements(pg_temp.snapshot('after1')->'organizations') o WHERE o->>'id' = pg_temp.porg('d_desk')::text));
SELECT pg_temp.check('k3 brokerage org row and its rows (incl. expired invite) unchanged',
  (SELECT jsonb_agg(x ORDER BY x->>'id') FROM jsonb_array_elements(pg_temp.snapshot('pre')->'organization_members') x
    WHERE x->>'organization_id' = pg_temp.id('b_org')::text)
  = (SELECT jsonb_agg(x ORDER BY x->>'id') FROM jsonb_array_elements(pg_temp.snapshot('after1')->'organization_members') x
    WHERE x->>'organization_id' = pg_temp.id('b_org')::text)
  AND (SELECT o FROM jsonb_array_elements(pg_temp.snapshot('pre')->'organizations') o WHERE o->>'id' = pg_temp.id('b_org')::text)
    = (SELECT o FROM jsonb_array_elements(pg_temp.snapshot('after1')->'organizations') o WHERE o->>'id' = pg_temp.id('b_org')::text));
SELECT pg_temp.check('k3 only the four cohort orgs are new',
  (SELECT count(*) FROM jsonb_array_elements(pg_temp.snapshot('after1')->'organizations')) -
  (SELECT count(*) FROM jsonb_array_elements(pg_temp.snapshot('pre')->'organizations')) = 4);
