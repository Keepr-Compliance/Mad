-- BACKLOG-3450 / CONTROL 3 — the RLS policy, as defence in depth
--
-- This is the layer the app does NOT use: every read on the page goes through
-- `report_list_saved_views`, which is SECURITY DEFINER and bypasses RLS
-- entirely. Control 1 is the one that guards the running app. This one guards
-- any future direct table read, and is kept for that reason alone.
--
-- IT IS THE ONE SCRIPT HERE THAT *MUST* `SET LOCAL ROLE authenticated`, and the
-- one where BACKLOG-3096's "do not SET ROLE" note does not apply. That note is
-- about SECURITY DEFINER functions, which run as their owner either way; this
-- script tests a POLICY, and the table owner is exempt from RLS. Without the
-- role switch it would pass while proving nothing.
--
-- The role is switched OUTSIDE the assertion block on purpose: plpgsql cannot
-- run a bare `SET ROLE`, and a DO block runs as whatever the current role is —
-- so switching first makes the whole block execute under RLS.
--
-- The two users are chosen by the script, as in control 1. NO psql VARIABLES:
-- psql does not substitute `:name` inside a dollar-quoted block, so one written
-- there would reach Postgres verbatim and fail to parse.
--
-- RUN:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f control-3-policy-isolation.sql

\set ON_ERROR_STOP on
BEGIN;

-- Seed one row for the first internal user, as the table owner (RLS not in
-- play yet, and `authenticated` holds no INSERT — which control 5 asserts).
INSERT INTO public.report_saved_views (user_id, report_key, name, filters, metric, pinned)
SELECT
  (SELECT user_id FROM internal_roles ORDER BY created_at, user_id LIMIT 1),
  'iphone-sync',
  'CONTROL 3 owner view',
  '{"types":[],"outcomes":[],"platforms":[],"search":"","stalledOnly":false}'::jsonb,
  '{"col":"runs","fn":"count"}'::jsonb,
  false;

-- Refuse to continue on a single-user database: with nobody to be isolated
-- FROM, every assertion below would pass for the wrong reason.
DO $guard$
BEGIN
  ASSERT (SELECT count(DISTINCT user_id) FROM internal_roles) >= 2,
    'CONTROL 3: only ONE internal user exists, so isolation cannot be observed';
END
$guard$;

-- Capture the owner's id into a GUC NOW, as the table owner. The assertion
-- block below runs as `authenticated`, where `internal_roles` is itself
-- RLS-filtered: reading the owner's id from there after the role switch could
-- return NULL, and `WHERE user_id = NULL` matches nothing — a false pass. A
-- GUC is readable by any role.
SELECT set_config(
  'control3.owner',
  (SELECT user_id::text FROM internal_roles ORDER BY created_at, user_id LIMIT 1),
  true
);

-- ── as the OWNER ─────────────────────────────────────────────────
SELECT set_config(
  'request.jwt.claims',
  json_build_object(
    'sub', (SELECT user_id FROM internal_roles ORDER BY created_at, user_id LIMIT 1),
    'role', 'authenticated'
  )::text,
  true
);

SET LOCAL ROLE authenticated;

-- THE OWNER LEG, ASSERTED — not printed.
--
-- This was a bare SELECT whose two numbers nobody read. A policy that denied
-- EVERYONE would have printed `0 / NULL` and the script would still have ended
-- in `CONTROL 3 PASSED`, because the second-user leg below cannot tell "the
-- policy hides the owner's rows from another user" from "the policy hides every
-- row from everyone". The owner seeing their own row is what separates them.
DO $owner$
DECLARE
  v_owner_sees INT;
  v_all_mine   BOOLEAN;
BEGIN
  SELECT count(*), bool_and(user_id = (select auth.uid()))
  INTO v_owner_sees, v_all_mine
  FROM public.report_saved_views;

  IF v_owner_sees >= 1 AND v_all_mine THEN
    RAISE NOTICE 'PASS: the owner sees % row(s) through the policy, all of them their own', v_owner_sees;
  ELSE
    RAISE EXCEPTION 'CONTROL 3 RED (owner leg): the owner sees % row(s), all of them mine = % — '
      'the policy is not returning the owner exactly their own rows, so the '
      'second-user leg below would pass for the wrong reason',
      v_owner_sees, coalesce(v_all_mine::text, 'NULL');
  END IF;
END
$owner$;

RESET ROLE;

-- ── as a DIFFERENT internal user ─────────────────────────────────
SELECT set_config(
  'request.jwt.claims',
  json_build_object(
    'sub', (SELECT user_id FROM internal_roles
            WHERE user_id IS DISTINCT FROM
                  (SELECT user_id FROM internal_roles ORDER BY created_at, user_id LIMIT 1)
            ORDER BY created_at, user_id LIMIT 1),
    'role', 'authenticated'
  )::text,
  true
);

SET LOCAL ROLE authenticated;

-- THE ASSERTION, run as `authenticated` so the policy is actually enforced.
DO $assert$
DECLARE
  v_owner UUID;
  v_leak INT;
  v_total INT;
BEGIN
  -- From the GUC, NOT from internal_roles — see the note above the capture.
  v_owner := current_setting('control3.owner')::uuid;
  ASSERT v_owner IS NOT NULL, 'CONTROL 3: the owner id was not captured';

  SELECT count(*) INTO v_leak FROM public.report_saved_views WHERE user_id = v_owner;
  ASSERT v_leak = 0,
    format('CONTROL 3 FAILED: the second user sees %s of the owner''s rows through the policy', v_leak);

  SELECT count(*) INTO v_total FROM public.report_saved_views;
  ASSERT NOT EXISTS (
    SELECT 1 FROM public.report_saved_views WHERE user_id IS DISTINCT FROM (select auth.uid())
  ), 'CONTROL 3 FAILED: a row belonging to someone else is visible';

  RAISE NOTICE 'PASS: the second user sees % row(s), none of them the owner''s', v_total;
  RAISE NOTICE 'CONTROL 3 PASSED — the policy hides the owner''s rows from another internal user';
END
$assert$;

RESET ROLE;
ROLLBACK;
