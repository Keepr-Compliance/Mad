-- BACKLOG-3096 / CONTROL 5, step 4 of 4: assert and tear down.
--
-- Run after BOTH sessions have committed.
--
-- Assertion is on the EXACT role of each NAMED user id, not on a count of
-- admins: "one admin" would also be satisfied by a run in which A failed
-- outright and B became admin, which is a different outcome entirely.

\set ON_ERROR_STOP on

DO $control$
DECLARE
  k_org_id   CONSTANT UUID := '00000000-0000-4000-8000-00003096c5f0'; -- pii-allow-uuid: invented fixture id, verified absent from every live table
  k_user_a   CONSTANT UUID := '00000000-0000-4000-8000-000000309651'; -- pii-allow-uuid: invented fixture id, verified absent from every live table
  k_user_b   CONSTANT UUID := '00000000-0000-4000-8000-000000309652'; -- pii-allow-uuid: invented fixture id, verified absent from every live table
  v_role_a   TEXT;
  v_role_b   TEXT;
BEGIN
  SELECT role INTO v_role_a FROM organization_members
   WHERE organization_id = k_org_id AND user_id = k_user_a;
  SELECT role INTO v_role_b FROM organization_members
   WHERE organization_id = k_org_id AND user_id = k_user_b;

  ASSERT v_role_a = 'admin',
         format('CONTROL 5: racer A got role %L, expected admin', COALESCE(v_role_a, '<no membership>'));
  ASSERT v_role_b = 'agent',
         format('CONTROL 5: racer B got role %L, expected agent. '
                'Two simultaneous /setup callers both became administrators.',
                COALESCE(v_role_b, '<no membership>'));

  RAISE NOTICE 'CONTROL 5 PASSED (roles): A=admin B=agent. Now check session B''s timing -- it must show a ~5s wait.';
END
$control$;

DELETE FROM organizations WHERE id = '00000000-0000-4000-8000-00003096c5f0'; -- pii-allow-uuid: invented fixture id, verified absent from every live table
DELETE FROM public.users WHERE id IN (
  '00000000-0000-4000-8000-000000309651', -- pii-allow-uuid: invented fixture id, verified absent from every live table
  '00000000-0000-4000-8000-000000309652'); -- pii-allow-uuid: invented fixture id, verified absent from every live table
DELETE FROM auth.users WHERE id IN (
  '00000000-0000-4000-8000-000000309651', -- pii-allow-uuid: invented fixture id, verified absent from every live table
  '00000000-0000-4000-8000-000000309652'); -- pii-allow-uuid: invented fixture id, verified absent from every live table

SELECT 'control 5 fixture removed' AS status;
