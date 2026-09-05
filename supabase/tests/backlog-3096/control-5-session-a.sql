-- BACKLOG-3096 / CONTROL 5, step 2 of 4: SESSION A.
--
-- A calls the RPC and then HOLDS THE TRANSACTION OPEN for 6 seconds before
-- committing. The sleep is AFTER the call and BEFORE COMMIT -- that is the
-- whole point: it keeps A's row lock on the organizations row held while B
-- tries to take it.
--
-- Start this first, then start control-5-session-b.sql about one second later.

\set ON_ERROR_STOP on
\timing on

BEGIN;
SELECT set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-000000309651', true); -- pii-allow-uuid: invented fixture id, verified absent from every live table
SELECT clock_timestamp() AS a_before_call;
SELECT public.auto_provision_it_admin(
         'fixture-tenant-3096-c5', 'Fixture Org 3096 C5', 'fixture-org-3096-c5') AS a_result;
SELECT clock_timestamp() AS a_after_call;
SELECT pg_sleep(6);
COMMIT;

SELECT 'session A committed' AS status;
