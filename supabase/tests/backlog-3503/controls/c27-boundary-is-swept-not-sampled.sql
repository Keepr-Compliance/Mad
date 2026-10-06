-- C27: the date boundary, SWEPT rather than sampled -- both sides of it, the
-- boundary day itself, the NULL case, and the timezone the comparison resolves
-- against.
--
-- One input per branch cannot catch an off-by-one, and a single sampled date
-- inside the period cannot tell `<=` from `<`. Every arm below is a separate
-- mutant's red:
--   d_sus - 1  allowed
--   d_sus      allowed   <- the boundary is INCLUSIVE. Mutant m41 is `<`.
--   d_sus + 1  refused
--   NULL date  refused   <- fail closed. No mutant pins it; see the note below.
--   non-UTC session      <- mutant m40 drops the UTC pin, and this is the ONLY
--                           condition under which the two spellings differ.
--
-- WHY THE DATES ARE OFFSETS AND NOT LITERALS: t3503.d_sus is read back out of
-- organization_members.deactivated_at, which the trigger wrote during fixtures.
-- now() is constant for the transaction, so the deactivation instant is whatever
-- the run's transaction time is. Nothing here may assume a value the producer
-- did not generate.

SELECT pg_temp.act_as(current_setting('t3503.u_broker_a')::uuid);
DO $$
DECLARE s text; d date; sus uuid; org uuid;
BEGIN
  d   := current_setting('t3503.d_sus')::date;
  sus := current_setting('t3503.u_agent_sus')::uuid;
  org := current_setting('t3503.o_a')::uuid;

  -- the day BEFORE the deactivation: inside the period, allowed.
  s := pg_temp.sqlstate_of(format(
    'INSERT INTO public.agent_split_agreements (organization_id, agent_user_id, agent_pct, brokerage_pct, effective_from) VALUES (%L,%L,50,50,%L::date)',
    org, sus, d - 1));
  PERFORM pg_temp.check(s = 'OK', format('the day BEFORE the deactivation is allowed, got %s', s));

  -- the day OF the deactivation: still inside. They worked that morning.
  s := pg_temp.sqlstate_of(format(
    'INSERT INTO public.agent_split_agreements (organization_id, agent_user_id, agent_pct, brokerage_pct, effective_from) VALUES (%L,%L,51,49,%L::date)',
    org, sus, d));
  PERFORM pg_temp.check(s = 'OK', format('the day OF the deactivation is allowed -- the boundary is inclusive, got %s', s));

  -- the day AFTER: outside. Refused by the WITH CHECK, so 42501 specifically.
  s := pg_temp.sqlstate_of(format(
    'INSERT INTO public.agent_split_agreements (organization_id, agent_user_id, agent_pct, brokerage_pct, effective_from) VALUES (%L,%L,52,48,%L::date)',
    org, sus, d + 1));
  PERFORM pg_temp.check(s = '42501', format('the day AFTER the deactivation is refused with 42501, got %s', s));

  -- and the rows landed, or did not, to match -- an arm that only inspects the
  -- SQLSTATE cannot see a policy that permits the write and drops the row.
  PERFORM pg_temp.check(
    (SELECT count(*) FROM public.agent_split_agreements
      WHERE agent_user_id = sus AND effective_from IN (d - 1, d)) = 2,
    'both in-period rows landed');
  PERFORM pg_temp.check(
    (SELECT count(*) FROM public.agent_split_agreements
      WHERE agent_user_id = sus AND effective_from = d + 1) = 0,
    'the out-of-period row did not land');
END $$;
RESET ROLE;

-- ---- the NULL case --------------------------------------------------------
-- A suspended row with no recorded date must FAIL CLOSED. It is reachable two
-- ways: a writer that bypasses the trigger (a plain INSERT at 'suspended' --
-- no BEFORE UPDATE trigger sees one), and history predating the column.
--
-- MEASURED, AND THE MEASUREMENT CHANGED WHAT SHIPPED: this arm does NOT
-- distinguish the shipped rule from one with `m.deactivated_at IS NOT NULL`
-- deleted. NULL propagates through the comparison to NULL, NULL is not TRUE,
-- and the row is refused either way. The mutant that deletes that guard was
-- written, run against the whole suite, and reddened NOTHING -- so it is an
-- EQUIVALENT mutant and was removed rather than shipped as a permanently green
-- one. The guard itself stays, for the reasons the migration gives, and the CI
-- text test asserts its literal presence. This arm still earns its place: it
-- pins the BEHAVIOUR (a suspended row with no date fails closed) regardless of
-- which spelling produces it.
DO $$
BEGIN
  UPDATE public.organization_members SET deactivated_at = NULL
   WHERE organization_id = current_setting('t3503.o_a')::uuid
     AND user_id = current_setting('t3503.u_admin_sus')::uuid;
  PERFORM pg_temp.check(
    (SELECT deactivated_at IS NULL AND license_status = 'suspended'
       FROM public.organization_members
      WHERE organization_id = current_setting('t3503.o_a')::uuid
        AND user_id = current_setting('t3503.u_admin_sus')::uuid),
    'precondition: a suspended row with no recorded date exists');
