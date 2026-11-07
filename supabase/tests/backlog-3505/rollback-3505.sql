-- Rollback for 20261108140000_backlog_3505_broker_reports_feature.sql (BACKLOG-3505).
-- Removes the broker_reports plan rows and the feature definition. The migration
-- adds no feature_dependencies row for the key, so none blocks the second
-- statement. No function, grant or policy was changed, so there is nothing else
-- to restore.
BEGIN;
DELETE FROM public.plan_features
WHERE feature_id IN (SELECT id FROM public.feature_definitions WHERE key = 'broker_reports');
DELETE FROM public.feature_definitions WHERE key = 'broker_reports';
COMMIT;
