-- BACKLOG-4179: one brokerage per person, whatever the status of the row they already hold.
--
-- Plan: BACKLOG-3962 PR4 plan v1 §2 "20261112121000" + v2 items 8-10 (SR plan review). Ruling
-- "3 keep" (pm_comments 49f3e0b7 on BACKLOG-4179): any non-personal brokerage row refuses a second
-- one, active, pending, unassigned, suspended or expired alike.
--
-- 1. public._one_brokerage_per_member(): BEFORE INSERT OR UPDATE OF user_id, organization_id
--    trigger function. Skips rows in a personal organization. Takes the per-person advisory lock
--    (same key as _retire_personal_membership, 20261111130000), THEN reads: is there another row
--    for this person in any non-personal organization? If so: P0001 'already_placed'.
--    VOLATILE on purpose: each statement takes a new snapshot, so the read after the lock sees a
--    writer that committed while we waited (STABLE would reuse the pre-lock snapshot).
-- 2. Trigger single_brokerage_guard. A plain CREATE TRIGGER (tgenabled 'O'): it does not fire
--    under session_replication_role = replica, which another lane's harness relies on. Its name
--    sorts after seat_limit_enforce, so the organization row lock (seat trigger) is taken before
--    the person lock, the same order as the retire trigger.
--
-- Callers: every organization_members write (accept_invitation, jit_join_organization, SCIM,
-- directory sync, domain capture switch / join now). Each already refuses a placed person on its
-- own; this closes the race between their check and their write.
-- Harness: supabase/tests/backlog-4179/. Rollback: supabase/tests/backlog-4179/rollback-4179.sql.

-- Pre-check: no person holds two brokerage rows today (a leftover replica-harness row would).
DO $pre$
DECLARE
  n integer;
BEGIN
  SELECT count(*) INTO n
    FROM (
      SELECT m.user_id
        FROM public.organization_members m
        JOIN public.organizations o ON o.id = m.organization_id
       WHERE o.personal_owner_user_id IS NULL
         AND m.user_id IS NOT NULL
       GROUP BY m.user_id
      HAVING count(*) >= 2
    ) s;
  IF n > 0 THEN
    RAISE EXCEPTION 'BACKLOG-4179 pre-check: users with 2+ brokerage rows: %', n;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_trigger
                  WHERE tgrelid = 'public.organization_members'::regclass
                    AND tgname = 'seat_limit_enforce' AND NOT tgisinternal) THEN
    RAISE EXCEPTION 'BACKLOG-4179 pre-check: seat_limit_enforce trigger not found';
  END IF;
END
$pre$;

CREATE FUNCTION public._one_brokerage_per_member()
 RETURNS trigger
 LANGUAGE plpgsql
 VOLATILE
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
BEGIN
  IF NEW.user_id IS NULL THEN
    RETURN NEW;
  END IF;

  -- A personal organization (or none: the foreign key refuses it) is not a brokerage.
  IF NOT EXISTS (
    SELECT 1 FROM public.organizations o
     WHERE o.id = NEW.organization_id
       AND o.personal_owner_user_id IS NULL
  ) THEN
    RETURN NEW;
  END IF;

  -- One brokerage writer per person at a time (same key as _retire_personal_membership).
  PERFORM pg_advisory_xact_lock(hashtextextended(NEW.user_id::text, 3364));

  -- Read after the lock: a writer that committed while we waited is visible here.
  IF EXISTS (
    SELECT 1
      FROM public.organization_members m
      JOIN public.organizations o ON o.id = m.organization_id
     WHERE m.user_id = NEW.user_id
       AND m.id <> NEW.id
       AND o.personal_owner_user_id IS NULL
  ) THEN
    RAISE EXCEPTION 'already_placed' USING ERRCODE = 'P0001',
      DETAIL = 'BACKLOG-4179: this person already has a membership in another brokerage';
  END IF;

  RETURN NEW;
END;
$function$;

REVOKE EXECUTE ON FUNCTION public._one_brokerage_per_member() FROM PUBLIC, anon, authenticated;

CREATE TRIGGER single_brokerage_guard
  BEFORE INSERT OR UPDATE OF user_id, organization_id ON public.organization_members
  FOR EACH ROW
  WHEN (NEW.user_id IS NOT NULL)
  EXECUTE FUNCTION public._one_brokerage_per_member();

-- POSTCHECK BEGIN
DO $post$
DECLARE
  f record;
  t record;
BEGIN
  SELECT p.provolatile, p.prosecdef, p.proconfig, p.proacl INTO f
    FROM pg_proc p WHERE p.oid = 'public._one_brokerage_per_member()'::regprocedure;
  IF f.provolatile IS DISTINCT FROM 'v' THEN
    RAISE EXCEPTION 'BACKLOG-4179 postcheck: _one_brokerage_per_member is not VOLATILE (%)', f.provolatile;
  END IF;
  IF f.prosecdef IS NOT TRUE OR f.proconfig IS DISTINCT FROM ARRAY['search_path=""'] THEN
    RAISE EXCEPTION 'BACKLOG-4179 postcheck: definer/search_path wrong (%, %)', f.prosecdef, f.proconfig;
  END IF;
  IF EXISTS (SELECT 1 FROM aclexplode(f.proacl) a WHERE a.grantee = 0 AND a.privilege_type = 'EXECUTE')
     OR has_function_privilege('anon', 'public._one_brokerage_per_member()', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public._one_brokerage_per_member()', 'EXECUTE') THEN
    RAISE EXCEPTION 'BACKLOG-4179 postcheck: a client role can execute _one_brokerage_per_member';
  END IF;

  SELECT tg.tgenabled, tg.tgtype, tg.tgconstraint, tg.tgfoid, tg.tgqual IS NOT NULL AS has_when,
         (SELECT array_agg(a.attname::text ORDER BY a.attname)
            FROM unnest(tg.tgattr::int2[]) k JOIN pg_attribute a
              ON a.attrelid = tg.tgrelid AND a.attnum = k) AS cols
    INTO t
    FROM pg_trigger tg
   WHERE tg.tgrelid = 'public.organization_members'::regclass
     AND tg.tgname = 'single_brokerage_guard';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'BACKLOG-4179 postcheck: trigger single_brokerage_guard missing';
  END IF;
  IF t.tgenabled IS DISTINCT FROM 'O' THEN
    RAISE EXCEPTION 'BACKLOG-4179 postcheck: single_brokerage_guard tgenabled is % (want O)', t.tgenabled;
  END IF;
  -- 23 = ROW | BEFORE | INSERT | UPDATE
  IF t.tgtype <> 23 OR t.tgconstraint <> 0 OR NOT t.has_when
     OR t.tgfoid <> 'public._one_brokerage_per_member()'::regprocedure
     OR t.cols IS DISTINCT FROM ARRAY['organization_id', 'user_id'] THEN
    RAISE EXCEPTION 'BACKLOG-4179 postcheck: single_brokerage_guard shape wrong (type %, constraint %, when %, cols %)',
      t.tgtype, t.tgconstraint, t.has_when, t.cols;
  END IF;
  IF NOT ('single_brokerage_guard' > 'seat_limit_enforce' COLLATE "C") THEN
    RAISE EXCEPTION 'BACKLOG-4179 postcheck: trigger name does not sort after seat_limit_enforce';
  END IF;
END
$post$;
-- POSTCHECK END
