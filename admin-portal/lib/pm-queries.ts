/**
 * Supabase RPC query functions for the Project Management module.
 *
 * All mutations go through SECURITY DEFINER RPCs.
 * Follows the same pattern as support-queries.ts.
 */

import { createClient } from '@/lib/supabase/client';
import type {
  ItemListParams,
  ItemListResponse,
  ItemDetailResponse,
  CreateItemParams,
  PmStats,
  PmSprint,
  PmProject,
  PmLabel,
  PmSavedView,
  PmBacklogItem,
  PmNotification,
  PmItemSearchResult,
  PmDependency,
  SprintDetailResponse,
  ProjectDetailResponse,
  SprintVelocityEntry,
  BoardColumns,
  TaskStatusUpdateResult,
  TaskLegacyLookup,
  TaskTokenResult,
  AgentMetricResult,
  ItemStatus,
  SprintStatus,
  TaskStatus,
  ItemField,
  SprintField,
  ProjectField,
  BulkUpdateFields,
} from './pm-types';

// ---------------------------------------------------------------------------
// 1. pm_list_items -- Paginated, filterable list
// ---------------------------------------------------------------------------

/** List backlog items with optional filters and pagination. */
export async function listItems(params: ItemListParams): Promise<ItemListResponse> {
  const supabase = createClient();
  const { data, error } = await supabase.rpc('pm_list_items', {
    p_status: params.status || null,
    p_priority: params.priority || null,
    p_type: params.type || null,
    p_area: params.area || null,
    p_sprint_id: params.sprint_id || null,
    p_project_id: params.project_id || null,
    p_search: params.search || null,
    p_labels: params.labels || null,
    p_parent_id: params.parent_id || null,
    p_page: params.page || 1,
    p_page_size: params.page_size || 50,
    p_assignee_id: params.assignee_id || null,
    p_root_only: params.root_only || false,
    p_unassigned_only: params.unassigned_only || false,
  });
  if (error) throw error;
  return validateItemListResponse(data);
}

// ---------------------------------------------------------------------------
// 2. pm_get_item_detail -- Full item with related data
// ---------------------------------------------------------------------------

/** Get full detail for a single backlog item including comments, events, links. */
export async function getItemDetail(itemId: string): Promise<ItemDetailResponse> {
  const supabase = createClient();
  const { data, error } = await supabase.rpc('pm_get_item_detail', {
    p_item_id: itemId,
  });
  if (error) throw error;
  return validateItemDetailResponse(data);
}

// ---------------------------------------------------------------------------
// 3. pm_create_item -- Create new backlog item
// ---------------------------------------------------------------------------

/** Create a new backlog item and return its id, item_number, and legacy_id. */
export async function createItem(
  params: CreateItemParams
): Promise<{ id: string; item_number: number; legacy_id: string }> {
  const supabase = createClient();
  const { data, error } = await supabase.rpc('pm_create_item', {
    p_title: params.title,
    p_description: params.description || null,
    p_type: params.type || 'feature',
    p_area: params.area || null,
    p_priority: params.priority || 'medium',
    p_parent_id: params.parent_id || null,
    p_project_id: params.project_id || null,
    p_sprint_id: params.sprint_id || null,
    p_est_tokens: params.est_tokens || null,
    p_start_date: params.start_date || null,
    p_due_date: params.due_date || null,
  });
  if (error) throw error;
  return data as unknown as { id: string; item_number: number; legacy_id: string };
}

// ---------------------------------------------------------------------------
// 4. pm_update_item_status -- Status transition with validation
// ---------------------------------------------------------------------------

/** Update item status. DB validates the transition. */
export async function updateItemStatus(
  itemId: string,
  newStatus: ItemStatus
): Promise<{ success: boolean; old_status: string; new_status: string; changed?: boolean }> {
  const supabase = createClient();
  const { data, error } = await supabase.rpc('pm_update_item_status', {
    p_item_id: itemId,
    p_new_status: newStatus,
  });
  if (error) throw error;
  return data as unknown as { success: boolean; old_status: string; new_status: string; changed?: boolean };
}

// ---------------------------------------------------------------------------
// 5. pm_update_item_field -- Generic whitelisted field update
// ---------------------------------------------------------------------------

/** Update a single whitelisted field on a backlog item. */
export async function updateItemField(
  itemId: string,
  field: ItemField,
  value: string | null
): Promise<{ success: boolean; field: string; old_value: string | null; new_value: string | null }> {
  const supabase = createClient();
  const { data, error } = await supabase.rpc('pm_update_item_field', {
    p_item_id: itemId,
    p_field: field,
    p_value: value,
  });
  if (error) throw error;
  return data as unknown as { success: boolean; field: string; old_value: string | null; new_value: string | null };
}

