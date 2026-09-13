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
 * Every existing row in those columns carries that shape, and six queries sort
 * those columns as **strings** (`ORDER BY ignored_at DESC`,
 * `ORDER BY c.removed_at DESC`, `ORDER BY tc.removed_at DESC`, and
 * `emailLinkingHandlers.ts:634/693`).
 *
 * A space (0x20) sorts before a `T` (0x54). Measured against real SQLite during
 * SR review: with both shapes present, `ORDER BY ... DESC` puts EVERY ISO row
 * above EVERY naive row regardless of time — an ISO 01:00 outranks a naive
 * 23:00. Writing `toISOString()` into these columns does not reorder within a
 * day, it INVERTS the column. Backfilling the old rows is not an option either
 * — a naive value written at an unknown clock offset is not safely convertible.
 *
 * So the format stays naive-UTC and the RENDERERS learned to read it
 * (`parseDbTimestamp` in `src/utils/dateFormatters.ts`). This helper exists for
 * the one case where a write site must persist the value **explicitly** rather
 * than leaning on the column default — see `addIgnoredCommunication`, which
 * previously persisted the naive default while handing its caller a different
 * (ISO) string, so the displayed day changed on refetch.
 *
 * NOTE: `src/` and `electron/` cannot import from each other, so the read-side
 * parser and this write-side formatter are deliberately separate modules. The
 * main process needs the read side too (BACKLOG-3297), so this file carries a
 * MIRROR of the renderer's parser below, held identical by
 * `electron/utils/__tests__/dbTimestamp.parity-3297.test.ts`.
 *
 * @param now - injectable clock for tests
 * @returns e.g. `"2026-08-10 22:09:57"` — byte-identical to `CURRENT_TIMESTAMP`
 */
export function dbTimestampNow(now: Date = new Date()): string {
  // toISOString(): "2026-08-10T22:09:57.989Z" -> "2026-08-10 22:09:57"
  return now.toISOString().replace("T", " ").replace(/\.\d{3}Z$/, "");
}

/**
 * BACKLOG-3297 — MIRROR of `normalizeDbTimestamp` in `src/utils/dateFormatters.ts`
 * (BACKLOG-2632). Keep the two byte-for-byte equivalent in behaviour; the parity
 * test runs both over the same corpus.
 *
 * `new Date("2026-09-13 18:15:21")` reads SQLite's zone-less UTC value as LOCAL
 * time. This adds a `Z` to a zone-less date+time and leaves everything else
 * (values already carrying `Z` / `+hh:mm`, date-only values, garbage) untouched.
 *
 * Must stay import-free: the zone test loads this file in a child process
 * started under a different `TZ`.
 *
 * @param raw - a trimmed, non-empty raw column value
 * @returns the same string, with a `Z` marker added if and only if it had none
 */
export function normalizeDbTimestamp(raw: string): string {
  const naive =
    /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?(?:\.(\d{1,6}))?$/.exec(raw);
  if (!naive) return raw;

  const millis = (naive[7] ?? "").padEnd(3, "0").slice(0, 3);
  return `${naive[1]}-${naive[2]}-${naive[3]}T${naive[4]}:${naive[5]}:${naive[6] ?? "00"}.${millis}Z`;
}

/**
 * BACKLOG-3297 — MIRROR of `parseDbTimestamp` in `src/utils/dateFormatters.ts`.
 * Use this, not a bare `new Date(...)`, for any value that came from SQLite.
 *
 * @param value - raw column value, a Date, or null/undefined
 * @returns a Date, or null when the value is missing or unparseable
 */
export function parseDbTimestamp(value: Date | string | null | undefined): Date | null {
  if (!value) return null;

  if (value instanceof Date) {
    return isNaN(value.getTime()) ? null : value;
  }

  const raw = String(value).trim();
  if (!raw) return null;

  const d = new Date(normalizeDbTimestamp(raw));
  return isNaN(d.getTime()) ? null : d;
}
