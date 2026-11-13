-- BACKLOG-4185 PR A rollback (20261112150000_backlog_4185_device_hardware_profile.sql).
-- Drops the shape constraint and both columns. No policy, function or grant was changed.
ALTER TABLE public.devices DROP CONSTRAINT IF EXISTS devices_hardware_profile_shape;
ALTER TABLE public.devices DROP COLUMN IF EXISTS hardware_profile, DROP COLUMN IF EXISTS profile_updated_at;
DELETE FROM supabase_migrations.schema_migrations WHERE version = '20261112150000';