// ---------------------------------------------------------------------------
// 6. pm_assign_item -- Assign to user
// ---------------------------------------------------------------------------

/** Assign a backlog item to a user (pass null to unassign). */
export async function assignItem(
  itemId: string,
  assigneeId: string | null
): Promise<{ success: boolean; item_id: string; assignee_id: string | null }> {
  const supabase = createClient();
  const { data, error } = await supabase.rpc('pm_assign_item', {
    p_item_id: itemId,
    p_assignee_id: assigneeId,
  });
  if (error) throw error;
  return data as unknown as { success: boolean; item_id: string; assignee_id: string | null };
}

// ---------------------------------------------------------------------------
// 7. pm_delete_item -- Soft-delete
// ---------------------------------------------------------------------------

/** Soft-delete a backlog item. */
export async function deleteItem(
  itemId: string
): Promise<{ success: boolean; item_id: string }> {
  const supabase = createClient();
  const { data, error } = await supabase.rpc('pm_delete_item', {
    p_item_id: itemId,
  });
  if (error) throw error;
  return data as unknown as { success: boolean; item_id: string };
}

// ---------------------------------------------------------------------------
// 8. pm_reorder_item -- Move in hierarchy / reorder
// ---------------------------------------------------------------------------

/** Move an item within the hierarchy or change its sort order. */
export async function reorderItem(
  itemId: string,
  newParentId?: string | null,
  sortOrder?: number
): Promise<{ success: boolean; item_id: string; parent_id: string | null; sort_order: number }> {
  const supabase = createClient();
  const { data, error } = await supabase.rpc('pm_reorder_item', {
    p_item_id: itemId,
    p_new_parent_id: newParentId || null,
    p_sort_order: sortOrder ?? 0,
  });
  if (error) throw error;
  return data as unknown as { success: boolean; item_id: string; parent_id: string | null; sort_order: number };
}

// ---------------------------------------------------------------------------
// 9. pm_add_comment -- Add discussion comment
// ---------------------------------------------------------------------------

/** Add a comment to an item or task. Exactly one of itemId/taskId must be provided. */
export async function addComment(
  itemId: string | null,
  taskId: string | null,
  body: string
): Promise<{ id: string }> {
  const supabase = createClient();
  const { data, error } = await supabase.rpc('pm_add_comment', {
    p_item_id: itemId || null,
    p_task_id: taskId || null,
    p_body: body,
  });
  if (error) throw error;
  return data as unknown as { id: string };
}

// ---------------------------------------------------------------------------
// 10a. pm_list_item_dependencies -- List dependencies for a backlog item
// ---------------------------------------------------------------------------

/** List all dependencies (depends_on, blocks, depended_on_by) for a backlog item. */
export async function listItemDependencies(itemId: string): Promise<PmDependency[]> {
  const supabase = createClient();
  const { data, error } = await supabase.rpc('pm_list_item_dependencies', {
    p_item_id: itemId,
  });
  if (error) throw error;
  return (data ?? []) as unknown as PmDependency[];
}

// ---------------------------------------------------------------------------
// 10b. pm_add_dependency -- Task dependency with circular-dep check
// ---------------------------------------------------------------------------

/** Add a dependency between two tasks. Validates against circular dependencies. */
export async function addDependency(
  sourceId: string,
  targetId: string,
  type: string = 'depends_on'
): Promise<{ id: string }> {
  const supabase = createClient();
  const { data, error } = await supabase.rpc('pm_add_dependency', {
    p_source_id: sourceId,
    p_target_id: targetId,
    p_type: type,
  });
  if (error) throw error;
  return data as unknown as { id: string };
}

// ---------------------------------------------------------------------------
// 11. pm_remove_dependency
// ---------------------------------------------------------------------------

/** Remove a task dependency. */
export async function removeDependency(dependencyId: string): Promise<{ success: boolean }> {
  const supabase = createClient();
  const { data, error } = await supabase.rpc('pm_remove_dependency', {
    p_dependency_id: dependencyId,
  });
  if (error) throw error;
  return data as unknown as { success: boolean };
}

// ---------------------------------------------------------------------------
// 12. pm_create_label
// ---------------------------------------------------------------------------

