-- k1: after the run no licensed, non-suspended user is without a membership
-- (plan §2.3 SQL plus the founder's suspended exclusion), each of the four
-- cohort users (individual x2, team, expired invite)
-- holds exactly one membership, in their own personal organization, and each
-- is recorded in the bookkeeping table.
SELECT pg_temp.check('k1 licensed, non-suspended users without membership = 0',
  (SELECT count(*) FILTER (WHERE NOT EXISTS (SELECT 1 FROM public.organization_members m WHERE m.user_id = l.user_id))
     FROM public.licenses l JOIN public.users u ON u.id = l.user_id
    WHERE l.status IS DISTINCT FROM 'suspended' AND u.status IS DISTINCT FROM 'suspended') = 0,
  (SELECT string_agg(l.user_id::text, ',') FROM public.licenses l
    WHERE NOT EXISTS (SELECT 1 FROM public.organization_members m WHERE m.user_id = l.user_id)));
SELECT pg_temp.check('k1 ' || n || ': one membership, in own personal org',
  (SELECT count(*) FROM public.organization_members m WHERE m.user_id = pg_temp.id(n)) = 1
  AND EXISTS (SELECT 1 FROM public.organization_members m
               WHERE m.user_id = pg_temp.id(n) AND m.organization_id = pg_temp.porg(n)),
  pg_temp.members_of(n)::text)
FROM pg_temp.cohort() n;
-- Read through pg_temp.state() so a missing table is a FAIL, not a psql error.
SELECT pg_temp.check('k1 bookkeeping rows = the four cohort users and their orgs',
  jsonb_typeof(pg_temp.state()->'backfill') = 'array'
  AND jsonb_array_length(pg_temp.state()->'backfill') = 4
  AND NOT EXISTS (SELECT 1 FROM pg_temp.cohort() n
                   WHERE NOT EXISTS (SELECT 1 FROM jsonb_array_elements(pg_temp.state()->'backfill') b
                                      WHERE b->>'user_id' = pg_temp.id(n)::text
                                        AND b->>'organization_id' = pg_temp.porg(n)::text)),
  (SELECT pg_temp.state()->>'backfill'));
