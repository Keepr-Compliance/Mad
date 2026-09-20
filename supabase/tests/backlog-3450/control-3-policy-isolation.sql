-- BACKLOG-3450 / CONTROL 3 — the RLS policy, as defence in depth
--
-- This is the layer the app does NOT use: every read on the page goes through
-- `report_list_saved_views`, which is SECURITY DEFINER and bypasses RLS
-- entirely. Control 1 is the one that guards the running app. This one guards
-- any future direct table read and is kept for that reason alone.
--
-- Note the `SET LOCAL ROLE authenticated`: without it the script runs as the
-- table owner, for whom RLS is not enforced, and the whole thing would pass
-- while proving nothing.
--
-- RUN:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 \
--     -v owner="'<uuid-1>'" -v other="'<uuid-2>'" \
--     -f control-3-policy-isolation.sql

\set ON_ERROR_STOP on
BEGIN;

-- Seed one row for the owner, as the table owner (RLS not in play yet).
INSERT INTO public.report_saved_views (user_id, report_key, name, filters, metric, pinned)
VALUES (
  :owner, 'iphone-sync', 'CONTROL 3 owner view',
  '{"types":[],"outcomes":[],"platforms":[],"search":"","stalledOnly":false}'::jsonb,
  '{"col":"runs","fn":"count"}'::jsonb, false
);

-- ── as the OWNER ─────────────────────────────────────────────────
SELECT set_config('request.jwt.claims',
  json_build_object('sub', :owner, 'role', 'authenticated')::text, true);
SET LOCAL ROLE authenticated;

-- EXPECT: exactly the owner's own rows, and `CONTROL 3 owner view` among them.
SELECT count(*) AS owner_sees,
       bool_and(user_id = (select auth.uid())) AS all_rows_are_mine
FROM public.report_saved_views;

RESET ROLE;

-- ── as a DIFFERENT internal user ─────────────────────────────────
SELECT set_config('request.jwt.claims',
  json_build_object('sub', :other, 'role', 'authenticated')::text, true);
SET LOCAL ROLE authenticated;

-- EXPECT: zero rows belonging to the owner. Anything else is a failure.
SELECT count(*) AS other_sees_owner_rows
FROM public.report_saved_views
WHERE user_id = :owner;

RESET ROLE;

DO $assert$
DECLARE
  v_leak INT;
BEGIN
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', :other, 'role', 'authenticated')::text, true);
  SET LOCAL ROLE authenticated;
  SELECT count(*) INTO v_leak FROM public.report_saved_views WHERE user_id = :owner;
  RESET ROLE;
  ASSERT v_leak = 0,
    format('CONTROL 3 FAILED: the second user sees %s of the owner''s rows through the policy', v_leak);
  RAISE NOTICE 'CONTROL 3 PASSED — the policy hides the owner''s rows from another internal user';
END
$assert$;

ROLLBACK;
