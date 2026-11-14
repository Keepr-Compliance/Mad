-- BACKLOG-4243 PR-3 rollback of 20261114130000: drops the one function it creates and its ledger row.
DROP FUNCTION IF EXISTS public.cloud_list_install_rows(uuid, uuid, text, uuid, integer);
DELETE FROM supabase_migrations.schema_migrations WHERE version = '20261114130000';
