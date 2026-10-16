-- BACKLOG-3851: ONLY when PR-2a is reverted from the production portals together with M2.
-- Run right after rollback-3851-m2.sql and before the portal revert deploys. One transaction.
--
-- Without PR-2a the portals read ONE membership row per user. This removes the personal
-- membership of every user who also holds a deactivated (suspended / expired) brokerage row,
-- i.e. exactly the rows the M2 revert trigger attached. A solo user (personal row only) and an
-- active brokerage member are not touched. The personal organization row, its plan and its
-- transactions stay; only the membership row goes (the same thing reactivation does).
BEGIN;

DO $list$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT m.id, m.user_id
      FROM public.organization_members m
      JOIN public.organizations o ON o.id = m.organization_id AND o.personal_owner_user_id = m.user_id
     WHERE EXISTS (SELECT 1 FROM public.organization_members b
                     JOIN public.organizations bo ON bo.id = b.organization_id
                    WHERE b.user_id = m.user_id AND bo.personal_owner_user_id IS NULL
                      AND b.license_status IN ('suspended', 'expired'))
     ORDER BY m.id
  LOOP
    RAISE NOTICE 'rollback-3851-m2-paygo-cleanup: personal membership removed: member % user %', r.id, r.user_id;
  END LOOP;
END $list$;

DELETE FROM public.organization_members m
 USING public.organizations o
 WHERE o.id = m.organization_id
   AND o.personal_owner_user_id = m.user_id
   AND EXISTS (SELECT 1 FROM public.organization_members b
                 JOIN public.organizations bo ON bo.id = b.organization_id
                WHERE b.user_id = m.user_id AND bo.personal_owner_user_id IS NULL
                  AND b.license_status IN ('suspended', 'expired'));

COMMIT;
