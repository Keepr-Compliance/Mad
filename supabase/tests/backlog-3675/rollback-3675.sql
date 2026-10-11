-- BACKLOG-3675 rollback. Production use needs the founder's go.
-- Removes every per-organization grant, the plan rows and the feature row.
-- Delete the ledger row only if the migration file is also reverted.
begin;
update public.organization_plans
   set feature_overrides = feature_overrides - 'unlimited_transactions'
 where feature_overrides ? 'unlimited_transactions';
delete from public.plan_features
 where feature_id = (select id from public.feature_definitions where key = 'unlimited_transactions');
delete from public.feature_definitions where key = 'unlimited_transactions';
commit;