/** Create a new label, optionally scoped to a project. */
export async function createLabel(
  name: string,
  color: string = '#6B7280',
  projectId?: string | null
): Promise<{ id: string }> {
  const supabase = createClient();
  const { data, error } = await supabase.rpc('pm_create_label', {
    p_name: name,
    p_color: color,
    p_project_id: projectId || null,
  });
  if (error) throw error;
  return data as unknown as { id: string };
}

/** Delete a label entirely (removes all item associations). */
export async function deleteLabel(labelId: string): Promise<void> {
  const supabase = createClient();
  const { error } = await supabase.rpc('pm_delete_label', {
    p_label_id: labelId,
  });
  if (error) throw new Error(error.message);
}

// ---------------------------------------------------------------------------
// 13. pm_add_item_label
// ---------------------------------------------------------------------------

/** Attach a label to a backlog item. */
export async function addItemLabel(
  itemId: string,
  labelId: string
): Promise<{ success: boolean }> {
  const supabase = createClient();
  const { data, error } = await supabase.rpc('pm_add_item_label', {
    p_item_id: itemId,
    p_label_id: labelId,
  });
  if (error) throw error;
  return data as unknown as { success: boolean };
}

// ---------------------------------------------------------------------------
// 14. pm_remove_item_label
// ---------------------------------------------------------------------------

/** Remove a label from a backlog item. */
export async function removeItemLabel(
  itemId: string,
  labelId: string
): Promise<{ success: boolean }> {
  const supabase = createClient();
  const { data, error } = await supabase.rpc('pm_remove_item_label', {
    p_item_id: itemId,
    p_label_id: labelId,
  });
  if (error) throw error;
  return data as unknown as { success: boolean };
}

// ---------------------------------------------------------------------------
// 15. pm_list_labels
// ---------------------------------------------------------------------------

/** List global labels and optionally project-scoped labels. */
export async function listLabels(projectId?: string | null): Promise<PmLabel[]> {
  const supabase = createClient();
  const { data, error } = await supabase.rpc('pm_list_labels', {
    p_project_id: projectId || null,
  });
  if (error) throw error;
  return (data ?? []) as unknown as PmLabel[];
}

// ---------------------------------------------------------------------------
// 16. pm_link_items -- Create item relationship
// ---------------------------------------------------------------------------

/** Link two backlog items with a relationship type. */
export async function linkItems(
  sourceId: string,
  targetId: string,
  linkType: string
): Promise<{ link_id: string; linked: boolean }> {
  const supabase = createClient();
  const { data, error } = await supabase.rpc('pm_link_items', {
    p_source_id: sourceId,
    p_target_id: targetId,
    p_link_type: linkType,
  });
  if (error) throw error;
  return data as unknown as { link_id: string; linked: boolean };
}

// ---------------------------------------------------------------------------
// 17. pm_unlink_items -- Remove a link
// ---------------------------------------------------------------------------

/** Remove a link between items by link ID. */
export async function unlinkItems(
  linkId: string
): Promise<{ success: boolean }> {
  const supabase = createClient();
  const { data, error } = await supabase.rpc('pm_unlink_items', {
    p_link_id: linkId,
  });
  if (error) throw error;
  return data as unknown as { success: boolean };
}

// ---------------------------------------------------------------------------
// 18. pm_search_items_for_link -- Autocomplete for linking
// ---------------------------------------------------------------------------

/** Search for items to link, with optional exclusion. */
export async function searchItemsForLink(
  query: string,
  excludeId?: string | null
): Promise<PmItemSearchResult[]> {
  const supabase = createClient();
  const { data, error } = await supabase.rpc('pm_search_items_for_link', {
    p_query: query,
    p_exclude_id: excludeId || null,
  });
  if (error) throw error;
  return (data ?? []) as unknown as PmItemSearchResult[];
}

// ---------------------------------------------------------------------------
// 19. pm_assign_to_sprint -- Bulk assign items to sprint
// ---------------------------------------------------------------------------

/** Assign one or more backlog items to a sprint. */
export async function assignToSprint(
  itemIds: string[],
  sprintId: string
): Promise<{ success: boolean; updated_count: number }> {
  const supabase = createClient();
  const { data, error } = await supabase.rpc('pm_assign_to_sprint', {
    p_item_ids: itemIds,
    p_sprint_id: sprintId,
  });
  if (error) throw error;
  return data as unknown as { success: boolean; updated_count: number };
}

// ---------------------------------------------------------------------------
// 20. pm_remove_from_sprint -- Remove items from sprint
// ---------------------------------------------------------------------------

