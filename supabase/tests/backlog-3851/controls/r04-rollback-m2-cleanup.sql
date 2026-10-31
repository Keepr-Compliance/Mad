-- r04 after M1 + snapshot + M2 + seed + rollback-3851-m2.sql + rollback-3851-m2-paygo-cleanup.sql
-- (PR-2a reverted too): the revert-attached personal membership is gone, its organization row
-- stays, and no other membership is touched (u_pp's solo personal row, o_tact's brokerage row).
SELECT pg_temp.check('r04 schema equals the M1-only fingerprint',
  NOT EXISTS (SELECT 1 FROM t3851_m1 s FULL JOIN pg_temp.venue3851() v ON v.k = s.k
               WHERE s.v IS DISTINCT FROM v.v), NULL);
SELECT pg_temp.check('r04 revert-attached personal membership removed',
  NOT EXISTS (SELECT 1 FROM public.organization_members m JOIN public.organizations o ON o.id = m.organization_id
               WHERE m.user_id = pg_temp.id('u_otact') AND o.personal_owner_user_id = pg_temp.id('u_otact')), NULL);
SELECT pg_temp.check('r04 the personal organization row itself stays',
  EXISTS (SELECT 1 FROM public.organizations WHERE personal_owner_user_id = pg_temp.id('u_otact')), NULL);
SELECT pg_temp.check('r04 the deactivated brokerage row stays suspended',
  pg_temp.status('o_tact') = 'suspended', NULL);
SELECT pg_temp.check('r04 a solo user''s personal membership is untouched',
  EXISTS (SELECT 1 FROM public.organization_members WHERE id = pg_temp.id('pp_m')), NULL);
SELECT pg_temp.check('r04 exactly one membership row removed by the cleanup',
  (SELECT count(*) FROM public.organization_members) = (SELECT n FROM t3851_count) - 1,
  (SELECT count(*)::text FROM public.organization_members) || ' vs ' || (SELECT n::text FROM t3851_count));
