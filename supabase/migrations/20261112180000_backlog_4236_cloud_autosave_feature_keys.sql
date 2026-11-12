-- ============================================================================
-- Migration: cloud auto-save plan feature keys (BACKLOG-4236)
-- Data only. Same pattern as 20261104230000_backlog_4120_autodetect_eval_feature.sql.
--
--   cloud_autosave             the plan of a user's personal organization carries Cloud auto-save
--   cloud_autosave_assignable  an organization's plan allows Cloud auto-save to be assigned to members
--
--   Both keys: boolean, default_value 'false', min_tier NULL, is_built false, off on every plan.
--   min_tier NULL: an organization override is never ignored for tier reasons.
--   default_value 'false': an organization with no plan row reads the key as off.
--   The per-user answer comes from public.get_my_cloud_autosave_state() (migration
--   20261112190000), not from the organization feature map.
--   sort_order 164 and 165 (163 was the highest in use). Re-check before applying.
--
-- Grants: this file creates no function and no table.
-- ============================================================================

INSERT INTO public.feature_definitions
  (key, name, description, category, value_type, default_value, min_tier, sort_order, is_built)
VALUES
  ('cloud_autosave', 'Cloud auto-save',
   'An online copy of the user''s own deals. Read per user by get_my_cloud_autosave_state() (BACKLOG-4236).',
   'sync', 'boolean', 'false', NULL, 164, false),
  ('cloud_autosave_assignable', 'Cloud auto-save (assignable)',
   'Cloud auto-save may be assigned to individual members of the organization (BACKLOG-4236).',
   'sync', 'boolean', 'false', NULL, 165, false)
ON CONFLICT (key) DO NOTHING;

INSERT INTO public.plan_features (plan_id, feature_id, enabled, value)
SELECT p.id, fd.id, false, 'false'
FROM public.plans p
CROSS JOIN public.feature_definitions fd
WHERE fd.key IN ('cloud_autosave', 'cloud_autosave_assignable')
ON CONFLICT (plan_id, feature_id) DO NOTHING;