/** Remove one or more backlog items from their sprint. */
export async function removeFromSprint(
  itemIds: string[]
): Promise<{ success: boolean; updated_count: number }> {
  const supabase = createClient();
  const { data, error } = await supabase.rpc('pm_remove_from_sprint', {
    p_item_ids: itemIds,
  });
  if (error) throw error;
  return data as unknown as { success: boolean; updated_count: number };
}

// ---------------------------------------------------------------------------
// 21. pm_list_sprints -- All sprints with item counts
// ---------------------------------------------------------------------------

/** List all sprints with item counts. */
export async function listSprints(): Promise<PmSprint[]> {
  const supabase = createClient();
  const { data, error } = await supabase.rpc('pm_list_sprints');
  if (error) throw error;
  return (data ?? []) as unknown as PmSprint[];
}

// ---------------------------------------------------------------------------
// 22. pm_get_sprint_detail -- Sprint with items and metrics
// ---------------------------------------------------------------------------

/** Get full sprint detail including items, tasks, and metrics. */
export async function getSprintDetail(sprintId: string): Promise<SprintDetailResponse> {
  const supabase = createClient();
  const { data, error } = await supabase.rpc('pm_get_sprint_detail', {
    p_sprint_id: sprintId,
  });
  if (error) throw error;
  return validateSprintDetailResponse(data);
}

// ---------------------------------------------------------------------------
// 23. pm_create_sprint
// ---------------------------------------------------------------------------

/**
 * Create a new sprint.
 *
 * @param projectId Deprecated (BACKLOG-1664). Sprints are standalone and may
 *   hold tasks from multiple projects; always pass `null`. The parameter
 *   remains on the RPC signature for back-compat; the column is preserved in
 *   `pm_sprints` but is no longer used for project-scoped sprint lookups.
 */
export async function createSprint(
  name: string,
  goal?: string | null,
  projectId?: string | null,
  startDate?: string | null,
  endDate?: string | null
): Promise<{ id: string }> {
  const supabase = createClient();
  const { data, error } = await supabase.rpc('pm_create_sprint', {
    p_name: name,
    p_goal: goal || null,
    p_project_id: projectId || null,
    p_start_date: startDate || null,
    p_end_date: endDate || null,
  });
  if (error) throw error;
  return data as unknown as { id: string };
}

// ---------------------------------------------------------------------------
// 24. pm_update_sprint_status
// ---------------------------------------------------------------------------

/** Update a sprint's status. */
export async function updateSprintStatus(
  sprintId: string,
  status: SprintStatus
): Promise<{ success: boolean; old_status: string; new_status: string }> {
  const supabase = createClient();
  const { data, error } = await supabase.rpc('pm_update_sprint_status', {
    p_sprint_id: sprintId,
    p_status: status,
  });
  if (error) throw error;
  return data as unknown as { success: boolean; old_status: string; new_status: string };
}

// ---------------------------------------------------------------------------
// 25. pm_get_sprint_velocity -- Velocity data for charts
// ---------------------------------------------------------------------------

/** Get sprint velocity data for the last N sprints. */
export async function getSprintVelocity(count: number = 10): Promise<SprintVelocityEntry[]> {
  const supabase = createClient();
  const { data, error } = await supabase.rpc('pm_get_sprint_velocity', {
    p_count: count,
  });
  if (error) throw error;
  return (data ?? []) as unknown as SprintVelocityEntry[];
}

// ---------------------------------------------------------------------------
// 26. pm_list_projects
// ---------------------------------------------------------------------------

/** List all active projects with item and sprint counts. */
export async function listProjects(): Promise<PmProject[]> {
  const supabase = createClient();
  const { data, error } = await supabase.rpc('pm_list_projects');
  if (error) throw error;
  return (data ?? []) as unknown as PmProject[];
}

// ---------------------------------------------------------------------------
// 27. pm_create_project
// ---------------------------------------------------------------------------

/** Create a new project. */
export async function createProject(
  name: string,
  description?: string | null
): Promise<{ id: string }> {
  const supabase = createClient();
  const { data, error } = await supabase.rpc('pm_create_project', {
    p_name: name,
    p_description: description || null,
  });
  if (error) throw error;
  return data as unknown as { id: string };
}

// ---------------------------------------------------------------------------
// 28. pm_get_project_detail
// ---------------------------------------------------------------------------

/** Get project detail with sprints and item status breakdown. */
export async function getProjectDetail(projectId: string): Promise<ProjectDetailResponse> {
  const supabase = createClient();
  const { data, error } = await supabase.rpc('pm_get_project_detail', {
    p_project_id: projectId,
  });
  if (error) throw error;
  return data as unknown as ProjectDetailResponse;
}

