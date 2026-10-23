-- r03 after M1 + snapshot + M2 + seed + rollback-3851-m2.sql: every object is back to its
-- M1-only fingerprint (= production today), M1's objects are intact, the JIT default is
-- true again, and the data M2 left behind is as the rollback's header states.
SELECT pg_temp.check('r03 equals the M1-only fingerprint: ' || s.k, v.v IS NOT DISTINCT FROM s.v, coalesce(v.v, '<none>'))
  FROM t3851_m1 s LEFT JOIN pg_temp.venue3851() v ON v.k = s.k;
SELECT pg_temp.check('r03 no object beyond the M1-only fingerprint remains', NOT EXISTS (
  SELECT 1 FROM pg_temp.venue3851() v LEFT JOIN t3851_m1 s ON s.k = v.k WHERE s.k IS NULL),
  (SELECT string_agg(v.k, ', ') FROM pg_temp.venue3851() v LEFT JOIN t3851_m1 s ON s.k = v.k WHERE s.k IS NULL));
SELECT pg_temp.check('r03 M2 objects gone: revert trigger and its function',
  to_regprocedure('public._revert_deactivated_member_to_paygo()') IS NULL
  AND NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'revert_deactivated_member'), NULL);
SELECT pg_temp.check('r03 M1 objects intact: helpers, seat trigger, set_member_license',
  to_regprocedure('public.member_status_is_deactivated(text)') IS NOT NULL
  AND to_regprocedure('public.member_status_holds_seat(text)') IS NOT NULL
  AND to_regprocedure('public.set_member_license(uuid,text)') IS NOT NULL
  AND EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'seat_limit_enforce'), NULL);
SELECT pg_temp.check('r03 the two replaced functions carry production''s bodies',
  (SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public._ensure_personal_organization_for(uuid)'::regprocedure) = 'bcfe51daa44bb65ceb7c120a44d5eec2'
  AND (SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public._retire_personal_membership()'::regprocedure) = 'dd505c04b375c309acab6ae2d5744d3a', NULL);
SELECT pg_temp.check('r03 jit_provisioning_enabled default is true again',
  (SELECT column_default FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'organizations' AND column_name = 'jit_provisioning_enabled') = 'true', NULL);
SELECT pg_temp.check('r03 unassigned rows stay unassigned (M1 kept)',
  pg_temp.status('f_un') = 'unassigned' AND pg_temp.status('o_tun') = 'unassigned', NULL);
SELECT pg_temp.check('r03 revert-attached personal row kept (stated in the header)',
  EXISTS (SELECT 1 FROM public.organization_members m JOIN public.organizations o ON o.id = m.organization_id
           WHERE m.user_id = pg_temp.id('u_otact') AND o.personal_owner_user_id = pg_temp.id('u_otact')), NULL);
