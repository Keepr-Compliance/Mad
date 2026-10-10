-- Migration: personal organizations for licensed users who hold no membership (BACKLOG-3858)
--
-- For every user with a public.licenses row and NO public.organization_members
-- row (any status), except suspended users (licences.status = 'suspended' or
-- users.status = 'suspended'), calls public._ensure_personal_organization_for(user_id) —
-- the same function the desktop reaches through ensure_personal_organization()
-- on sign-in. The function itself is not changed.
--
-- Each organization this file creates is recorded in
-- public.backlog_3858_personal_org_backfill, which is what
-- supabase/tests/backlog-3858/rollback-3858.sql removes. Nothing else reads it.
--
-- Behaviour:
--   * empty cohort (fresh database, or a second run) -> NOTICE, no writes;
--   * otherwise the function's prosrc fingerprint must match the body this file
--     was reviewed against, or the file raises before writing;
--   * any call returning a status other than 'created' raises (whole file
--     rolls back), listing user id and status;
--   * after the loop no licensed, non-suspended user may be left without a
--     membership.
--
-- Tested by supabase/tests/backlog-3858/.

CREATE TABLE IF NOT EXISTS public.backlog_3858_personal_org_backfill (
  user_id         uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.backlog_3858_personal_org_backfill ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.backlog_3858_personal_org_backfill FROM PUBLIC, anon, authenticated;

COMMENT ON TABLE public.backlog_3858_personal_org_backfill IS
  'BACKLOG-3858: personal organizations created by migration 20261010210000. Read only by supabase/tests/backlog-3858/rollback-3858.sql.';

DO $m3858$
DECLARE
  v_expected_fp text := 'bcfe51daa44bb65ceb7c120a44d5eec2';
  v_fp      text;
  r         record;
  v         jsonb;
  v_created integer := 0;
  v_bad     text[] := ARRAY[]::text[];
  v_left    integer;
BEGIN
  PERFORM set_config('lock_timeout', '5s', true);

  IF NOT EXISTS (
    SELECT 1 FROM public.licenses l
     WHERE l.status IS DISTINCT FROM 'suspended'
       AND NOT EXISTS (SELECT 1 FROM public.users u WHERE u.id = l.user_id AND u.status = 'suspended')
       AND NOT EXISTS (SELECT 1 FROM public.organization_members m WHERE m.user_id = l.user_id)
  ) THEN
    RAISE NOTICE 'BACKLOG-3858: no licensed, non-suspended user without a membership; nothing to do';
    RETURN;
  END IF;

  SELECT md5(p.prosrc) INTO v_fp
    FROM pg_catalog.pg_proc p
   WHERE p.oid = 'public._ensure_personal_organization_for(uuid)'::regprocedure;
  IF v_fp IS DISTINCT FROM v_expected_fp THEN
    RAISE EXCEPTION 'BACKLOG-3858: _ensure_personal_organization_for body changed (md5 %, expected %); re-review before applying',
      v_fp, v_expected_fp;
  END IF;

  FOR r IN
    SELECT l.user_id
      FROM public.licenses l
     WHERE l.status IS DISTINCT FROM 'suspended'
       AND NOT EXISTS (SELECT 1 FROM public.users u WHERE u.id = l.user_id AND u.status = 'suspended')
       AND NOT EXISTS (SELECT 1 FROM public.organization_members m WHERE m.user_id = l.user_id)
     ORDER BY l.user_id
  LOOP
    v := public._ensure_personal_organization_for(r.user_id);
    IF v->>'status' IS DISTINCT FROM 'created' THEN
      v_bad := v_bad || (r.user_id::text || ':' || COALESCE(v->>'status', '<null>'));
      CONTINUE;
    END IF;
    INSERT INTO public.backlog_3858_personal_org_backfill (user_id, organization_id)
    VALUES (r.user_id, (v->>'organization_id')::uuid);
    v_created := v_created + 1;
  END LOOP;

  IF cardinality(v_bad) > 0 THEN
    RAISE EXCEPTION 'BACKLOG-3858: % user(s) not created: %', cardinality(v_bad), array_to_string(v_bad, ', ');
  END IF;

  SELECT count(*) INTO v_left
    FROM public.licenses l
   WHERE l.status IS DISTINCT FROM 'suspended'
     AND NOT EXISTS (SELECT 1 FROM public.users u WHERE u.id = l.user_id AND u.status = 'suspended')
     AND NOT EXISTS (SELECT 1 FROM public.organization_members m WHERE m.user_id = l.user_id);
  IF v_left > 0 THEN
    RAISE EXCEPTION 'BACKLOG-3858: % licensed, non-suspended user(s) still without a membership', v_left;
  END IF;

  RAISE NOTICE 'BACKLOG-3858: created % personal organization(s)', v_created;
END
$m3858$;