// ---------------------------------------------------------------------------
// 29. pm_get_board_tasks -- Board view grouped by status
// ---------------------------------------------------------------------------

/** Get items grouped by status for board view. Requires at least one filter. */
export async function getBoardTasks(
  sprintId?: string | null,
  projectId?: string | null,
  area?: string | null
): Promise<BoardColumns> {
  const supabase = createClient();
  const { data, error } = await supabase.rpc('pm_get_board_tasks', {
    p_sprint_id: sprintId || null,
    p_project_id: projectId || null,
    p_area: area || null,
  });
  if (error) throw error;
  return data as unknown as BoardColumns;
}

// ---------------------------------------------------------------------------
// 30. pm_get_stats -- Aggregate counts for dashboard
// ---------------------------------------------------------------------------

/** Get aggregate stats: totals by status, priority, type. */
export async function getStats(): Promise<PmStats> {
  const supabase = createClient();
  const { data, error } = await supabase.rpc('pm_get_stats');
  if (error) throw error;
  return data as unknown as PmStats;
}

// ---------------------------------------------------------------------------
// 31. pm_bulk_update -- Bulk status/priority/sprint changes
// ---------------------------------------------------------------------------

/** Bulk update multiple items with the same set of field changes. */
export async function bulkUpdate(
  itemIds: string[],
  updates: BulkUpdateFields
): Promise<{ success: boolean; updated_count: number }> {
  const supabase = createClient();
  const { data, error } = await supabase.rpc('pm_bulk_update', {
    p_item_ids: itemIds,
    p_updates: updates,
  });
  if (error) throw error;
  return data as unknown as { success: boolean; updated_count: number };
}

// ---------------------------------------------------------------------------
// 32. pm_save_view -- Save filter configuration
// ---------------------------------------------------------------------------

/** Save a filter view for the current user. */
export async function saveView(
  name: string,
  filtersJson: Record<string, unknown>,
  isShared: boolean = false
): Promise<{ id: string }> {
  const supabase = createClient();
  const { data, error } = await supabase.rpc('pm_save_view', {
    p_name: name,
    p_filters_json: filtersJson,
    p_is_shared: isShared,
  });
  if (error) throw error;
  return data as unknown as { id: string };
}

// ---------------------------------------------------------------------------
// 33. pm_list_saved_views -- User's own + shared views
// ---------------------------------------------------------------------------

/** List the current user's saved views plus shared views. */
export async function listSavedViews(): Promise<PmSavedView[]> {
  const supabase = createClient();
  const { data, error } = await supabase.rpc('pm_list_saved_views');
  if (error) throw error;
  return (data ?? []) as unknown as PmSavedView[];
}

// ---------------------------------------------------------------------------
// 34. pm_delete_saved_view -- Only owner can delete
// ---------------------------------------------------------------------------

/** Delete a saved view. Only the owner can delete it. */
export async function deleteSavedView(viewId: string): Promise<{ success: boolean }> {
  const supabase = createClient();
  const { data, error } = await supabase.rpc('pm_delete_saved_view', {
    p_view_id: viewId,
  });
  if (error) throw error;
  return data as unknown as { success: boolean };
}

// ---------------------------------------------------------------------------
// 35. pm_get_my_notifications -- Events where user is assignee
// ---------------------------------------------------------------------------

/** Get notifications for the current user (events on assigned items/tasks). */
export async function getMyNotifications(since?: string | null): Promise<PmNotification[]> {
  const supabase = createClient();
  const { data, error } = await supabase.rpc('pm_get_my_notifications', {
    p_since: since || null,
  });
  if (error) throw error;
  return (data ?? []) as unknown as PmNotification[];
}

// ---------------------------------------------------------------------------
// 35b. pm_get_recent_activity -- All recent events across project
// ---------------------------------------------------------------------------

/** Get recent activity across all project items with optional event type filter. */
export async function getRecentActivity(
  since?: string | null,
  eventTypes?: string[] | null,
  limit?: number,
  offset?: number,
): Promise<PmNotification[]> {
  const supabase = createClient();
  const { data, error } = await supabase.rpc('pm_get_recent_activity', {
    p_since: since || null,
    p_event_types: eventTypes || null,
    p_limit: limit || 20,
    p_offset: offset || 0,
  });
  if (error) throw error;
  return (data ?? []) as unknown as PmNotification[];
}

// ---------------------------------------------------------------------------
// 36. pm_get_item_by_legacy_id -- Agent helper
// ---------------------------------------------------------------------------

