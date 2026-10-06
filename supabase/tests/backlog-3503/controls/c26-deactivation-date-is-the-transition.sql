-- C26: the trigger that records WHEN a membership was deactivated records the
-- TRANSITION, and nothing else.
--
-- The whole date rule rests on deactivated_at meaning "the day they left". It
-- only means that if the column is written once, on the move INTO 'suspended',
-- and never touched again while the row sits there. Three writers in the product
-- make that non-obvious:
--   * supabase/functions/scim/handlers/users.ts:824-831 writes
--     license_status = 'suspended' UNCONDITIONALLY, without reading the current
--     value -- so it re-writes 'suspended' onto rows already suspended;
--   * SCIM and directory-sync both bump scim_synced_at on such rows.
-- Written the obvious way -- IF NEW.license_status = 'suspended' THEN stamp --
-- every one of those pushes the date FORWARD, widening the active period and
-- re-admitting the agreement the rule refuses. Mutant m38 is exactly that
-- trigger, and this control is its red.
--
-- WHY IT SEEDS AN EXPLICIT PAST DATE FIRST, which looks like inventing state and
-- is not: now() is CONSTANT for the whole transaction, and run.sh wraps each
-- control in one BEGIN ... ROLLBACK. A re-stamp inside this transaction
-- therefore writes the SAME instant the column already held, and a broken
-- trigger is indistinguishable from a correct one. Seeding a past value is what
-- gives the re-stamp something visibly different to overwrite. The STATE under
-- test -- suspended, carrying a date -- is still produced by the real trigger in
-- fixtures.sql; only the instant is moved, and the first assertion below proves
-- the seed survived before anything is concluded from it.
--
-- MEASURED BEFORE THIS CONTROL WAS WRITTEN: m38 against the 26 controls that
-- existed then reddened NONE of them. The trigger's guards were invisible to
-- the entire suite.

DO $$
DECLARE d timestamptz; d0 timestamptz; seeded timestamptz := TIMESTAMPTZ '2020-03-01 12:00:00+00';
BEGIN
  -- 0. an ACTIVE member carries no deactivation date at all.
  SELECT deactivated_at INTO d FROM public.organization_members
   WHERE organization_id = current_setting('t3503.o_a')::uuid
     AND user_id = current_setting('t3503.u_agent_a')::uuid;
  PERFORM pg_temp.check(d IS NULL,
    format('an ACTIVE member has no deactivation date, got %s', coalesce(d::text, 'NULL')));

  -- 1. deactivating an active member STAMPS it.
  UPDATE public.organization_members SET license_status = 'suspended'
   WHERE organization_id = current_setting('t3503.o_a')::uuid
     AND user_id = current_setting('t3503.u_agent_a')::uuid;
  SELECT deactivated_at INTO d FROM public.organization_members
   WHERE organization_id = current_setting('t3503.o_a')::uuid
     AND user_id = current_setting('t3503.u_agent_a')::uuid;
  PERFORM pg_temp.check(d IS NOT NULL, 'deactivating an active member records the date');

  -- 2. seed the OTHER deactivated subject's date into the past, and prove the
  --    seed landed. Setting deactivated_at alone does not name license_status,
  --    so the shipped trigger does not fire; m38's trigger fires on any update
  --    and clobbers it here, which is this control's first red.
  UPDATE public.organization_members SET deactivated_at = seeded
   WHERE organization_id = current_setting('t3503.o_a')::uuid
     AND user_id = current_setting('t3503.u_agent_sus')::uuid;
  SELECT deactivated_at INTO d0 FROM public.organization_members
   WHERE organization_id = current_setting('t3503.o_a')::uuid
     AND user_id = current_setting('t3503.u_agent_sus')::uuid;
  PERFORM pg_temp.check(d0 = seeded,
    format('a write that does not name license_status leaves the date alone, got %s', coalesce(d0::text, 'NULL')));

  -- 3. RE-DEACTIVATING an already-suspended row must NOT move the date. This is
  --    the SCIM DELETE handler's shape: 'suspended' written over 'suspended'.
  UPDATE public.organization_members SET license_status = 'suspended'
   WHERE organization_id = current_setting('t3503.o_a')::uuid
     AND user_id = current_setting('t3503.u_agent_sus')::uuid;
  SELECT deactivated_at INTO d0 FROM public.organization_members
   WHERE organization_id = current_setting('t3503.o_a')::uuid
     AND user_id = current_setting('t3503.u_agent_sus')::uuid;
  PERFORM pg_temp.check(d0 = seeded,
    format('re-deactivating an already-suspended member does NOT move the date, got %s', coalesce(d0::text, 'NULL')));

  -- 4. an UNRELATED column bump must not move it either. This is the
  --    scim_synced_at / updated_at shape.
  UPDATE public.organization_members SET updated_at = now()
   WHERE organization_id = current_setting('t3503.o_a')::uuid
     AND user_id = current_setting('t3503.u_agent_sus')::uuid;
  SELECT deactivated_at INTO d0 FROM public.organization_members
   WHERE organization_id = current_setting('t3503.o_a')::uuid
     AND user_id = current_setting('t3503.u_agent_sus')::uuid;
  PERFORM pg_temp.check(d0 = seeded,
    format('an unrelated column bump does NOT move the date, got %s', coalesce(d0::text, 'NULL')));

  -- 5. REACTIVATING clears it. BACKLOG-3518 gets this for free; SCIM PatchOp
  --    active:true is the writer that reaches it today.
  UPDATE public.organization_members SET license_status = 'active'
   WHERE organization_id = current_setting('t3503.o_a')::uuid
     AND user_id = current_setting('t3503.u_agent_sus')::uuid;
  SELECT deactivated_at INTO d0 FROM public.organization_members
   WHERE organization_id = current_setting('t3503.o_a')::uuid
     AND user_id = current_setting('t3503.u_agent_sus')::uuid;
  PERFORM pg_temp.check(d0 IS NULL,
    format('reactivating a member CLEARS the date, got %s', coalesce(d0::text, 'NULL')));

  -- 6. and deactivating again re-stamps it, so the column is not one-shot.
  UPDATE public.organization_members SET license_status = 'suspended'
   WHERE organization_id = current_setting('t3503.o_a')::uuid
     AND user_id = current_setting('t3503.u_agent_sus')::uuid;
  SELECT deactivated_at INTO d0 FROM public.organization_members
   WHERE organization_id = current_setting('t3503.o_a')::uuid
     AND user_id = current_setting('t3503.u_agent_sus')::uuid;
  PERFORM pg_temp.check(d0 IS NOT NULL AND d0 <> seeded,
    'deactivating again records a NEW date');

  -- 7. a move to 'expired' leaves the date alone. That is what lets the INSERT
  --    policy's status gate have something to refuse -- see C29.
  UPDATE public.organization_members SET license_status = 'expired'
   WHERE organization_id = current_setting('t3503.o_a')::uuid
     AND user_id = current_setting('t3503.u_agent_sus')::uuid;
  SELECT deactivated_at INTO d FROM public.organization_members
   WHERE organization_id = current_setting('t3503.o_a')::uuid
     AND user_id = current_setting('t3503.u_agent_sus')::uuid;
  PERFORM pg_temp.check(d = d0,
    'expiring a deactivated member leaves the recorded date untouched');
END $$;
