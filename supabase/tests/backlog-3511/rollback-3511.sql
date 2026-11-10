-- BACKLOG-3511 broker half rollback (keepr-test, or production with a go).
-- Removes public.org_report_scope(uuid), the only object 20261108190000 adds, and the version row.
-- No policy references the helper yet (the first report table arrives in a later PR); if one
-- does by the time this runs, the removal fails rather than cascading, which is intended.
-- No transaction control in this file: run it inside a transaction you control. The harness
-- (compose.py) embeds it in a transaction that always ends in RAISE.

DROP FUNCTION IF EXISTS public.org_report_scope(uuid);
DELETE FROM supabase_migrations.schema_migrations WHERE version = '20261108190000';