/** Look up a backlog item by its legacy ID (e.g., "BACKLOG-123"). Returns full detail. */
export async function getItemByLegacyId(legacyId: string): Promise<ItemDetailResponse> {
  const supabase = createClient();
  const { data, error } = await supabase.rpc('pm_get_item_by_legacy_id', {
    p_legacy_id: legacyId,
  });
  if (error) throw error;
  return data as unknown as ItemDetailResponse;
}

// ---------------------------------------------------------------------------
// 37. pm_update_task_status -- Task status transition
// ---------------------------------------------------------------------------

/** Update a task's status. DB validates the transition. */
export async function updateTaskStatus(
  taskId: string,
  newStatus: TaskStatus
): Promise<TaskStatusUpdateResult> {
  const supabase = createClient();
  const { data, error } = await supabase.rpc('pm_update_task_status', {
    p_task_id: taskId,
    p_new_status: newStatus,
  });
  if (error) throw error;
  return data as unknown as TaskStatusUpdateResult;
}

// ---------------------------------------------------------------------------
// 38. pm_get_task_by_legacy_id -- Look up task by legacy ID
// ---------------------------------------------------------------------------

/** Look up a task by its legacy ID (e.g., "TASK-2226"). Returns null if not found. */
export async function getTaskByLegacyId(
  legacyId: string
): Promise<TaskLegacyLookup | null> {
  const supabase = createClient();
  const { data, error } = await supabase.rpc('pm_get_task_by_legacy_id', {
    p_legacy_id: legacyId,
  });
  if (error) throw error;
  if ((data as Record<string, unknown>)?.error) return null;
  return data as unknown as TaskLegacyLookup;
}

// ---------------------------------------------------------------------------
// 39. pm_record_task_tokens -- Record actual token usage for a task
// ---------------------------------------------------------------------------

/** Record actual token usage for a task, rolling up to the parent backlog item. */
export async function recordTaskTokens(
  taskId: string,
  actualTokens: number,
  agentId?: string,
  agentType?: string,
  inputTokens?: number,
  outputTokens?: number,
  cacheRead?: number,
  cacheCreate?: number,
  durationMs?: number,
  apiCalls?: number,
  sessionId?: string
): Promise<TaskTokenResult> {
  const supabase = createClient();
  const { data, error } = await supabase.rpc('pm_record_task_tokens', {
    p_task_id: taskId,
    p_actual_tokens: actualTokens,
    p_agent_id: agentId ?? null,
    p_agent_type: agentType ?? null,
    p_input_tokens: inputTokens ?? null,
    p_output_tokens: outputTokens ?? null,
    p_cache_read: cacheRead ?? null,
    p_cache_create: cacheCreate ?? null,
    p_duration_ms: durationMs ?? null,
    p_api_calls: apiCalls ?? null,
    p_session_id: sessionId ?? null,
  });
  if (error) throw error;
  return data as unknown as TaskTokenResult;
}

// ---------------------------------------------------------------------------
// 40. pm_log_agent_metrics -- Standalone agent metrics logging
// ---------------------------------------------------------------------------

/** Log agent metrics, optionally tied to a task. */
export async function logAgentMetrics(
  agentId: string,
  params?: {
    agentType?: string;
    taskId?: string;
    description?: string;
    inputTokens?: number;
    outputTokens?: number;
    cacheRead?: number;
    cacheCreate?: number;
    totalTokens?: number;
    durationMs?: number;
    apiCalls?: number;
    sessionId?: string;
    model?: string;
  }
): Promise<AgentMetricResult> {
  const supabase = createClient();
  const { data, error } = await supabase.rpc('pm_log_agent_metrics', {
    p_agent_id: agentId,
    p_agent_type: params?.agentType ?? null,
    p_task_id: params?.taskId ?? null,
    p_description: params?.description ?? null,
    p_input_tokens: params?.inputTokens ?? 0,
    p_output_tokens: params?.outputTokens ?? 0,
    p_cache_read: params?.cacheRead ?? 0,
    p_cache_create: params?.cacheCreate ?? 0,
    p_total_tokens: params?.totalTokens ?? 0,
    p_duration_ms: params?.durationMs ?? 0,
    p_api_calls: params?.apiCalls ?? 0,
    p_session_id: params?.sessionId ?? null,
    p_model: params?.model ?? null,
  });
  if (error) throw error;
  return data as unknown as AgentMetricResult;
}

// ---------------------------------------------------------------------------
// 41. pm_delete_sprint -- Soft-delete a sprint
// ---------------------------------------------------------------------------

