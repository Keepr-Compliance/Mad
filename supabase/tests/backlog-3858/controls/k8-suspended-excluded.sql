-- k8: founder rule (BACKLOG-3858): suspended users are left out. s_lic
-- (licences.status = 'suspended') and s_user (users.status = 'suspended') keep
-- no membership, get no personal organization and are not recorded, and the
-- file still completes.
SELECT pg_temp.check('k8 ' || n || ' has no membership', pg_temp.members_of(n) = '[]'::jsonb, pg_temp.members_of(n)::text)
FROM unnest(ARRAY['s_lic','s_user']) n;
SELECT pg_temp.check('k8 ' || n || ' has no personal org', pg_temp.porg(n) IS NULL, pg_temp.porg(n)::text)
FROM unnest(ARRAY['s_lic','s_user']) n;
SELECT pg_temp.check('k8 ' || n || ' not in the bookkeeping table',
  jsonb_typeof(pg_temp.state()->'backfill') = 'array'
  AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(pg_temp.state()->'backfill') b WHERE b->>'user_id' = pg_temp.id(n)::text))
FROM unnest(ARRAY['s_lic','s_user']) n;
