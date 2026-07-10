/**
 * Type definitions for the Project Management module.
 *
 * All types match the actual Supabase schema (20260316_pm_schema.sql)
 * and RPC return shapes (20260316_pm_rpcs.sql).
 */

// ---------------------------------------------------------------------------
// Enum types (match DB CHECK constraints exactly)
// ---------------------------------------------------------------------------

export type ItemStatus =
  | 'pending'
  | 'in_progress'
  | 'testing'
  | 'completed'
  | 'blocked'
  | 'deferred'
  | 'obsolete'
  | 'reopened'
  | 'waiting_for_user';

export type ItemPriority = 'low' | 'medium' | 'high' | 'critical';

export type ItemType = 'feature' | 'bug' | 'chore' | 'spike' | 'epic';

export type TaskStatus =
  | 'pending'
  | 'in_progress'
  | 'testing'
  | 'completed'
  | 'blocked'
  | 'deferred';

export type DependencyType = 'depends_on' | 'blocks';

export type LinkType =
  | 'blocked_by'
  | 'blocks'
  | 'related_to'
  | 'parent_child'
  | 'duplicates';

export type SprintStatus = 'planned' | 'active' | 'completed' | 'cancelled';

export type ProjectStatus = 'planned' | 'active' | 'on_hold' | 'completed' | 'archived';

// ---------------------------------------------------------------------------
// Assignable user (returned by pm_list_assignable_users RPC)
// ---------------------------------------------------------------------------

export interface AssignableUser {
  id: string;
  display_name: string | null;
  email: string;
}

// ---------------------------------------------------------------------------
// Core interfaces (match DB tables and RPC return shapes)
// ---------------------------------------------------------------------------

export interface PmBacklogItem {
  id: string;
  item_number: number;
  legacy_id: string | null;
  title: string;
  description: string | null;
  body: string | null;
  type: ItemType;
  area: string | null;
  status: ItemStatus;
  priority: ItemPriority;
  parent_id: string | null;
  project_id: string | null;
  sprint_id: string | null;
  assignee_id: string | null;
  est_tokens: number | null;
  actual_tokens: number | null;
  variance: number | null;
  sort_order: number;
  start_date: string | null;
  due_date: string | null;
  file: string | null;
  branch_name: string | null;
  pr_url: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
  deleted_at: string | null;
  // Joined from RPCs (pm_list_items)
  labels?: PmLabel[];
  child_count?: number;
}

export interface PmSprint {
  id: string;
  legacy_id: string | null;
  name: string;
  goal: string | null;
  body: string | null;
  status: SprintStatus;
  start_date: string | null;
  end_date: string | null;
  /**
   * @deprecated BACKLOG-1664. Sprints are standalone — they can hold tasks
   * from multiple projects. Do not filter sprint lookups on this column;
   * join through `pm_backlog_items.project_id` instead. The column remains
   * in the schema to keep legacy rows queryable through the RPC's OR-branch.
   */
  project_id: string | null;
  original_item_count?: number | null;
  created_at: string;
  updated_at: string;
  // Joined from RPCs (pm_list_sprints, pm_get_project_detail)
  item_counts?: Record<string, number>;
  total_items?: number;
  /**
   * Count of non-deleted backlog items in this sprint that belong to the
   * project the caller scoped the RPC to. Populated by `pm_get_project_detail`
   * (BACKLOG-1664). Undefined when the sprint row came from a sprint-centric
   * RPC like `pm_list_sprints`.
   */
  project_total?: number;
  /**
   * Count of completed items among `project_total`. Populated by
   * `pm_get_project_detail` (BACKLOG-1664).
   */
  project_completed?: number;
}

export interface PmProject {
  id: string;
  name: string;
  description: string | null;
  status: ProjectStatus;
  priority: ItemPriority;
  owner_id: string | null;
  sort_order: number;
  deleted_at: string | null;
  created_at: string;
  updated_at: string;
  // Joined from RPCs (pm_list_projects)
  item_count?: number;
  active_sprint_count?: number;
}