/** Soft-delete a sprint by setting deleted_at. */
export async function deleteSprint(sprintId: string): Promise<void> {
  const supabase = createClient();
  const { error } = await supabase.rpc('pm_delete_sprint', {
    p_sprint_id: sprintId,
  });
  if (error) throw new Error(error.message);
}

// ---------------------------------------------------------------------------
// 41b. pm_delete_project -- Soft-delete a project
// ---------------------------------------------------------------------------

/** Soft-delete a project by setting deleted_at. */
export async function deleteProject(projectId: string): Promise<void> {
  const supabase = createClient();
  const { error } = await supabase.rpc('pm_delete_project', {
    p_project_id: projectId,
  });
  if (error) throw new Error(error.message);
}

// ---------------------------------------------------------------------------
// 42. listAssignableUsers -- Profiles for assignment picker
// ---------------------------------------------------------------------------

/** List users that can be assigned to items (via SECURITY DEFINER RPC to bypass profiles RLS). */
export async function listAssignableUsers(): Promise<
  { id: string; display_name: string | null; email: string }[]
> {
  const supabase = createClient();
  const { data, error } = await supabase.rpc('pm_list_assignable_users');
  if (error) throw error;
  return (data ?? []) as { id: string; display_name: string | null; email: string }[];
}

// ---------------------------------------------------------------------------
// 42. pm_update_project_field -- Update project name/description
// ---------------------------------------------------------------------------

/** Update a single whitelisted field on a project (name, description, status, priority). */
export async function updateProjectField(
  projectId: string,
  field: ProjectField,
  value: string | null
): Promise<{ success: boolean; field: string; old_value: string | null; new_value: string | null }> {
  const supabase = createClient();
  const { data, error } = await supabase.rpc('pm_update_project_field', {
    p_project_id: projectId,
    p_field: field,
    p_value: value,
  });
  if (error) throw error;
  return data as unknown as { success: boolean; field: string; old_value: string | null; new_value: string | null };
}

// ---------------------------------------------------------------------------
// 43. pm_update_sprint_field -- Update sprint name/goal
// ---------------------------------------------------------------------------

/** Update a single whitelisted field on a sprint (name, goal). */
export async function updateSprintField(
  sprintId: string,
  field: SprintField,
  value: string | null
): Promise<{ success: boolean; field: string; old_value: string | null; new_value: string | null }> {
  const supabase = createClient();
  const { data, error } = await supabase.rpc('pm_update_sprint_field', {
    p_sprint_id: sprintId,
    p_field: field,
    p_value: value,
  });
  if (error) throw error;
  return data as unknown as { success: boolean; field: string; old_value: string | null; new_value: string | null };
}

// ---------------------------------------------------------------------------
// 44. pm_bulk_delete -- Atomic bulk deletion
// ---------------------------------------------------------------------------

/** Bulk soft-delete multiple backlog items in a single RPC call. */
export async function bulkDelete(
  itemIds: string[]
): Promise<{ success: boolean; deleted_count: number }> {
  const supabase = createClient();
  const { data, error } = await supabase.rpc('pm_bulk_delete', {
    p_item_ids: itemIds,
  });
  if (error) throw error;
  return data as unknown as { success: boolean; deleted_count: number };
}

// ---------------------------------------------------------------------------
// Runtime validation helpers (BACKLOG-1061)
// ---------------------------------------------------------------------------

/**
 * Lightweight runtime validation for critical RPC responses.
 * These catch schema drift before it causes silent data bugs.
 */

function validateItemDetailResponse(data: unknown): ItemDetailResponse {
  const d = data as Record<string, unknown>;
  if (!d || typeof d !== 'object') {
    throw new Error('Invalid response from pm_get_item_detail: not an object');
  }
  const item = d.item as Record<string, unknown> | undefined;
  if (!item?.id || !item?.title || !item?.status) {
    throw new Error('Invalid response from pm_get_item_detail: missing required fields (id, title, status)');
  }
  return d as unknown as ItemDetailResponse;
}

function validateItemListResponse(data: unknown): ItemListResponse {
  const d = data as Record<string, unknown>;
  if (!d || typeof d !== 'object') {
    throw new Error('Invalid response from pm_list_items: not an object');
  }
  if (!Array.isArray(d.items)) {
    throw new Error('Invalid response from pm_list_items: items is not an array');
  }
  if (typeof d.total_count !== 'number') {
    throw new Error('Invalid response from pm_list_items: total_count is not a number');
  }
  return d as unknown as ItemListResponse;
}

