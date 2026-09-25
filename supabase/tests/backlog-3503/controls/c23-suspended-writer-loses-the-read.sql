-- C23: a DEACTIVATED broker, and a DEACTIVATED admin, read nothing on EITHER
-- table -- while the ACTIVE broker of the same organization reads everything.
--
-- The founder's ruling, applied to the people who set pay: "no no accese if they
-- are deactivted" was said about agents, and the person who decides an agent's
-- split is not the exception to it. C21 is this rule for an agent's own row;
-- this is the office-wide read that a broker or admin holds.
--
-- Deactivation is the SAME shape here as it is for an agent -- deactivateUser.ts
-- has one path, not one per role: the organization_members row stays and
-- license_status moves to 'suspended'. So the role term in
-- can_write_split_agreements still matches and the organization term still
-- matches; only the status term refuses. Mutant m35 is that rule without its
-- status term, and this control is one of its two reds.
--
-- BOTH HALVES ARE LOAD-BEARING. The denial alone cannot tell "the status term
-- works" from "nobody reads anything" -- a helper stuck at false would satisfy
-- it. The active broker's counts, asserted in the same transaction against the
-- same rows, are what separate those.
--
-- The fixture state is asserted first, as postgres. A zero that comes from a
-- typo'd uuid or a missing membership row proves nothing and looks identical
-- from here.

DO $$
DECLARE st text; rl text; who text; n int;
BEGIN
  FOREACH who IN ARRAY ARRAY['broker', 'admin'] LOOP
    SELECT license_status, role INTO st, rl FROM public.organization_members
     WHERE organization_id = current_setting('t3503.o_a')::uuid
       AND user_id = current_setting('t3503.u_' || who || '_sus')::uuid;
    PERFORM pg_temp.check(st = 'suspended',
      format('precondition: the deactivated %s is suspended, got %s', who, coalesce(st, 'NO MEMBERSHIP ROW')));
    PERFORM pg_temp.check(rl = who,
      format('precondition: ...and still carries the %s role, got %s', who, coalesce(rl, 'NO MEMBERSHIP ROW')));
  END LOOP;
  SELECT count(*) INTO n FROM public.agent_split_agreements
   WHERE organization_id = current_setting('t3503.o_a')::uuid;
  PERFORM pg_temp.check(n = 7, format('precondition: org A holds 7 agreement rows, got %s', n));
  SELECT count(*) INTO n FROM public.organization_franchise_fees
   WHERE organization_id = current_setting('t3503.o_a')::uuid;
  PERFORM pg_temp.check(n = 3, format('precondition: org A holds 3 franchise fee rows, got %s', n));
END $$;

-- the deactivated writers: nothing, on either table, by either path
DO $$
DECLARE who text; n int;
BEGIN
  FOREACH who IN ARRAY ARRAY['broker', 'admin'] LOOP
    PERFORM pg_temp.act_as(current_setting('t3503.u_' || who || '_sus')::uuid);

    SELECT count(*) INTO n FROM public.agent_split_agreements;
    PERFORM pg_temp.check(n = 0, format('a deactivated %s reads 0 agreement rows, got %s', who, n));
    SELECT count(*) INTO n FROM public.organization_franchise_fees;
    PERFORM pg_temp.check(n = 0, format('a deactivated %s reads 0 franchise fee rows, got %s', who, n));

    -- and through the read paths BACKLOG-3504 uses
    SELECT count(*) INTO n FROM public.split_agreement_in_force(
      current_setting('t3503.o_a')::uuid, current_setting('t3503.u_agent_a')::uuid, DATE '2026-09-01');
    PERFORM pg_temp.check(n = 0,
      format('...and 0 through split_agreement_in_force, got %s', n));
    SELECT count(*) INTO n FROM public.franchise_fee_in_force(
      current_setting('t3503.o_a')::uuid, DATE '2026-09-01');
    PERFORM pg_temp.check(n = 0, format('...and 0 through franchise_fee_in_force, got %s', n));

    RESET ROLE;
  END LOOP;
END $$;
RESET ROLE;

-- the ACTIVE broker of the same organization, over the same rows
SELECT pg_temp.act_as(current_setting('t3503.u_broker_a')::uuid);
DO $$
DECLARE n int;
BEGIN
  SELECT count(*) INTO n FROM public.agent_split_agreements;
  PERFORM pg_temp.check(n = 7, format('the active broker still reads all 7 agreement rows, got %s', n));
  SELECT count(*) INTO n FROM public.organization_franchise_fees;
  PERFORM pg_temp.check(n = 3, format('...and all three franchise fee rows, got %s', n));
  SELECT count(*) INTO n FROM public.split_agreement_in_force(
    current_setting('t3503.o_a')::uuid, current_setting('t3503.u_agent_a')::uuid, DATE '2026-09-01');
  PERFORM pg_temp.check(n = 1, format('...and 1 through split_agreement_in_force, got %s', n));
  SELECT count(*) INTO n FROM public.franchise_fee_in_force(
    current_setting('t3503.o_a')::uuid, DATE '2026-09-01');
  PERFORM pg_temp.check(n = 1, format('...and 1 through franchise_fee_in_force, got %s', n));
END $$;
RESET ROLE;
