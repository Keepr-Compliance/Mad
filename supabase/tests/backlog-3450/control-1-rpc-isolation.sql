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
-- THE TWO USERS ARE CHOSEN BY THE SCRIPT, from `internal_roles`, and both must
-- have a row there. The `internal_roles` guard raises 'Access denied' before
-- the isolation check is ever reached, so a non-internal second user would pass
-- this control for the wrong reason.
--
-- NO psql VARIABLES ANYWHERE. psql does not substitute a colon-prefixed name
-- inside a dollar-quoted block, so one written in here would reach Postgres
-- verbatim and fail to parse. That is also why the BACKLOG-3096 scripts
-- hardcode their ids inside the block rather than passing them with -v.
--
-- Run as the database owner/superuser, and do NOT `SET ROLE authenticated`:
-- these functions are SECURITY DEFINER so they run as their owner either way,
-- and switching role would RLS-filter the asserting reads and fail this for the
-- wrong reason (the note is BACKLOG-3096 control 1's, and it still holds).
--
-- RUN:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f control-1-rpc-isolation.sql
--
-- IT SAVES UNDER ITS OWN `report_key`, not under the report's. Both views here
-- are pinned, and `report_save_view` refuses a sixth pin PER REPORT KEY — so on
-- a re-run against a database where five cards are already pinned on the real
-- report, the save would raise the cap and abort this script BEFORE its
-- assertions, which reads as a failed control rather than as a full dashboard.
-- Isolation is between USERS and does not depend on the key. Control 4 already
-- does the same thing for the same reason.
--
-- Ends in ROLLBACK. Nothing it writes survives.

\set ON_ERROR_STOP on
BEGIN;

DO $control$
DECLARE
  k_owner   UUID;
  k_other   UUID;
  v_owner_view  UUID;
  v_listed  JSONB;
  v_message TEXT;
BEGIN
  SELECT user_id INTO k_owner FROM internal_roles ORDER BY created_at, user_id LIMIT 1;
  SELECT user_id INTO k_other
  FROM internal_roles WHERE user_id IS DISTINCT FROM k_owner
  ORDER BY created_at, user_id LIMIT 1;

  ASSERT k_owner IS NOT NULL, 'CONTROL 1: no internal users at all';
  ASSERT k_other IS NOT NULL,
    'CONTROL 1: only ONE internal user exists, so isolation between two of them '
    'cannot be observed. Add a second internal_roles row and re-run.';
  RAISE NOTICE 'PASS setup: two distinct internal users';

  -------------------------------------------------------------------------
  -- The owner saves a view, through the RPC, as themselves.
  -------------------------------------------------------------------------
  PERFORM set_config('request.jwt.claim.sub', k_owner::text, true);

  v_owner_view := (public.report_save_view(
    'control-1',
    'CONTROL 1 owner view',
    '{"types":[],"outcomes":["error"],"platforms":[],"search":"","stalledOnly":false}'::jsonb,
    '{"col":"runs","fn":"count"}'::jsonb,
    true,
    NULL::uuid
  )->>'id')::uuid;
  ASSERT v_owner_view IS NOT NULL, 'CONTROL 1: the owner could not save a view';

  v_listed := public.report_list_saved_views('control-1');
  ASSERT EXISTS (
    SELECT 1 FROM jsonb_array_elements(v_listed) e WHERE (e->>'id')::uuid = v_owner_view
  ), 'CONTROL 1: the owner cannot see their own view — the RPC is broken';
  RAISE NOTICE 'PASS: the owner sees their own view';

  -------------------------------------------------------------------------
  -- THE ASSERTION. The second internal user lists, and sees none of it.
  -------------------------------------------------------------------------
  PERFORM set_config('request.jwt.claim.sub', k_other::text, true);

  v_listed := public.report_list_saved_views('control-1');
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
      GET STACKED DIAGNOSTICS v_message = MESSAGE_TEXT;
      IF v_message LIKE 'CONTROL 1 FAILED%' THEN
        RAISE;
      END IF;
      ASSERT v_message LIKE 'Only the view owner%',
        format('CONTROL 1: delete was refused, but for the wrong reason: %s', v_message);
      RAISE NOTICE 'PASS: delete refused — %', v_message;
  END;

  -- The row is still there, as the owner.
  PERFORM set_config('request.jwt.claim.sub', k_owner::text, true);
  v_listed := public.report_list_saved_views('control-1');
  ASSERT EXISTS (
    SELECT 1 FROM jsonb_array_elements(v_listed) e WHERE (e->>'id')::uuid = v_owner_view
  ), 'CONTROL 1: the owner''s view was deleted after all';
  RAISE NOTICE 'PASS: the owner''s view survived';

  RAISE NOTICE 'CONTROL 1 PASSED';
END
$control$;

ROLLBACK;