function validateSprintDetailResponse(data: unknown): SprintDetailResponse {
  const d = data as Record<string, unknown>;
  if (!d || typeof d !== 'object') {
    throw new Error('Invalid response from pm_get_sprint_detail: not an object');
  }
  const sprint = d.sprint as Record<string, unknown> | undefined;
  if (!sprint?.id || !sprint?.name) {
    throw new Error('Invalid response from pm_get_sprint_detail: missing sprint.id or sprint.name');
  }
  if (!d.metrics || typeof d.metrics !== 'object') {
    throw new Error('Invalid response from pm_get_sprint_detail: missing metrics object');
  }
  return d as unknown as SprintDetailResponse;
}

// ---------------------------------------------------------------------------
// Token Metrics Queries — breakdown by agent type for tasks/sprints
// ---------------------------------------------------------------------------

import type { TokenMetricRow, TokenMetricsSummary } from './pm-types';

/** Fetch raw metric rows for a backlog item.
 *  Queries by: (1) direct backlog_item_id FK, (2) child task legacy_ids, (3) backlog item's own legacy_id.
 *  Results are deduplicated by metric ID. */
export async function getTaskMetrics(backlogItemId: string): Promise<TokenMetricRow[]> {
  const supabase = createClient();
  const cols = 'id, agent_id, agent_type, task_id, description, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, total_tokens, billable_tokens, duration_ms, api_calls, model, recorded_at';

  // Query 1: Direct backlog_item_id FK (populated by hook via p_backlog_item_id)
  const directQuery = supabase
    .from('pm_token_metrics')
    .select(cols)
    .eq('backlog_item_id', backlogItemId)
    .order('recorded_at', { ascending: true });

  // Query 2: Via child task legacy_ids
  const { data: tasks } = await supabase
    .from('pm_tasks')
    .select('legacy_id')
    .eq('backlog_item_id', backlogItemId)
    .not('legacy_id', 'is', null);

  const taskIds = (tasks ?? []).map(t => t.legacy_id).filter(Boolean) as string[];

  // Also try the backlog item's own legacy_id
  const { data: item } = await supabase
    .from('pm_backlog_items')
    .select('legacy_id')
    .eq('id', backlogItemId)
    .single();

  if (item?.legacy_id) taskIds.push(item.legacy_id);

  // Execute both queries
  const { data: directRows, error: directErr } = await directQuery;
  if (directErr) throw directErr;

  let legacyRows: TokenMetricRow[] = [];
  if (taskIds.length > 0) {
    const { data, error } = await supabase
      .from('pm_token_metrics')
      .select(cols)
      .in('task_id', taskIds)
      .order('recorded_at', { ascending: true });
    if (error) throw error;
    legacyRows = (data ?? []) as TokenMetricRow[];
  }

  // Deduplicate by id (a metric may match both queries)
  const seen = new Set<string>();
  const result: TokenMetricRow[] = [];
  for (const row of [...(directRows ?? []) as TokenMetricRow[], ...legacyRows]) {
    if (!seen.has(row.id)) {
      seen.add(row.id);
      result.push(row);
    }
  }
  result.sort((a, b) => a.recorded_at.localeCompare(b.recorded_at));
  return result;
}

/** Fetch raw metric rows for a sprint (by sprint UUID). */
export async function getSprintMetrics(sprintId: string): Promise<TokenMetricRow[]> {
  const supabase = createClient();
  const { data, error } = await supabase
    .from('pm_token_metrics')
    .select('id, agent_id, agent_type, task_id, description, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, total_tokens, billable_tokens, duration_ms, api_calls, model, recorded_at')
    .eq('sprint_id', sprintId)
    .order('recorded_at', { ascending: true });
  if (error) throw error;
  return (data ?? []) as TokenMetricRow[];
}

/** Summarize metrics by agent_type for a set of rows. */
export function summarizeByAgentType(rows: TokenMetricRow[]): TokenMetricsSummary[] {
  const map = new Map<string, TokenMetricsSummary>();
  for (const row of rows) {
    const type = row.agent_type ?? 'unknown';
    const existing = map.get(type);
    if (existing) {
      existing.runs += 1;
      existing.total_tokens += row.total_tokens;
      existing.billable_tokens += row.billable_tokens;
      existing.duration_ms += row.duration_ms;
    } else {
      map.set(type, {
        agent_type: type,
        runs: 1,
        total_tokens: row.total_tokens,
        billable_tokens: row.billable_tokens,
        duration_ms: row.duration_ms,
      });
    }
  }
  return Array.from(map.values()).sort((a, b) => b.total_tokens - a.total_tokens);
}
