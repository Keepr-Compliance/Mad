-- C4b: broker AND admin of the org can insert. Paired with C4:
-- the is_org_admin mutant must turn BOTH red (it admits it_admin, excludes broker).
DO $$
DECLARE s text; u text; who text;
BEGIN
  -- The failure message names the ROLE, never the fixture uuid: these messages
  -- land in mutant-run.txt, which is committed, and a bare uuid in a tracked
  -- file is a finding (scripts/ci/check-fixture-pii.mjs).
  FOREACH who IN ARRAY ARRAY['broker', 'admin'] LOOP
    u := current_setting('t3503.u_' || who || '_a');
    PERFORM pg_temp.act_as(u::uuid);
    s := pg_temp.sqlstate_of(format(
      'INSERT INTO public.agent_split_agreements (organization_id, agent_user_id, agent_pct, brokerage_pct, effective_from) VALUES (%L,%L,65,35,DATE ''2026-07-01'')',
      current_setting('t3503.o_a'), current_setting('t3503.u_agent_a')));
    PERFORM pg_temp.check(s = 'OK', format('agreement INSERT permitted for the org %s, got %s', who, s));
    RESET ROLE;
  END LOOP;
END $$;
RESET ROLE;
