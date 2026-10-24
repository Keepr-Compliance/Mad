/**
 * Read-time sprint attribution for `pm_token_metrics` rows (BACKLOG-3778).
 *
 * The sprint "Token Breakdown" undercounted: `getSprintMetrics` selected rows
 * by the `sprint_id` STORED on the row, so a run recorded before its backlog
 * item was added to the sprint -- the row carries `backlog_item_id` but no
 * `sprint_id` -- never showed up in that sprint's totals.
 *
 * The fix attributes each row to a sprint at READ time instead of trusting
 * the value frozen on the row when it was written:
 *
 *   effective sprint = the row's backlog item's CURRENT sprint_id,
 *                       falling back to the row's own stored sprint_id
 *                       when there is no item, or the item carries no sprint.
 *
 * This is the same COALESCE idiom `pm_record_task_tokens` uses for item-level
 * rollup (`COALESCE(m.backlog_item_id, t.backlog_item_id, bi.id)`), applied
 * one level up, at the sprint.
 */

export interface AttributableMetricRow {
  id: string;
  backlog_item_id: string | null;
  sprint_id: string | null;
  /**
   * The row's backlog item's CURRENT `sprint_id`, from a join/lookup against
   * `pm_backlog_items` done by the caller. `null`/`undefined` covers both
   * "no backlog item" and "item exists but currently carries no sprint" --
   * both fall back to the row's own stored `sprint_id`.
   */
  item_sprint_id?: string | null;
}

/** The sprint this row belongs to, resolved at READ time. */
export function resolveEffectiveSprintId(row: AttributableMetricRow): string | null {
  return row.item_sprint_id ?? row.sprint_id ?? null;
}

/**
 * Filter rows to the ones attributed to `sprintId`, deduplicated by `id`.
 * Safe to call with overlapping candidate sets -- e.g. rows fetched by two
 * different queries that can both return the same row -- a row counts once.
 */
export function attributeRowsToSprint<T extends AttributableMetricRow>(
  rows: T[],
  sprintId: string
): T[] {
  const seen = new Set<string>();
  const result: T[] = [];
  for (const row of rows) {
    if (seen.has(row.id)) continue;
    if (resolveEffectiveSprintId(row) !== sprintId) continue;
    seen.add(row.id);
    result.push(row);
  }
  return result;
}
