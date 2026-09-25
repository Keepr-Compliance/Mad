-- C18: the privilege-level control. Everything C05 and C06 assert is a SQLSTATE
-- at the moment of a write; this asserts the GRANT ITSELF is absent, which is a
-- different question with a different answer.
--
-- Why it exists: Supabase's default ACL grants `arwdDxtm` on every new public
-- table to anon and authenticated (measured, pg_default_acl, on production and
-- on this venue). The `D` is TRUNCATE. TRUNCATE is a TABLE-level operation --
-- row-level security never evaluates it, and no policy can refuse it. Measured
-- on this venue AT PLAN REVIEW, when the suite had eighteen controls and this
-- one was not among them: with TRUNCATE left granted, all eighteen of them
-- stayed green while the lowest-privilege signed-in fixture role emptied both
-- tables. C05/C06 do not see it (they assert on UPDATE and DELETE); C01/C02/C13
-- do not see it (they run first). `REVOKE ALL` is what takes it away, and this
-- control is what proves the REVOKE was wide enough.
--
-- The column half: set_by and set_at must not be INSERT-grantable, or a client
-- can name who set an agreement and when.
DO $$
DECLARE r text; t text; p text;
BEGIN
  FOREACH r IN ARRAY ARRAY['anon','authenticated'] LOOP
    FOREACH t IN ARRAY ARRAY['public.agent_split_agreements'] LOOP
      FOREACH p IN ARRAY ARRAY['UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER'] LOOP
        PERFORM pg_temp.check(has_table_privilege(r, t, p) = false,
          format('%s holds no %s on %s', r, p, t));
      END LOOP;
      PERFORM pg_temp.check(has_column_privilege(r, t, 'set_by', 'INSERT') = false,
        format('%s cannot name set_by on an INSERT into %s', r, t));
      PERFORM pg_temp.check(has_column_privilege(r, t, 'set_at', 'INSERT') = false,
        format('%s cannot name set_at on an INSERT into %s', r, t));
    END LOOP;
    -- anon holds no SELECT either; authenticated does, filtered by policy (C01/C02).
    PERFORM pg_temp.check(has_table_privilege(r, 'public.agent_split_agreements', 'SELECT')
                          = (r = 'authenticated'),
      format('%s SELECT on agreements is %s', r, (r = 'authenticated')));
  END LOOP;
END $$;

-- and the behaviour the privilege check stands for, run as the weakest role in
-- the fixture: an agent who cannot INSERT, cannot UPDATE and cannot read a
-- colleague's row.
SELECT pg_temp.act_as(current_setting('t3503.u_agent_a')::uuid);
DO $$
DECLARE s text; n bigint;
BEGIN
  s := pg_temp.sqlstate_of('TRUNCATE public.agent_split_agreements');
  PERFORM pg_temp.check(s = '42501', format('agent TRUNCATE of agreements refused with 42501, got %s', s));
END $$;
RESET ROLE;
DO $$
DECLARE n bigint;
BEGIN
  SELECT count(*) INTO n FROM public.agent_split_agreements;
  PERFORM pg_temp.check(n = 8, format('all eight agreement rows survive, got %s', n));
END $$;
