-- BACKLOG-4185 PR A: a hardware profile on each device row.
--
-- Adds two nullable columns to public.devices:
--   hardware_profile    jsonb        the desktop app's device profile (an object, at most 8192 bytes)
--   profile_updated_at  timestamptz  when the app last wrote or cleared hardware_profile
-- No default, no backfill: existing rows stay NULL until the app writes them.
--
-- Writes go through the existing own-row policy "Users can update own devices"
-- (USING auth.uid() = user_id). This migration changes no policy, adds no function,
-- trigger or table, and changes no grant. anon and authenticated hold no TRUNCATE on
-- public.devices (checked on both projects before this was written), so there is nothing
-- to revoke.
--
-- The size bound uses octet_length of the text form, not pg_column_size: TOAST compression
-- lets a large repetitive value measure small.
--
-- Re-runnable: both columns use IF NOT EXISTS and the constraint is added only when absent.
-- Rollback: supabase/tests/backlog-4185/rollback-4185.sql.

ALTER TABLE public.devices
  ADD COLUMN IF NOT EXISTS hardware_profile jsonb,
  ADD COLUMN IF NOT EXISTS profile_updated_at timestamptz;

DO $mig$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.devices'::regclass
      AND conname = 'devices_hardware_profile_shape'
  ) THEN
    ALTER TABLE public.devices
      ADD CONSTRAINT devices_hardware_profile_shape CHECK (
        hardware_profile IS NULL
        OR (jsonb_typeof(hardware_profile) = 'object'
            AND octet_length(hardware_profile::text) <= 8192)
      );
  END IF;
END
$mig$;

COMMENT ON COLUMN public.devices.hardware_profile IS
  'BACKLOG-4185: device hardware profile written by the desktop app (object, <= 8192 bytes). NULL when never written or cleared.';
COMMENT ON COLUMN public.devices.profile_updated_at IS
  'BACKLOG-4185: when hardware_profile was last written or cleared.';
