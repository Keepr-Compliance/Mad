-- BACKLOG-3473: remove the catalogue lib/venue-catalogue.sql loaded, leaving
-- the venue schema-only as it was found (run.sh catalogue-teardown). For the
-- venue only -- never production. Run AFTER teardown.sql and the re-gate.
--
-- Refuses unless the four tables hold exactly the seeded set (re-hashed
-- against production), and unless no organization_plans or
-- admin_role_permissions row still points at it. Then deletes, and checks
-- all four tables are empty.

BEGIN;

SET LOCAL lock_timeout = '5s';

DO $refuse$
BEGIN
  IF EXISTS (SELECT 1 FROM public.feature_definitions WHERE key = 'transaction_checklists') THEN
    RAISE EXCEPTION 'catalogue-teardown refused: transaction_checklists is still defined; run teardown first';
  END IF;
  IF EXISTS (SELECT 1 FROM public.organization_plans) THEN
    RAISE EXCEPTION 'catalogue-teardown refused: organization_plans still holds rows; run probe-cleanup first';
  END IF;
  IF EXISTS (SELECT 1 FROM public.admin_role_permissions) THEN
    RAISE EXCEPTION 'catalogue-teardown refused: admin_role_permissions holds rows this file did not write';
  END IF;
END
$refuse$;

\ir venue-catalogue-verify.sql

DELETE FROM public.plan_features;
DELETE FROM public.plans;
DELETE FROM public.feature_definitions;
DELETE FROM public.admin_permissions WHERE key = 'plans.manage';

DO $verify$
DECLARE
  n bigint;
BEGIN
  SELECT (SELECT count(*) FROM public.feature_definitions) + (SELECT count(*) FROM public.plans)
       + (SELECT count(*) FROM public.plan_features) + (SELECT count(*) FROM public.admin_permissions)
    INTO n;
  IF n <> 0 THEN
    RAISE EXCEPTION 'catalogue-teardown: % catalogue row(s) remain', n;
  END IF;
  RAISE NOTICE 'catalogue-teardown verified: the four catalogue tables are empty again';
END
$verify$;

COMMIT;
