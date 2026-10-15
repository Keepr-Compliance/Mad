-- BACKLOG-3674 rollback. Production use needs the founder's go.
-- Drops the column; its column-level UPDATE grant goes with it.
-- Delete the ledger row only if the migration file is also reverted.
begin;
alter table public.users drop column if exists tour_dismissed_at;
commit;
