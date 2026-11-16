-- BACKLOG-4245 rollback for 20261114140000_backlog_4245_beta_updates_feature.sql.
-- Order: overrides first, then the plan rows, then the definition.
-- Sent through MCP apply_migration: remove the BEGIN and COMMIT lines first
-- (that tool runs the text in its own transaction).
BEGIN;
UPDATE public.organization_plans
   SET feature_overrides = feature_overrides - 'beta_updates'
 WHERE feature_overrides ? 'beta_updates';
DELETE FROM public.plan_features pf
 USING public.feature_definitions fd
 WHERE pf.feature_id = fd.id AND fd.key = 'beta_updates';
DELETE FROM public.feature_definitions WHERE key = 'beta_updates';
COMMIT;
