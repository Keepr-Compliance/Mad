-- BACKLOG-3976 rollback: drops admin_update_org_member_role (the migration only adds it).
-- Admin_audit_logs rows it wrote are kept (audit history). Also remove the ledger row by hand
-- if the venue keeps one: DELETE FROM supabase_migrations.schema_migrations WHERE version = '20261110130000';
DROP FUNCTION IF EXISTS public.admin_update_org_member_role(uuid, uuid, text);
