/**
 * Board fixtures (BACKLOG-4176).
 *
 * Shape transcribed from a real pm_get_board_tasks row: the RPC returns
 * to_jsonb(pm_backlog_items.*), whose keys are exactly the PmBacklogItem
 * fields below plus `search_vector` (not in the type, never read by the
 * board). Ids are placeholders, not real rows.
 */

import type { BoardColumns, ItemStatus, PmBacklogItem } from '@/lib/pm-types';

export const PROJECT_ID = 'project-p';

export function makeItem(
  overrides: Partial<PmBacklogItem> & Pick<PmBacklogItem, 'id' | 'item_number'>
): PmBacklogItem {
  return {
    actual_tokens: null,
    area: null,
    assignee_id: null,
    body: null,
    branch_name: null,
    completed_at: null,
    created_at: '2026-11-01T00:00:00+00:00',
    deleted_at: null,
    description: null,
    due_date: null,
    est_tokens: null,
    file: null,
    legacy_id: `BACKLOG-${overrides.item_number}`,
    parent_id: null,
    pr_url: null,
    priority: 'medium',
    project_id: PROJECT_ID,
    sort_order: 0,
    sprint_id: null,
    start_date: null,
    status: 'pending',
    title: `Item ${overrides.item_number}`,
    type: 'feature',
    updated_at: '2026-11-01T00:00:00+00:00',
    variance: null,
    ...overrides,
  };
}

export function emptyColumns(): BoardColumns {
  return {
    pending: [], in_progress: [], testing: [], pending_uat: [], waiting_for_user: [], completed: [],
    blocked: [], deferred: [], obsolete: [], reopened: [],
  };
}

/** Build BoardColumns the way the RPC does: each item under its own status. */
export function toColumns(items: PmBacklogItem[]): BoardColumns {
  const cols = emptyColumns();
  for (const item of items) (cols[item.status as keyof BoardColumns] as PmBacklogItem[]).push(item);
  return cols;
}

// A project with: two epics (A has a sub-epic C), one empty epic (B),
// children of A and C, an item under a NON-epic parent, an item with no
// parent, and an item whose epic lives in another project.
export const EPIC_A = makeItem({ id: 'epic-a', item_number: 100, type: 'epic', title: 'Epic A', sort_order: 1 });
export const EPIC_B = makeItem({ id: 'epic-b', item_number: 101, type: 'epic', title: 'Epic B', sort_order: 2, status: 'in_progress' });
export const EPIC_C = makeItem({ id: 'epic-c', item_number: 102, type: 'epic', title: 'Epic C', sort_order: 0, parent_id: 'epic-a' });
export const CHILD_A1 = makeItem({ id: 'child-a1', item_number: 200, parent_id: 'epic-a', sort_order: 7 });
export const CHILD_A2 = makeItem({ id: 'child-a2', item_number: 201, parent_id: 'epic-a', status: 'completed', sort_order: 3 });
export const CHILD_C1 = makeItem({ id: 'child-c1', item_number: 202, parent_id: 'epic-c', status: 'obsolete', sort_order: 4 });
export const PLAIN_PARENT = makeItem({ id: 'plain-parent', item_number: 203, sort_order: 5 });
export const UNDER_PLAIN = makeItem({ id: 'under-plain', item_number: 204, parent_id: 'plain-parent', status: 'testing', sort_order: 9 });
export const ORPHAN = makeItem({ id: 'orphan', item_number: 205, sort_order: 11 });
export const UNDER_FOREIGN_EPIC = makeItem({ id: 'under-foreign', item_number: 206, parent_id: 'epic-in-other-project', sort_order: 13 });

export const PROJECT_ITEMS: PmBacklogItem[] = [
  EPIC_A, EPIC_B, EPIC_C, CHILD_A1, CHILD_A2, CHILD_C1, PLAIN_PARENT, UNDER_PLAIN, ORPHAN, UNDER_FOREIGN_EPIC,
];

export function projectColumns(): BoardColumns {
  return toColumns(PROJECT_ITEMS);
}

export function idsIn(cols: BoardColumns, status: ItemStatus): string[] {
  return (cols[status as keyof BoardColumns] as PmBacklogItem[]).map((i) => i.id);
}
