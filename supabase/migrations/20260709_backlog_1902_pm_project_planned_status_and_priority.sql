-- ============================================
-- PM Project: Planned status + project-level priority
-- Migration: 20260709_backlog_1902_pm_project_planned_status_and_priority
-- Backlog: BACKLOG-1902
-- Purpose: (1) add 'planned' to pm_projects status values,
--          (2) add a project-level priority field,
--          (3) surface priority via pm_list_projects,
--          (4) allow editing status='planned' + the priority field via pm_update_project_field.
-- NOTE: No data backfill here. Reclassifying the 5 existing '[planned]'-named
--       projects is a one-time production op run separately (per-id UPDATE),
--       to avoid matching manually-archived rows.
-- ============================================

-- 1. Expand status CHECK constraint (must precede any 'planned' writes)
ALTER TABLE pm_projects DROP CONSTRAINT pm_projects_status_check;
ALTER TABLE pm_projects ADD CONSTRAINT pm_projects_status_check
  CHECK (status IN ('planned', 'active', 'on_hold', 'completed', 'archived'));

-- 2. Add project-level priority
ALTER TABLE pm_projects
  ADD COLUMN IF NOT EXISTS priority TEXT NOT NULL DEFAULT 'medium';
ALTER TABLE pm_projects DROP CONSTRAINT IF EXISTS pm_projects_priority_check;
ALTER TABLE pm_projects ADD CONSTRAINT pm_projects_priority_check
  CHECK (priority IN ('critical', 'high', 'medium', 'low'));

-- 3. pm_list_projects: surface priority
CREATE OR REPLACE FUNCTION pm_list_projects()
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_caller_id UUID := auth.uid();
  v_projects JSONB;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM internal_roles WHERE user_id = v_caller_id) THEN
    RAISE EXCEPTION 'Access denied: internal role required';
  END IF;

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'id', p.id,
    'name', p.name,
    'description', p.description,
    'status', p.status,
    'priority', p.priority,
    'owner_id', p.owner_id,
    'sort_order', p.sort_order,
    'created_at', p.created_at,
    'item_count', (SELECT COUNT(*) FROM pm_backlog_items i WHERE i.project_id = p.id AND i.deleted_at IS NULL),
    'active_sprint_count', (SELECT COUNT(*) FROM pm_sprints s WHERE s.project_id = p.id AND s.status = 'active')
  ) ORDER BY p.sort_order ASC, p.name ASC), '[]'::jsonb)
  INTO v_projects
  FROM pm_projects p
  WHERE p.deleted_at IS NULL;

  RETURN v_projects;
END;
$$;
GRANT EXECUTE ON FUNCTION pm_list_projects TO authenticated;

-- 4. pm_update_project_field: allow 'planned' status + editing priority
CREATE OR REPLACE FUNCTION pm_update_project_field(
  p_project_id UUID,
  p_field TEXT,
  p_value TEXT
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_caller_id UUID := auth.uid();
  v_old_value TEXT;
  v_allowed_fields TEXT[] := ARRAY['name', 'description', 'status', 'priority'];
  v_allowed_statuses TEXT[] := ARRAY['planned', 'active', 'on_hold', 'completed', 'archived'];
  v_allowed_priorities TEXT[] := ARRAY['critical', 'high', 'medium', 'low'];
BEGIN
  IF NOT EXISTS (SELECT 1 FROM internal_roles WHERE user_id = v_caller_id) THEN
    RAISE EXCEPTION 'Access denied: internal role required';
  END IF;

  IF NOT (p_field = ANY(v_allowed_fields)) THEN
    RAISE EXCEPTION 'Field not allowed: %. Allowed: %', p_field, array_to_string(v_allowed_fields, ', ');
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pm_projects WHERE id = p_project_id AND deleted_at IS NULL) THEN
    RAISE EXCEPTION 'Project not found: %', p_project_id;
  END IF;

  EXECUTE format('SELECT %I::text FROM pm_projects WHERE id = $1', p_field)
    INTO v_old_value USING p_project_id;

  IF p_field = 'name' AND (p_value IS NULL OR trim(p_value) = '') THEN
    RAISE EXCEPTION 'Project name cannot be empty';
  END IF;

  IF p_field = 'status' AND NOT (p_value = ANY(v_allowed_statuses)) THEN
    RAISE EXCEPTION 'Invalid status: %. Allowed: planned, active, on_hold, completed, archived', p_value;
  END IF;

  IF p_field = 'priority' AND NOT (p_value = ANY(v_allowed_priorities)) THEN
    RAISE EXCEPTION 'Invalid priority: %. Allowed: critical, high, medium, low', p_value;
  END IF;

  IF p_value IS NULL THEN
    EXECUTE format('UPDATE pm_projects SET %I = NULL, updated_at = now() WHERE id = $1', p_field)
      USING p_project_id;
  ELSE
    EXECUTE format('UPDATE pm_projects SET %I = $2, updated_at = now() WHERE id = $1', p_field)
      USING p_project_id, p_value;
  END IF;

  RETURN jsonb_build_object(
    'success', true,
    'field', p_field,
    'old_value', v_old_value,
    'new_value', p_value
  );
END;
$$;
GRANT EXECUTE ON FUNCTION pm_update_project_field TO authenticated;
