-- BACKLOG-3450 / CONTROL 5 — anon holds nothing
--
-- A new table in `public` on this project inherits default privileges that
-- grant `anon` full DML, and new functions grant `anon` EXECUTE. The migration
-- revokes both. This asserts the revokes actually landed, because the failure
-- mode is silent: RLS with no write policy would still deny the writes, so
-- nothing visibly breaks while the privilege sits there.
--
-- Read-only. No transaction needed, but it stays in one for symmetry.
--
-- RUN:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f control-5-grants.sql

\set ON_ERROR_STOP on
BEGIN;

DO $control$
DECLARE
  v_anon_table TEXT;
  v_auth_table TEXT;
  v_fn RECORD;
BEGIN
  SELECT string_agg(privilege_type, ',' ORDER BY privilege_type)
  INTO v_anon_table
  FROM information_schema.role_table_grants
  WHERE table_schema = 'public' AND table_name = 'report_saved_views' AND grantee = 'anon';

  ASSERT v_anon_table IS NULL,
    format('CONTROL 5 FAILED: anon still holds %s on report_saved_views', v_anon_table);
  RAISE NOTICE 'PASS: anon holds NO privilege on report_saved_views';

  SELECT string_agg(privilege_type, ',' ORDER BY privilege_type)
  INTO v_auth_table
  FROM information_schema.role_table_grants
  WHERE table_schema = 'public' AND table_name = 'report_saved_views' AND grantee = 'authenticated';

  ASSERT v_auth_table = 'SELECT',
    format('CONTROL 5 FAILED: authenticated holds %s, expected SELECT alone', coalesce(v_auth_table, 'nothing'));
  RAISE NOTICE 'PASS: authenticated holds SELECT and nothing else — every write goes through an RPC';

  ASSERT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.report_saved_views'::regclass),
    'CONTROL 5 FAILED: row level security is not enabled on report_saved_views';
  RAISE NOTICE 'PASS: RLS is enabled';

  FOR v_fn IN
    SELECT p.proname, p.oid
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname IN ('report_list_saved_views', 'report_save_view', 'report_delete_saved_view')
  LOOP
    ASSERT NOT has_function_privilege('anon', v_fn.oid, 'EXECUTE'),
      format('CONTROL 5 FAILED: anon can EXECUTE %s', v_fn.proname);
    ASSERT has_function_privilege('authenticated', v_fn.oid, 'EXECUTE'),
      format('CONTROL 5 FAILED: authenticated cannot EXECUTE %s', v_fn.proname);
    RAISE NOTICE 'PASS: % — anon denied, authenticated allowed', v_fn.proname;
  END LOOP;

  ASSERT (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
          WHERE n.nspname = 'public'
            AND p.proname IN ('report_list_saved_views', 'report_save_view', 'report_delete_saved_view')) = 3,
    'CONTROL 5 FAILED: not all three functions exist — was the migration applied?';

  RAISE NOTICE 'CONTROL 5 PASSED';
END
$control$;

ROLLBACK;
