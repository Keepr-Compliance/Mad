-- BACKLOG-3503 control fixtures.
-- ALL IDENTIFIERS INVENTED: uuids in the 00000000-0000-4000-8000-00003503xxxx block,
-- emails under the reserved .example.test domain. The venue holds ZERO real rows
-- (measured: users=0, organizations=0, transaction_submissions=0).
--
-- The same-day pair R2/R3 is the long-transaction shape: R3 has an EARLIER set_at
-- but a LATER seq, because its transaction began earlier and executed its INSERT
-- later. It is the row a broker wrote last, so it must win. F2/F3 are the same
-- shape on the franchise-fee table: without them, ordering that table by set_at
-- returns the same right answer as ordering it by seq, and the D2 ordering
-- contract is unpinned on the second table (control C14, mutant m37).
--
-- Two agents model losing access to an organization, because the product does it
-- two different ways: u_agent_sus is DEACTIVATED (membership row survives at
-- license_status 'suspended') and u_agent_gone is REMOVED (membership row
-- deleted). Both hold an org-A agreement. Controls C21 and C22.
--
-- u_broker_sus and u_admin_sus are the DEACTIVATED shape applied to the people
-- who SET pay. They hold NO agreement rows of their own -- what they lose is the
-- office-wide read and the write, not a row about themselves -- so adding them
-- changes no count anywhere. Controls C23 and C24.
--
-- u_agent_exp is a member who was deactivated and then EXPIRED, so their row
-- carries a deactivation date at a status that is neither 'active' nor
-- 'suspended'. They hold no agreement either, so they change no count. Control
-- C29 -- the status gate on the INSERT policy's date arm.
--
-- ALL FOUR of those rows are created ACTIVE and moved by UPDATE, because that is
-- how the product moves them and because the trigger that records the date only
-- fires on an UPDATE. The long note beside that UPDATE says what inserting them
-- at 'suspended' would have cost.
--
-- Org A therefore holds 7 agreement rows and the venue 8; C6 and C18 count them.
-- Org A holds 3 franchise fee rows and the venue 4; C18 and C23 count them.

DO $fixtures$
DECLARE
  u_broker_a   uuid := '00000000-0000-4000-8000-000035030001'; -- pii-allow-uuid: invented fixture id
  u_admin_a    uuid := '00000000-0000-4000-8000-000035030002'; -- pii-allow-uuid: invented fixture id
  u_agent_a    uuid := '00000000-0000-4000-8000-000035030003'; -- pii-allow-uuid: invented fixture id
  u_agent_a2   uuid := '00000000-0000-4000-8000-000035030004'; -- pii-allow-uuid: invented fixture id
  u_itadmin_a  uuid := '00000000-0000-4000-8000-000035030005'; -- pii-allow-uuid: invented fixture id
  u_broker_b   uuid := '00000000-0000-4000-8000-000035030006'; -- pii-allow-uuid: invented fixture id
  u_agent_b    uuid := '00000000-0000-4000-8000-000035030007'; -- pii-allow-uuid: invented fixture id
  u_nomember   uuid := '00000000-0000-4000-8000-000035030008'; -- pii-allow-uuid: invented fixture id
  u_agent_sus  uuid := '00000000-0000-4000-8000-000035030009'; -- pii-allow-uuid: invented fixture id
  u_agent_gone uuid := '00000000-0000-4000-8000-000035030010'; -- pii-allow-uuid: invented fixture id
  u_broker_sus uuid := '00000000-0000-4000-8000-000035030011'; -- pii-allow-uuid: invented fixture id
  u_admin_sus  uuid := '00000000-0000-4000-8000-000035030012'; -- pii-allow-uuid: invented fixture id
  u_agent_exp  uuid := '00000000-0000-4000-8000-000035030013'; -- pii-allow-uuid: invented fixture id
  o_a          uuid := '00000000-0000-4000-8000-00003503a0a0'; -- pii-allow-uuid: invented fixture id
  o_b          uuid := '00000000-0000-4000-8000-00003503b0b0'; -- pii-allow-uuid: invented fixture id
  r record;
  v_left int;
  v_dat  timestamptz;
  v_n    int;
  v_st   text;
