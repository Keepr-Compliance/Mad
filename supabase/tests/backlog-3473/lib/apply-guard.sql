-- BACKLOG-3473 (guard added by BACKLOG-3945): run.sh apply includes this file
-- in the SAME transaction as migration file 1, before it. For a test venue only.
--
-- 1. Raises unless the venue is at the pre-3473 baseline this harness was built
--    for (production as of 2026-09-21, before ledger 20260921101756):
--      a. the three read functions hash to lib/rpc-before.sql's md5s
--         (md5(pg_get_functiondef));
--      b. migration 2's tables are absent (public.checklist_templates);
--      c. migration 3's three organizations columns are present.
-- 2. On pass, writes the apply marker (harness_3473.apply_marker). It commits
--    only together with file 1: if file 1 fails, neither is committed.
--    lib/teardown.sql refuses to run unless the marker exists, and removes it.
--
-- Production has moved past this baseline, so on a venue built from a later
-- production state this guard refuses. That is intended: the 3473 harness is
-- historical and replays its migrations only onto the state they were
-- written against.

DO $guard$
DECLARE
  r record;
BEGIN
  FOR r IN SELECT * FROM (VALUES
    ('public.check_feature_access(uuid,text)', '864e0a56a064a02fefb0c6acc707990f'),
    ('public.get_org_features(uuid)',          'be09560411aa508b869a523d35931211'),
    ('public.broker_get_org_features(uuid)',   '60c63f216f5a10ab804e90f74d7d8284')
  ) v(sig, pin) LOOP
    IF to_regprocedure(r.sig) IS NULL
       OR md5(pg_get_functiondef(to_regprocedure(r.sig))) IS DISTINCT FROM r.pin THEN
      RAISE EXCEPTION 'apply refused: % is not the pre-3473 body', r.sig;
    END IF;
  END LOOP;
  IF to_regclass('public.checklist_templates') IS NOT NULL THEN
    RAISE EXCEPTION 'apply refused: BACKLOG-3473 tables already exist on this venue';
  END IF;
  IF (SELECT count(*) FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'organizations'
         AND column_name IN ('require_dual_approval', 'auto_reject_incomplete', 'minimum_attachment_types')) <> 3 THEN
    RAISE EXCEPTION 'apply refused: migration 3 has been applied on this venue';
  END IF;
  RAISE NOTICE 'guard: venue is at the pre-3473 baseline';
END
$guard$;

-- Fails (and rolls back file 1 with it) if a marker already exists.
CREATE SCHEMA harness_3473;
CREATE TABLE harness_3473.apply_marker (applied_at timestamptz NOT NULL DEFAULT now());
INSERT INTO harness_3473.apply_marker DEFAULT VALUES;
