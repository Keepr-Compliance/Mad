/**
 * Dashboard "Todo" groups — BACKLOG-3965 PR-3.
 *
 * The Todo panel (PR-4b) renders an ordered list of `TodoGroup`s. 3965 ships
 * one group, built here from the `checklists:list-open-required` answer. The
 * auto-detect lane adds its own group at the front with no layout change.
 *
 * Pure functions, no bridge: the panel reads through `checklistService`.
 */
import type {
  OpenRequiredChecklistItem,
  OpenRequiredChecklistItems,
  TodoGroup,
} from "../../electron/types/checklistTodo";

export const REQUIRED_ITEMS_GROUP_ID = "required-checklist-items";

/** The required-items group: every row read, counted by the uncapped total. */
export function requiredItemsGroup(
  data: OpenRequiredChecklistItems,
): TodoGroup<OpenRequiredChecklistItem> {
  return {
    id: REQUIRED_ITEMS_GROUP_ID,
    header: "Required",
    count: data.totalCount,
    rows: data.items,
    status: null,
  };
}

/**
 * The groups the panel draws, in order. A group with no rows and no status
 * line is dropped, so no header ever renders over nothing (SR plan review,
 * change 3). When every group is dropped the panel shows its empty state.
 */
export function visibleTodoGroups<Row>(groups: readonly TodoGroup<Row>[]): TodoGroup<Row>[] {
  return groups.filter((group) => group.rows.length > 0 || group.status !== null);
}