export interface PmTask {
  id: string;
  legacy_id: string | null;
  title: string;
  description: string | null;
  body: string | null;
  status: TaskStatus;
  backlog_item_id: string | null;
  sprint_id: string | null;
  assignee_id: string | null;
  est_tokens: number | null;
  actual_tokens: number | null;
  sort_order: number;
  deleted_at: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

export interface PmComment {
  id: string;
  item_id: string | null;
  task_id: string | null;
  author_id: string | null;
  body: string;
  deleted_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface PmEvent {
  id: string;
  item_id: string | null;
  task_id: string | null;
  actor_id: string | null;
  event_type: string;
  old_value: string | null;
  new_value: string | null;
  metadata: Record<string, unknown> | null;
  created_at: string;
}

export interface PmDependency {
  id: string;
  source_id: string;
  target_id: string;
  dependency_type: DependencyType;
  created_at: string;
  // Joined fields from pm_list_item_dependencies RPC
  related_title?: string | null;
  related_legacy_id?: string | null;
  related_item_number?: number | null;
  related_status?: string | null;
}

export interface PmLabel {
  id: string;
  name: string;
  color: string;
  project_id?: string | null;
  created_at?: string;
}

/**
 * PmTaskLink represents a relationship between two **backlog items**
 * (not tasks). The "task" in the name is a historical misnomer from the
 * pm_task_links table; both source and target are pm_backlog_items.
 */
export interface PmTaskLink {
  link_id: string;
  link_type: LinkType;
  direction: 'outgoing' | 'incoming';
  item_id: string;
  item_title: string;
  item_legacy_id: string | null;
  item_status: string;
}

export interface PmSavedView {
  id: string;
  name: string;
  filters: Record<string, unknown>;
  is_shared: boolean;
  is_own: boolean;
  created_at: string;
}

export interface PmItemChild {
  id: string;
  title: string;
  legacy_id: string | null;
  status: ItemStatus;
  priority: ItemPriority;
  type: ItemType;
}

// ---------------------------------------------------------------------------
// Notification type (from pm_get_my_notifications)
// ---------------------------------------------------------------------------

export interface PmNotification {
  event_id: string;
  event_type: string;
  old_value: string | null;
  new_value: string | null;
  metadata: Record<string, unknown> | null;
  actor_id: string | null;
  actor_name?: string | null;
  comment_body?: string | null;
  created_at: string;
  item_id: string | null;
  item_title: string | null;
  item_legacy_id: string | null;
  task_id: string | null;
}

// ---------------------------------------------------------------------------
// Search result type (from pm_search_items_for_link)
// ---------------------------------------------------------------------------

export interface PmItemSearchResult {
  id: string;
  title: string;
  legacy_id: string | null;
  item_number: number | null;
  status: string;
  type: string;
  priority: string;
}

// ---------------------------------------------------------------------------
// Request / Response types
// ---------------------------------------------------------------------------

export interface ItemListParams {
  status?: ItemStatus | null;
  priority?: ItemPriority | null;
  type?: ItemType | null;
  area?: string | null;
  sprint_id?: string | null;
  project_id?: string | null;
  search?: string | null;
  labels?: string[] | null;
  parent_id?: string | null;
  assignee_id?: string | null;
  page?: number;
  page_size?: number;
  root_only?: boolean;
  unassigned_only?: boolean;
}

export interface ItemListResponse {
  items: PmBacklogItem[];
  total_count: number;
  page: number;
  page_size: number;
}

export interface PmItemParent {
  id: string;
  title: string;
  item_number: number;
  legacy_id: string | null;
  status: ItemStatus;
  priority: ItemPriority;
  type: ItemType;
}

export interface ItemDetailResponse {
  item: PmBacklogItem;
  comments: PmComment[];
  events: PmEvent[];
  links: PmTaskLink[];
  labels: PmLabel[];
  children: PmItemChild[];
  parent: PmItemParent | null;
}

export interface CreateItemParams {
  title: string;
  description?: string | null;
  type?: ItemType;
  area?: string | null;
  priority?: ItemPriority;
  parent_id?: string | null;
  project_id?: string | null;
  sprint_id?: string | null;
  est_tokens?: number | null;
  start_date?: string | null;
  due_date?: string | null;
}

export interface PmStats {
  total_open: number;
  unassigned: number;
  by_status: Record<string, number>;
  by_priority: Record<string, number>;
  by_type: Record<string, number>;
  active_sprints: number;
}

export interface SprintDetailResponse {
  sprint: PmSprint;
  items: PmBacklogItem[];
  tasks: PmTask[];
  metrics: {
    total_items: number;
    completed_items: number;
    in_progress_items: number;
    total_est_tokens: number;
    total_actual_tokens: number;
  };
}

export interface ProjectDetailResponse {
  project: PmProject;
  sprints: PmSprint[];
  items_by_status: Record<string, number>;
}

export interface SprintVelocityEntry {
  sprint_id: string;
  sprint_name: string;
  legacy_id: string | null;
  status: SprintStatus;
  end_date: string | null;
  total_est_tokens: number;
  total_actual_tokens: number;
  completed_items: number;
  total_items: number;
}

export interface BoardColumns {
  pending: PmBacklogItem[];
  in_progress: PmBacklogItem[];
  testing: PmBacklogItem[];
  completed: PmBacklogItem[];
  blocked: PmBacklogItem[];
  deferred: PmBacklogItem[];
  obsolete: PmBacklogItem[];
  reopened: PmBacklogItem[];
  waiting_for_user: PmBacklogItem[];
}

// ---------------------------------------------------------------------------
// Status transition map (mirrors DB validation logic)
// ---------------------------------------------------------------------------

export const ALLOWED_TRANSITIONS: Record<ItemStatus, ItemStatus[]> = {
  pending: ['in_progress', 'blocked', 'deferred'],
  in_progress: ['testing', 'blocked', 'deferred', 'pending'],
  testing: ['completed', 'in_progress', 'blocked', 'waiting_for_user'],
  completed: ['reopened'],
  blocked: ['pending', 'in_progress'],
  deferred: ['pending'],
  obsolete: [],
  reopened: ['in_progress', 'pending'],
  waiting_for_user: ['completed', 'testing', 'in_progress'],
};

// ---------------------------------------------------------------------------
// Label / color maps for UI
// ---------------------------------------------------------------------------

export const STATUS_LABELS: Record<ItemStatus, string> = {
  pending: 'Pending',
  in_progress: 'In Progress',
  testing: 'Testing',
  completed: 'Completed',
  blocked: 'Blocked',
  deferred: 'Deferred',
  obsolete: 'Obsolete',
  reopened: 'Reopened',
  waiting_for_user: 'Waiting for User',
};

export const STATUS_COLORS: Record<ItemStatus, string> = {
  pending: 'bg-gray-100 text-gray-800',
  in_progress: 'bg-blue-100 text-blue-800',
  testing: 'bg-yellow-100 text-yellow-800',
  completed: 'bg-green-100 text-green-800',
  blocked: 'bg-red-100 text-red-800',
  deferred: 'bg-orange-100 text-orange-800',
  obsolete: 'bg-gray-100 text-gray-500',
  reopened: 'bg-purple-100 text-purple-800',
  waiting_for_user: 'bg-amber-100 text-amber-800',
};

/** Solid background colors for progress-bar segments (no text color needed). */
export const SEGMENT_COLORS: Record<ItemStatus, string> = {
  pending: 'bg-gray-300',
  in_progress: 'bg-blue-500',
  testing: 'bg-yellow-400',
  completed: 'bg-green-500',
  blocked: 'bg-red-500',
  deferred: 'bg-orange-400',
  obsolete: 'bg-gray-400',
  reopened: 'bg-purple-500',
  waiting_for_user: 'bg-amber-400',
};

export const PRIORITY_LABELS: Record<ItemPriority, string> = {
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  critical: 'Critical',
};

export const PRIORITY_COLORS: Record<ItemPriority, string> = {
  low: 'bg-gray-100 text-gray-800',
  medium: 'bg-blue-100 text-blue-800',
  high: 'bg-orange-100 text-orange-800',
  critical: 'bg-red-100 text-red-800',
};

/**
 * Numeric rank for priority sorting (higher = more urgent). Used by the
 * project list sort control so "priority" defaults to critical-first.
 */
export const PRIORITY_RANK: Record<ItemPriority, number> = {
  critical: 4,
  high: 3,
  medium: 2,
  low: 1,
};

export const TYPE_LABELS: Record<ItemType, string> = {
  feature: 'Feature',
  bug: 'Bug',
  chore: 'Chore',
  spike: 'Spike',
  epic: 'Epic',
};

export const TYPE_COLORS: Record<ItemType, string> = {
  feature: 'bg-blue-100 text-blue-800',
  bug: 'bg-red-100 text-red-800',
  chore: 'bg-gray-100 text-gray-800',
  spike: 'bg-purple-100 text-purple-800',
  epic: 'bg-indigo-100 text-indigo-800',
};

/** Canonical area list. Add new areas here -- TaskFilters picks them up automatically. */
export const AREA_LABELS: Record<string, string> = {
  'admin-portal': 'admin-portal',
  electron: 'electron',
  'broker-portal': 'broker-portal',
  'cross-portal': 'cross-portal',
  infrastructure: 'infrastructure',
  infra: 'infra',
  ipc: 'ipc',
  release: 'release',
  schema: 'schema',
  security: 'security',
  service: 'service',
  supabase: 'supabase',
  ui: 'ui',
  uat: 'uat',
  docs: 'docs',
};

export const SPRINT_STATUS_LABELS: Record<SprintStatus, string> = {
  planned: 'Planned',
  active: 'Active',
  completed: 'Completed',
  cancelled: 'Cancelled',
};

export const SPRINT_STATUS_COLORS: Record<SprintStatus, string> = {
  planned: 'bg-gray-100 text-gray-800',
  active: 'bg-green-100 text-green-800',
  completed: 'bg-blue-100 text-blue-800',
  cancelled: 'bg-red-100 text-red-800',
};

export const PROJECT_STATUS_LABELS: Record<ProjectStatus, string> = {
  planned: 'Planned',
  active: 'Active',
  on_hold: 'On Hold',
  completed: 'Completed',
  archived: 'Archived',
};

export const PROJECT_STATUS_COLORS: Record<ProjectStatus, string> = {
  planned: 'bg-purple-100 text-purple-800',
  active: 'bg-green-100 text-green-800',
  on_hold: 'bg-yellow-100 text-yellow-800',
  completed: 'bg-blue-100 text-blue-800',
  archived: 'bg-gray-100 text-gray-500',
};

// ---------------------------------------------------------------------------
// Sortable column keys for backlog table
// ---------------------------------------------------------------------------

export type SortableColumn =
  | 'item_number'
  | 'title'
  | 'type'
  | 'status'
  | 'priority'
  | 'area'
  | 'est_tokens'
  | 'created_at';

export type SortDirection = 'asc' | 'desc';

// ---------------------------------------------------------------------------
// Sortable column keys for sprint table
// ---------------------------------------------------------------------------

export type SprintSortColumn =
  | 'name'
  | 'status'
  | 'start_date'
  | 'end_date'
  | 'total_items'
  | 'progress'
  | 'created_at';

// ---------------------------------------------------------------------------
// Timeline types
// ---------------------------------------------------------------------------

export type PmTimelineEntry =
  | { type: 'comment'; data: PmComment; timestamp: string }
  | { type: 'event'; data: PmEvent; timestamp: string };

// ---------------------------------------------------------------------------
// RPC result types (task-level operations & agent metrics)
// ---------------------------------------------------------------------------

export interface TaskStatusUpdateResult {
  success: boolean;
  task_id: string;
  old_status: string;
  new_status: string;
}

export interface TaskLegacyLookup {
  id: string;
  legacy_id: string;
  title: string;
  status: string;
  backlog_item_id: string;
  sprint_id: string | null;
}

export interface TaskTokenResult {
  success: boolean;
  task_id: string;
  actual_tokens: number;
  parent_actual: number;
  variance: number;
}

export interface AgentMetricResult {
  success: boolean;
  metric_id: string;
}

export interface TokenMetricRow {
  id: string;
  agent_id: string;
  agent_type: string | null;
  task_id: string | null;
  description: string | null;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_creation_tokens: number;
  total_tokens: number;
  billable_tokens: number;
  duration_ms: number;
  api_calls: number;
  model: string | null;
  recorded_at: string;
}

export interface TokenMetricsSummary {
  agent_type: string;
  runs: number;
  total_tokens: number;
  billable_tokens: number;
  duration_ms: number;
}

// ---------------------------------------------------------------------------
// Typed field names for update operations
// ---------------------------------------------------------------------------

/** Whitelisted fields that can be passed to pm_update_item_field. */
export type ItemField =
  | 'title'
  | 'description'
  | 'type'
  | 'area'
  | 'priority'
  | 'project_id'
  | 'est_tokens'
  | 'start_date'
  | 'due_date'
  | 'sprint_id'
  | 'branch_name'
  | 'pr_url';

/** Whitelisted fields that can be passed to pm_update_sprint_field. */
export type SprintField = 'name' | 'goal' | 'start_date' | 'end_date';

/** Whitelisted fields that can be passed to pm_update_project_field. */
export type ProjectField = 'name' | 'description' | 'status' | 'priority';

/** Typed updates object for pm_bulk_update. */
export interface BulkUpdateFields {
  status?: ItemStatus;
  priority?: ItemPriority;
  project_id?: string;
  area?: string;
  assignee_id?: string | null;
}
