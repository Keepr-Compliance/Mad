-- BACKLOG-3514 rollback (keepr-test, or production with a go).
-- Removes everything 20261108220000 adds: the saved-views table (and its rows), its trigger, the
-- four RPCs, the three internal helpers, and the version row.
-- No transaction control in this file: run it inside a transaction you control. The harness
-- (compose.py) embeds it in a transaction that always ends in RAISE.

DROP FUNCTION IF EXISTS public.broker_report_set_default_view(uuid, text, uuid);
DROP FUNCTION IF EXISTS public.broker_report_delete_view(uuid, uuid);
DROP FUNCTION IF EXISTS public.broker_report_save_view(uuid, text, text, jsonb, jsonb, boolean, uuid);
DROP FUNCTION IF EXISTS public.broker_report_list_views(uuid, text);
DROP TABLE IF EXISTS public.broker_report_saved_views;
DROP FUNCTION IF EXISTS public._broker_report_views_immutable();
DROP FUNCTION IF EXISTS public._broker_report_views_gate(uuid);
DROP FUNCTION IF EXISTS public._broker_report_views_key_ok(text);
DELETE FROM supabase_migrations.schema_migrations WHERE version = '20261108220000';