BEGIN
  PERFORM set_config('t3503.u_broker_a',  u_broker_a::text,  true);
  PERFORM set_config('t3503.u_admin_a',   u_admin_a::text,   true);
  PERFORM set_config('t3503.u_agent_a',   u_agent_a::text,   true);
  PERFORM set_config('t3503.u_agent_a2',  u_agent_a2::text,  true);
  PERFORM set_config('t3503.u_itadmin_a', u_itadmin_a::text, true);
  PERFORM set_config('t3503.u_broker_b',  u_broker_b::text,  true);
  PERFORM set_config('t3503.u_agent_b',   u_agent_b::text,   true);
  PERFORM set_config('t3503.u_nomember',  u_nomember::text,  true);
  PERFORM set_config('t3503.u_agent_sus',  u_agent_sus::text,  true);
  PERFORM set_config('t3503.u_agent_gone', u_agent_gone::text, true);
  PERFORM set_config('t3503.u_broker_sus', u_broker_sus::text, true);
  PERFORM set_config('t3503.u_admin_sus',  u_admin_sus::text,  true);
  PERFORM set_config('t3503.u_agent_exp',  u_agent_exp::text,  true);
  PERFORM set_config('t3503.o_a',         o_a::text,         true);
  PERFORM set_config('t3503.o_b',         o_b::text,         true);

  FOR r IN SELECT * FROM (VALUES
      (u_broker_a,'broker-a'), (u_admin_a,'admin-a'), (u_agent_a,'agent-a'),
      (u_agent_a2,'agent-a2'), (u_itadmin_a,'itadmin-a'), (u_broker_b,'broker-b'),
      (u_agent_b,'agent-b'), (u_nomember,'nomember'),
      (u_agent_sus,'agent-sus'), (u_agent_gone,'agent-gone'),
      (u_broker_sus,'broker-sus'), (u_admin_sus,'admin-sus'),
      (u_agent_exp,'agent-exp')) v(id, label)
  LOOP
    INSERT INTO auth.users (id, email, aud, role, raw_app_meta_data, raw_user_meta_data)
    VALUES (r.id, r.label || '@fixture-3503.example.test', 'authenticated', 'authenticated',
            jsonb_build_object('provider','email'), '{}'::jsonb);
    INSERT INTO public.users (id, email, oauth_provider, oauth_id)
    VALUES (r.id, r.label || '@fixture-3503.example.test', 'email', 'fixture-3503-' || r.label);
  END LOOP;

  INSERT INTO public.organizations (id, name, slug, max_seats) VALUES
    (o_a, 'Fixture Brokerage 3503 A', 'fixture-3503-brokerage-a', 10),
    (o_b, 'Fixture Brokerage 3503 B', 'fixture-3503-brokerage-b', 10);

  INSERT INTO public.organization_members (organization_id, user_id, role, license_status, joined_at) VALUES
    (o_a, u_broker_a,  'broker',   'active', now()),
    (o_a, u_admin_a,   'admin',    'active', now()),
    (o_a, u_agent_a,   'agent',    'active', now()),
    (o_a, u_agent_a2,  'agent',    'active', now()),
    (o_a, u_itadmin_a, 'it_admin', 'active', now()),
    (o_b, u_broker_b,  'broker',   'active', now()),
    (o_b, u_agent_b,   'agent',    'active', now()),
    -- The DEACTIVATED shape, and the EXPIRED one, are BOTH created ACTIVE here
    -- and moved by UPDATE below. That is not tidiness -- see the block after
    -- this INSERT for why inserting them at 'suspended' would have made the
    -- whole boundary sweep vacuous.
    (o_a, u_agent_sus,  'agent',  'active', now()),
    (o_a, u_broker_sus, 'broker', 'active', now()),
    (o_a, u_admin_sus,  'admin',  'active', now()),
    (o_a, u_agent_exp,  'agent',  'active', now()),
    -- The REMOVED shape, staged in two steps below: this row is inserted the
    -- way any member's is, then DELETEd, because that is what removeUser.ts
    -- does. u_agent_gone is ALSO an active member of org B -- an agent who
    -- moved brokerages -- so a read rule that checks "is an active member of
    -- SOME org" rather than "of THIS org" still answers yes for them, and C22
    -- can see the difference. Mutant m34 is that mistake.
    (o_a, u_agent_gone, 'agent', 'active', now()),
    (o_b, u_agent_gone, 'agent', 'active', now());

  -- ---- DEACTIVATION HAPPENS THE WAY PRODUCTION DOES IT: BY UPDATE ------------
  -- deactivateUser.ts, both SCIM paths and directory-sync all move an EXISTING
  -- row from 'active' to 'suspended'. None of them inserts a row already
  -- suspended. So these fixtures do the same, and organization_members.
  -- deactivated_at is written by the trigger rather than by hand.
  --
  -- WHY THAT MATTERS MORE THAN IT LOOKS. Inserting these rows at 'suspended'
  -- -- which is what this file did before the date rule existed -- fires no
  -- BEFORE UPDATE trigger, so every one of them would carry deactivated_at
  -- NULL. Every suspended-subject assertion in C25, C27 and C28 would then be
  -- refused by the IS NOT NULL guard and NEVER REACH THE DATE COMPARISON. All
  -- of them would report GREEN, the date logic would be entirely untested, and
  -- the mutants that move the boundary would red nothing. A hand-written
  -- deactivated_at would hide the same hole one layer further down, by proving
  -- the policy works on a value no producer had to generate.
  UPDATE public.organization_members SET license_status = 'suspended'
   WHERE organization_id = o_a
     AND user_id IN (u_agent_sus, u_broker_sus, u_admin_sus, u_agent_exp);

  -- u_agent_exp then EXPIRES. The trigger leaves deactivated_at alone on a move
  -- to 'expired', so this row ends up at a status that is neither 'active' nor
  -- 'suspended' while still carrying a date -- the exact shape the status gate
  -- in the INSERT policy's second arm exists to refuse. Control C29 is that
  -- refusal; without this row the gate could be deleted and nothing would move.
  UPDATE public.organization_members SET license_status = 'expired'
   WHERE organization_id = o_a AND user_id = u_agent_exp;

  -- The fixture PROVES the trigger fired rather than assuming it. If the
  -- trigger is ever broken or dropped, every control that depends on a
  -- deactivation date fails HERE, loudly, instead of passing for the wrong
  -- reason.
  SELECT count(*) INTO v_n FROM public.organization_members
   WHERE organization_id = o_a
     AND user_id IN (u_agent_sus, u_broker_sus, u_admin_sus, u_agent_exp)
     AND deactivated_at IS NOT NULL;
  IF v_n <> 4 THEN
    RAISE EXCEPTION 'FIXTURE FAILED: the deactivation trigger did not stamp all four rows (got % of 4)', v_n;
  END IF;

  SELECT license_status INTO v_st FROM public.organization_members
   WHERE organization_id = o_a AND user_id = u_agent_exp;
  IF v_st IS DISTINCT FROM 'expired' THEN
    RAISE EXCEPTION 'FIXTURE FAILED: the expired subject is at %, not expired', coalesce(v_st,'NULL');
  END IF;

  -- Publish the deactivation date so controls can place effective_from on
  -- either side of it. now() is CONSTANT for the whole transaction, so all four
  -- rows share one instant -- which is why controls express their dates as
  -- offsets from this value and never as literals.
  SELECT deactivated_at INTO v_dat FROM public.organization_members
   WHERE organization_id = o_a AND user_id = u_agent_sus;
  PERFORM set_config('t3503.d_sus', ((v_dat AT TIME ZONE 'UTC')::date)::text, true);

  -- Agreements. set_by is supplied explicitly: fixtures run as postgres, where
  -- auth.uid() is NULL and the column default cannot satisfy NOT NULL (probe P1).
  -- R2 then R3 share effective_from; R3 is inserted second (higher seq) with an
  -- EARLIER set_at.
  INSERT INTO public.agent_commission_agreements
    (organization_id, agent_user_id, agent_pct, brokerage_pct, office_fee_amount,
     office_fee_cadence, effective_from, set_by, set_at) VALUES
    (o_a, u_agent_a,  60.00, 40.00, 100.00, 'monthly', DATE '2026-01-01', u_broker_a, TIMESTAMPTZ '2026-01-01 09:00:00+00'), -- R1
    (o_a, u_agent_a,  50.00, 50.00, 150.00, 'monthly', DATE '2026-06-01', u_broker_a, TIMESTAMPTZ '2026-06-01 10:05:00+00'), -- R2 mistake, later set_at
    (o_a, u_agent_a,  80.00, 20.00, 150.00, 'monthly', DATE '2026-06-01', u_broker_a, TIMESTAMPTZ '2026-06-01 10:00:00+00'), -- R3 correction, earlier set_at, later seq
    (o_a, u_agent_a,  90.00, 10.00, 200.00, 'annual',  DATE '2026-12-01', u_broker_a, TIMESTAMPTZ '2026-11-01 09:00:00+00'), -- R4 future
    (o_a, u_agent_a2, 70.00, 30.00,  75.00, 'monthly', DATE '2026-01-01', u_broker_a, TIMESTAMPTZ '2026-01-01 09:00:00+00'), -- colleague
    (o_b, u_agent_b,  55.00, 45.00, 999.00, 'annual',  DATE '2026-01-01', u_broker_b, TIMESTAMPTZ '2026-01-01 09:00:00+00'), -- other org
    (o_a, u_agent_sus,  65.00, 35.00, 120.00, 'monthly', DATE '2026-01-01', u_broker_a, TIMESTAMPTZ '2026-01-01 09:00:00+00'), -- deactivated agent
    (o_a, u_agent_gone, 45.00, 55.00, 130.00, 'monthly', DATE '2026-01-01', u_broker_a, TIMESTAMPTZ '2026-01-01 09:00:00+00'); -- removed agent

  -- The second half of the REMOVED shape. Written after the agreement on
  -- purpose: nothing in this migration references organization_members, so an
  -- agreement must not block the membership DELETE that removeUser.ts issues.
  -- If a later edit adds such a reference, this line raises 23503 and every
  -- control in the suite turns RED at once, which is the right blast radius.
  DELETE FROM public.organization_members
   WHERE organization_id = o_a AND user_id = u_agent_gone;
  SELECT count(*) INTO v_left FROM public.organization_members
   WHERE organization_id = o_a AND user_id = u_agent_gone;
  IF v_left <> 0 THEN
    RAISE EXCEPTION 'FIXTURE FAILED: the removed agent still has an org-A membership row';
  END IF;

  -- F2/F3 repeat R2/R3's shape on this table: they share effective_from, F3 is
  -- inserted second (higher seq) with an EARLIER set_at, and F3 is the one the
  -- broker wrote last, so it must win. Without this pair, ordering this helper
  -- by set_at returns the same answer as ordering it by seq and no control can
  -- tell the two apart -- which is what mutant m37 exists to show.
  INSERT INTO public.organization_franchise_fees
    (organization_id, amount, effective_from, set_by, set_at) VALUES
    (o_a, 2000.00, DATE '2026-01-01', u_broker_a, TIMESTAMPTZ '2026-01-01 09:00:00+00'), -- F1
    (o_a, 2750.00, DATE '2026-06-01', u_broker_a, TIMESTAMPTZ '2026-06-01 10:05:00+00'), -- F2 mistake, later set_at
    (o_a, 2500.00, DATE '2026-06-01', u_broker_a, TIMESTAMPTZ '2026-06-01 10:00:00+00'), -- F3 correction, earlier set_at, later seq
    (o_b, 9999.00, DATE '2026-01-01', u_broker_b, TIMESTAMPTZ '2026-01-01 09:00:00+00');
