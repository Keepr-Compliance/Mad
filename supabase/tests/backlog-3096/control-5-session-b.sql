-- BACKLOG-3096 / CONTROL 5, step 3 of 4: SESSION B.
--
-- Start this about ONE SECOND after session A.
--
-- READ THE TWO TIMESTAMPS THIS PRINTS. They are half the result:
--
--   WITH the fix   -> b_after_call - b_before_call is roughly 5 seconds. B
--                     blocked on A's FOR UPDATE lock, and once A committed, B
--                     saw A's membership row and resolved to 'agent'.
--   WITHOUT it     -> the difference is milliseconds. B never waited, read
--                     "zero claimed members" while A's insert was still
--                     uncommitted, and both callers became admin.
--
-- A roles-only assertion cannot tell those apart on its own, which is why
-- control-5-assert.sql checks the roles AND this file prints the timing.

\set ON_ERROR_STOP on
\timing on

BEGIN;
SELECT set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-000000309652', true); -- pii-allow-uuid: invented fixture id, verified absent from every live table
SELECT clock_timestamp() AS b_before_call;
SELECT public.auto_provision_it_admin(
         'fixture-tenant-3096-c5', 'Fixture Org 3096 C5', 'fixture-org-3096-c5') AS b_result;
SELECT clock_timestamp() AS b_after_call;
COMMIT;

SELECT 'session B committed' AS status;
