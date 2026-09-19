-- BACKLOG-3096 / CONTROL 5 -- the version that was actually EXECUTED.
--
-- The four control-5-*.sql files next to this one drive two real psql sessions
-- from a shell. They are correct for a machine that has psql. The run of
-- 2026-09-05 did not have one: the only route to the database was the Supabase
-- MCP, where every call is its own session and no transaction survives between
-- calls. THIS file is the form that ran, and the recorded results come from it.
--
-- It opens two genuine concurrent backends with dblink, so it is a real race,
-- not a simulation of one:
--
--   A  BEGIN, set claim, call the RPC, and HOLD the transaction open.
--   B  BEGIN, set claim, call the RPC -- sent ASYNCHRONOUSLY, so the driving
--      session does not deadlock waiting on B while B waits on A.
--   after 3s, ask dblink_is_busy('b'):
--        1 -> B is BLOCKED on A's row lock          (the fix is present)
--        0 -> B sailed straight through uncommitted (no lock)
--   then commit A, collect B, commit B, and read the roles back.
--
-- dblink_is_busy is the observable that matters. A timing measurement alone
-- cannot tell "waited because of the lock" from "was slow"; a role assertion
-- alone cannot tell "serialized" from "ran after A finished anyway".
--
-- MEASURED 2026-09-05 on a disposable replica, admin count pre-registered
-- before each run:
--   production's unfixed body : busy=0, A=admin B=admin, admin count 2   (RED)
--   shipped body              : busy=1, A=admin B=agent, admin count 1   (GREEN, 3/3 runs,
--                               B returned 3-6 ms after A committed)
--   shipped minus FOR UPDATE  : busy=0, A=admin B=admin, admin count 2   (RED, 4/4 runs)
--
-- CONNECTION. dblink needs a password-authenticated connection back into the
-- same database; a non-superuser cannot use a trusted local socket (dblink
-- refuses with "password or GSSAPI delegated credentials required"). On the
-- 2026-09-05 run a throwaway LOGIN role was created in the disposable project
-- for this and dropped afterwards, connecting on the pooler port 6543 -- the
-- direct port 5432 refused for the reason above. Substitute your own
-- credentials in :conn below. Do NOT commit a real password to this repo.
--
-- ALL IDENTIFIERS ARE INVENTED -- see the header of control 1.
--
-- The org must be PRE-CREATED and EMPTY, and committed before this runs (the
-- racers are separate sessions and cannot see an uncommitted fixture). Run
-- control-5-setup.sql first. If the org did not exist, both sessions would
-- serialize on INSERT ... ON CONFLICT DO NOTHING -- Postgres blocks a
-- speculative insertion behind a conflicting in-flight one -- and this would
-- pass with or without FOR UPDATE.

-- psql does NOT interpolate :variables inside quoted literals, and a
-- dollar-quoted $race$ ... $race$ body counts as one. Writing :'conn' inside
-- the DO block sends it verbatim and plpgsql fails on a syntax error. Hoist it
-- into a GUC out here, and read it back inside.
\set conn 'host=localhost port=6543 dbname=postgres user=REPLACE_ME password=REPLACE_ME'
SELECT set_config('backlog3096.conn', :'conn', false);

create temp table race_out(step text, val text);

DO $race$
DECLARE
  k_conn CONSTANT TEXT := current_setting('backlog3096.conn');
  k_a    CONSTANT TEXT := '00000000-0000-4000-8000-000000309651'; -- pii-allow-uuid: invented fixture id, verified absent from every live table
  k_b    CONSTANT TEXT := '00000000-0000-4000-8000-000000309652'; -- pii-allow-uuid: invented fixture id, verified absent from every live table
  k_call CONSTANT TEXT := $q$select public.auto_provision_it_admin('fixture-tenant-3096-c5','Fixture Org 3096 C5','fixture-org-3096-c5')::text$q$;
  v_a TEXT; v_b TEXT; v_busy INT; v_drain INT; r RECORD; t0 TIMESTAMPTZ;
BEGIN
  PERFORM dblink_connect('a', k_conn);
  PERFORM dblink_connect('b', k_conn);
  PERFORM dblink_exec('a', 'BEGIN');
  PERFORM dblink_exec('b', 'BEGIN');
  PERFORM * FROM dblink('a', format($q$select set_config('request.jwt.claim.sub',%L,true)$q$, k_a)) AS t(x text);
  PERFORM * FROM dblink('b', format($q$select set_config('request.jwt.claim.sub',%L,true)$q$, k_b)) AS t(x text);

  SELECT x INTO v_a FROM dblink('a', k_call) AS t(x text);
  INSERT INTO race_out VALUES ('1. A role (A transaction still OPEN)', (v_a::jsonb)->>'role');

  PERFORM dblink_send_query('b', k_call);
  PERFORM pg_sleep(3);

  v_busy := dblink_is_busy('b');
  INSERT INTO race_out VALUES ('2. B blocked after 3s (1=blocked by the lock, 0=no lock)', v_busy::text);

  t0 := clock_timestamp();
  PERFORM dblink_exec('a', 'COMMIT');
  SELECT x INTO v_b FROM dblink_get_result('b') AS t(x text);
  INSERT INTO race_out VALUES ('3. ms for B to return after A committed',
                               round(extract(epoch from (clock_timestamp()-t0))*1000)::text);
  INSERT INTO race_out VALUES ('4. B role', COALESCE((v_b::jsonb)->>'role','<null>'));

  -- dblink_get_result must be drained until it yields no rows before the
  -- connection will accept another command. Omitting this fails the COMMIT
  -- below with "another command is already in progress".
  LOOP
    v_drain := 0;
    FOR r IN SELECT * FROM dblink_get_result('b') AS t(x text) LOOP v_drain := v_drain + 1; END LOOP;
    EXIT WHEN v_drain = 0;
  END LOOP;

  PERFORM dblink_exec('b', 'COMMIT');
  PERFORM dblink_disconnect('a');
  PERFORM dblink_disconnect('b');
END
$race$;

select step, val from race_out
union all
select '5. ROLE of racer A', COALESCE((select role from organization_members
   where organization_id='00000000-0000-4000-8000-00003096c5f0' -- pii-allow-uuid: invented fixture id, verified absent from every live table
     and user_id='00000000-0000-4000-8000-000000309651'), '<no row>') -- pii-allow-uuid: invented fixture id, verified absent from every live table
union all
select '6. ROLE of racer B', COALESCE((select role from organization_members
   where organization_id='00000000-0000-4000-8000-00003096c5f0' -- pii-allow-uuid: invented fixture id, verified absent from every live table
     and user_id='00000000-0000-4000-8000-000000309652'), '<no row>') -- pii-allow-uuid: invented fixture id, verified absent from every live table
union all
select '7. ADMIN COUNT (pre-register before running: fixed=1, unfixed=2)',
   (select count(*)::text from organization_members
     where organization_id='00000000-0000-4000-8000-00003096c5f0' and role='admin') -- pii-allow-uuid: invented fixture id, verified absent from every live table
order by 1;