END
$fixtures$;

-- pg_temp.check(ok, label): raises unless ok IS TRUE, and counts. run.sh refuses a
-- GREEN with zero assertions, so a control that matched nothing cannot pass.
CREATE FUNCTION pg_temp.check(ok boolean, label text) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  IF ok IS NOT TRUE THEN RAISE EXCEPTION 'CONTROL FAILED: %', label; END IF;
  PERFORM set_config('t3503.asserts', (current_setting('t3503.asserts')::int + 1)::text, true);
END $$;

-- pg_temp.act_as(uid): the PostgREST request shape. act_as(NULL) with p_role
-- 'anon' is the signed-out shape. RESET ROLE returns to postgres.
CREATE FUNCTION pg_temp.act_as(uid uuid, p_role text DEFAULT 'authenticated') RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM set_config('request.jwt.claim.sub', coalesce(uid::text, ''), true);
  PERFORM set_config('role', p_role, true);
END $$;

-- pg_temp.sqlstate_of(stmt): runs stmt, returns the SQLSTATE it raised or 'OK'.
CREATE FUNCTION pg_temp.sqlstate_of(stmt text) RETURNS text
LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE stmt;
  RETURN 'OK';
EXCEPTION WHEN OTHERS THEN
  RETURN SQLSTATE;
END $$;

-- pg_temp.constraint_of(stmt): runs stmt, returns the CONSTRAINT NAME it raised
-- on, or 'OK'. SQLSTATE alone is not enough for the FK controls: several
-- constraints on several tables all raise 23503, so a control asserting only
-- the SQLSTATE would go green off a neighbouring table's foreign key and would
-- stay green if this migration's own key were later written ON DELETE CASCADE.
CREATE FUNCTION pg_temp.constraint_of(stmt text) RETURNS text
LANGUAGE plpgsql AS $$
DECLARE c text;
BEGIN
  EXECUTE stmt;
  RETURN 'OK';
EXCEPTION WHEN OTHERS THEN
  GET STACKED DIAGNOSTICS c = CONSTRAINT_NAME;
  RETURN coalesce(nullif(c, ''), 'SQLSTATE:' || SQLSTATE);
END $$;

SELECT set_config('t3503.asserts', '0', true) IS NOT NULL AS fixtures_loaded;
