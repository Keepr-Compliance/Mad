-- BACKLOG-4179 rollback: removes the one-brokerage guard (20261112121000) and its ledger row.
-- Nothing else depends on the trigger or the function.
DROP TRIGGER IF EXISTS single_brokerage_guard ON public.organization_members;
DROP FUNCTION IF EXISTS public._one_brokerage_per_member();
DELETE FROM supabase_migrations.schema_migrations WHERE version = '20261112121000';
