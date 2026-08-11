/**
 * BACKLOG-2632 — produce the exact string SQLite's `CURRENT_TIMESTAMP` produces.
 *
 * WHY THIS EXISTS, AND WHY IT IS NOT `toISOString()`
 *
 * Several columns are written by SQLite defaults (`DEFAULT CURRENT_TIMESTAMP`,
 * `SET x = datetime('now')`), which store UTC with no zone marker:
 *
 *     2026-08-10 22:09:57
 *
 * Every existing row in those columns carries that shape, and several queries
 * sort those columns as **strings** (`ORDER BY ignored_at DESC`,
 * `ORDER BY c.removed_at DESC`, `ORDER BY tc.removed_at DESC`). A space (0x20)
 * sorts before a `T` (0x54), so writing `toISOString()` into a column that
 * already holds naive rows silently reorders same-day rows. Backfilling the old
 * rows is not an option either — a naive value written at an unknown clock
 * offset is not safely convertible.
 *
 * So the format stays naive-UTC and the RENDERERS learned to read it
 * (`parseDbTimestamp` in `src/utils/dateFormatters.ts`). This helper exists for
 * the one case where a write site must persist the value **explicitly** rather
 * than leaning on the column default — see `addIgnoredCommunication`, which
 * previously persisted the naive default while handing its caller a different
 * (ISO) string, so the displayed day changed on refetch.
 *
 * NOTE: `src/` and `electron/` cannot import from each other, so the read-side
 * parser and this write-side formatter are deliberately separate modules.
 *
 * @param now - injectable clock for tests
 * @returns e.g. `"2026-08-10 22:09:57"` — byte-identical to `CURRENT_TIMESTAMP`
 */
export function dbTimestampNow(now: Date = new Date()): string {
  // toISOString(): "2026-08-10T22:09:57.989Z" -> "2026-08-10 22:09:57"
  return now.toISOString().replace("T", " ").replace(/\.\d{3}Z$/, "");
}
