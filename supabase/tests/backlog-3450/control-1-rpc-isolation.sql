-- BACKLOG-3450 / CONTROL 1  ***THE CONTROL THAT MATTERS***
--
-- A second INTERNAL user calls the same RPCs the page calls, and sees nothing.
--
-- It calls the RPCs rather than selecting from the table because the RPCs are
-- SECURITY DEFINER and therefore bypass RLS: a policy-level probe cannot see a
-- missing `WHERE v.user_id = v_caller_id`. Control 2 is the mutation that
-- proves this one can fail; control 3 keeps the policy check as defence in
-- depth.
--
-- Both ids must be users with an `internal_roles` row. The guard raises
-- 'Access denied: internal role required' before the isolation check is ever
-- reached, so a non-internal second user would pass for the wrong reason —
-- which this script asserts against explicitly.
--
-- RUN:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 \
--     -v owner="'<uuid-1>'" -v other="'<uuid-2>'" \
--     -f control-1-rpc-isolation.sql
--
-- Ends in ROLLBACK. Nothing it writes survives.

\set ON_ERROR_STOP on
BEGIN;

DO $control$
DECLARE
  k_owner   CONSTANT UUID := :owner;
  k_other   CONSTANT UUID := :other;
  v_owner_view  UUID;
  v_listed  JSONB;
  v_sqlstate TEXT;
  v_message TEXT;
BEGIN
  ASSERT k_owner IS DISTINCT FROM k_other,
    'CONTROL 1: the two users must be different';

  -- Both must be internal, or the guard fires first and the control is vacuous.
  ASSERT EXISTS (SELECT 1 FROM internal_roles WHERE user_id = k_owner),
    'CONTROL 1: :owner has no internal_roles row';
  ASSERT EXISTS (SELECT 1 FROM internal_roles WHERE user_id = k_other),
    'CONTROL 1: :other has no internal_roles row — the guard would refuse them '
    'before the isolation check, which would make this control prove nothing';
  RAISE NOTICE 'PASS setup: two distinct internal users';

  -------------------------------------------------------------------------
  -- The owner saves a view, through the RPC, as themselves.
  -------------------------------------------------------------------------
  PERFORM set_config('request.jwt.claim.sub', k_owner::text, true);

  v_owner_view := (public.report_save_view(
    'iphone-sync',
    'CONTROL 1 owner view',
    '{"types":[],"outcomes":["error"],"platforms":[],"search":"","stalledOnly":false}'::jsonb,
    '{"col":"runs","fn":"count"}'::jsonb,
    true,
    NULL
  )->>'id')::uuid;
  ASSERT v_owner_view IS NOT NULL, 'CONTROL 1: the owner could not save a view';

  v_listed := public.report_list_saved_views('iphone-sync');
  ASSERT EXISTS (
    SELECT 1 FROM jsonb_array_elements(v_listed) e WHERE (e->>'id')::uuid = v_owner_view
  ), 'CONTROL 1: the owner cannot see their own view — the RPC is broken';
  RAISE NOTICE 'PASS: the owner sees their own view';

  -------------------------------------------------------------------------
  -- THE ASSERTION. The second internal user lists, and sees none of it.
  -------------------------------------------------------------------------
  PERFORM set_config('request.jwt.claim.sub', k_other::text, true);

  v_listed := public.report_list_saved_views('iphone-sync');
  ASSERT NOT EXISTS (
    SELECT 1 FROM jsonb_array_elements(v_listed) e WHERE (e->>'id')::uuid = v_owner_view
  ), format('CONTROL 1 FAILED: the second internal user can see the owner''s saved view. '
            'report_list_saved_views returned %s', v_listed);
  RAISE NOTICE 'PASS: the second internal user does NOT see the owner''s view';

  -------------------------------------------------------------------------
  -- And cannot delete it.
  -------------------------------------------------------------------------
  BEGIN
    PERFORM public.report_delete_saved_view(v_owner_view);
    RAISE EXCEPTION 'CONTROL 1 FAILED: the second internal user deleted the owner''s view';
  EXCEPTION
    WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_sqlstate = RETURNED_SQLSTATE, v_message = MESSAGE_TEXT;
      IF v_message LIKE 'CONTROL 1 FAILED%' THEN
        RAISE;
      END IF;
      ASSERT v_message LIKE 'Only the view owner%',
        format('CONTROL 1: delete was refused, but for the wrong reason: %s', v_message);
      RAISE NOTICE 'PASS: delete refused — %', v_message;
  END;

  -- The row is still there, as the owner.
  PERFORM set_config('request.jwt.claim.sub', k_owner::text, true);
  v_listed := public.report_list_saved_views('iphone-sync');
  ASSERT EXISTS (
    SELECT 1 FROM jsonb_array_elements(v_listed) e WHERE (e->>'id')::uuid = v_owner_view
  ), 'CONTROL 1: the owner''s view was deleted after all';
  RAISE NOTICE 'PASS: the owner''s view survived';

  RAISE NOTICE 'CONTROL 1 PASSED';
END
$control$;

ROLLBACK;
