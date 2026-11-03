/**
 * Dashboard "Todo" types — BACKLOG-3965 PR-3.
 *
 * Type-only, in `electron/types/`, so the renderer may import it (the
 * BACKLOG-2075 rule: a renderer import of a file holding VALUES drags
 * main-process code into the Vite bundle).
 *
 * The read is `checklists:list-open-required`: every REQUIRED checklist item
 * not yet ticked, across the user's active deals that are not locked. The
 * Dashboard's Todo panel (BACKLOG-3965 PR-4b) renders it as one group.
 */

/** One required item still to tick, on one active, unlocked deal. */
export interface OpenRequiredChecklistItem {
  itemId: string;
  checklistId: string;
  /** The item's title, as copied onto the deal's checklist. */
  title: string;
  transactionId: string;
  propertyAddress: string;
  /**
   * The deal's Closing Date (`transactions.closing_deadline`), as stored:
   * `YYYY-MM-DD` from the dates form, though the column also admits an ISO
   * timestamp. `null` when the deal has none. Days-to-closing is worked out in
   * the renderer against the LOCAL day, not here.
   */
  closingDeadline: string | null;
  /** Required items ticked on this deal, summed across EVERY checklist on it. */
  dealRequiredDone: number;
  /** Required items on this deal, summed across EVERY checklist on it. */
  dealRequiredTotal: number;
}

/** What one read of the Todo list returns. */
export interface OpenRequiredChecklistItems {
  /** How many such items exist in all — the "N required" header. Not capped. */
  totalCount: number;
  /** The first of them, in display order, at most the requested limit. */
  items: OpenRequiredChecklistItem[];
}

/** What `checklists:list-open-required` answers. */
export type ListOpenRequiredChecklistItemsResult =
  | { success: true; result: OpenRequiredChecklistItems }
  | { success: false; error: string };

/**
 * One group in the Todo panel (BACKLOG-3965 SR plan review, change 3).
 *
 * The panel renders an ORDERED LIST of these. 3965 ships one group (required
 * checklist items); the auto-detect lane adds a "Suggested transactions" group
 * at the front with no layout change. A group shows either rows or a status
 * line ("Looking…", "Up to date"). A group with no rows and no status line
 * renders nothing at all — no orphan header (`visibleTodoGroups`).
 */
export interface TodoGroup<Row = OpenRequiredChecklistItem> {
  /** Stable key, e.g. "required-checklist-items". */
  id: string;
  /** Group header text. */
  header: string;
  /** The count shown beside the header — may exceed `rows.length`. */
  count: number;
  rows: readonly Row[];
  /** A line shown in place of rows, or null. */
  status: string | null;
}