END $$;
SELECT pg_temp.act_as(current_setting('t3503.u_broker_a')::uuid);
DO $$
DECLARE s text;
BEGIN
  s := pg_temp.sqlstate_of(format(
    'INSERT INTO public.agent_split_agreements (organization_id, agent_user_id, agent_pct, brokerage_pct, effective_from) VALUES (%L,%L,50,50,%L::date)',
    current_setting('t3503.o_a'), current_setting('t3503.u_admin_sus'),
    current_setting('t3503.d_sus')::date - 1));
  PERFORM pg_temp.check(s = '42501',
    format('a suspended member with NO recorded date is refused, whatever the agreement is dated, got %s', s));
END $$;
RESET ROLE;

-- ---- the timezone the comparison resolves against -------------------------
-- deactivated_at is timestamptz and effective_from is date, so one must be
-- converted. A bare ::date resolves against the SESSION TimeZone; the shipped
-- rule pins UTC. Production runs UTC on every role today (pg_db_role_setting
-- carries no TimeZone for anon, authenticated, authenticator or postgres), so
-- the two spellings agree there by coincidence of configuration -- which is
-- exactly why this arm exists and why it sets a non-UTC zone explicitly.
--
-- The INSTANT is pinned here rather than taken from the trigger, because the
-- trigger's now() lands at whatever hour the run happens at and a timezone
-- boundary needs a known hour. 01:00 UTC is 18:00 the PREVIOUS day in
-- America/Los_Angeles, so the UTC date and the local date differ. The STATE is
-- still the trigger's -- the row is suspended because fixtures.sql deactivated
-- it -- and the assertion below proves the pinned instant is what is on the row.
DO $$
BEGIN
  UPDATE public.organization_members
     SET deactivated_at = TIMESTAMPTZ '2026-05-15 01:00:00+00'
   WHERE organization_id = current_setting('t3503.o_a')::uuid
     AND user_id = current_setting('t3503.u_broker_sus')::uuid;
  PERFORM pg_temp.check(
    (SELECT deactivated_at = TIMESTAMPTZ '2026-05-15 01:00:00+00' AND license_status = 'suspended'
       FROM public.organization_members
      WHERE organization_id = current_setting('t3503.o_a')::uuid
        AND user_id = current_setting('t3503.u_broker_sus')::uuid),
    'precondition: a suspended row deactivated at 01:00 UTC on a known day');
  -- the two readings really do differ in this zone, or the arm proves nothing
  PERFORM pg_temp.check(
    (TIMESTAMPTZ '2026-05-15 01:00:00+00' AT TIME ZONE 'UTC')::date
      <> (TIMESTAMPTZ '2026-05-15 01:00:00+00' AT TIME ZONE 'America/Los_Angeles')::date,
    'precondition: the UTC date and the Los Angeles date of that instant differ');
END $$;
SELECT pg_temp.act_as(current_setting('t3503.u_broker_a')::uuid);
SET LOCAL TimeZone = 'America/Los_Angeles';
DO $$
DECLARE s text;
BEGIN
  PERFORM pg_temp.check(current_setting('TimeZone') = 'America/Los_Angeles',
    format('precondition: this session is NOT on UTC, got %s', current_setting('TimeZone')));
  -- dated 2026-05-15, the UTC date of the deactivation. Under the shipped rule
  -- that is the boundary day and is allowed. Under a session-dependent ::date
  -- the deactivation reads as 2026-05-14 and this is refused.
  s := pg_temp.sqlstate_of(format(
    'INSERT INTO public.agent_split_agreements (organization_id, agent_user_id, agent_pct, brokerage_pct, effective_from) VALUES (%L,%L,50,50,DATE ''2026-05-15'')',
    current_setting('t3503.o_a'), current_setting('t3503.u_broker_sus')));
  PERFORM pg_temp.check(s = 'OK',
    format('the comparison resolves against UTC, not the session timezone, got %s', s));
END $$;
RESET ROLE;
SET LOCAL TimeZone = 'UTC';
