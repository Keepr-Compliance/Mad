-- BACKLOG-4086 rollback (keepr-test, or prod with a go). Removes the SLA settings table, its trigger
-- and trigger function, and the migration's version row.
DROP TABLE IF EXISTS public.support_sla_settings;
DROP FUNCTION IF EXISTS public.support_sla_settings_touch();
DELETE FROM supabase_migrations.schema_migrations WHERE version = '20261031000000';
