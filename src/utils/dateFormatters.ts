import logger from './logger';
/**
 * Date formatting utilities for the frontend
 */

/**
 * Parse a date value with Windows timezone fix.
 * On Windows, YYYY-MM-DD strings are parsed as local time to avoid off-by-one errors.
 *
 * Background: JavaScript's `new Date("2025-01-08")` parses as UTC midnight.
 * In US timezones (UTC-5 to UTC-8), this displays as January 7th.
 * This function fixes that by parsing date-only strings as local time on Windows.
 *
 * @param dateValue - Date, string, null, or undefined
 * @param logContext - Optional context string for warning messages
 * @returns Parsed Date or null if invalid/missing
 */
export function parseDateSafe(
  dateValue: Date | string | null | undefined,
  logContext?: string
): Date | null {
  if (!dateValue) return null;

  if (dateValue instanceof Date) {
    return isNaN(dateValue.getTime()) ? null : dateValue;
  }

  // For date-only strings (YYYY-MM-DD) on Windows, parse as local time
  // Only apply on Windows to avoid breaking Mac which was working correctly
  const isWindows = typeof navigator !== 'undefined' && navigator.userAgent.includes('Windows');
  if (isWindows) {
    const dateOnlyMatch = String(dateValue).match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (dateOnlyMatch) {
      const [, year, month, day] = dateOnlyMatch;
      const d = new Date(parseInt(year), parseInt(month) - 1, parseInt(day));
      return isNaN(d.getTime()) ? null : d;
    }
  }

  // For other formats or on Mac, use standard parsing
  const d = new Date(dateValue);
  if (isNaN(d.getTime())) {
    if (logContext) {
      logger.warn(`[${logContext}] Invalid date:`, dateValue);
    }
    return null;
  }
  return d;
}

/**
 * BACKLOG-2632 — the one parser for timestamps that came out of the local SQLite DB.
 *
 * SQLite's `CURRENT_TIMESTAMP` / `datetime('now')` write UTC with NO zone marker:
 *
 *     2026-08-10 01:00:00        <- naive; happens to be UTC
 *     2026-08-10T21:56:27.989Z   <- what our `toISOString()` writers store
 *
 * `new Date("2026-08-10 01:00:00")` parses the first shape as **local** time.
 * In Costa Rica (UTC-6, no DST) that is 6h (21,600,000 ms) too late, so every
 * event between 18:00 and 23:59 local renders with TOMORROW's date. Adding a
 * `T` changes nothing; only a zone marker does.
 *
 * This parser tolerates BOTH shapes, which is what makes it safe to apply to
 * columns that already hold naive rows: the naive shape is re-read as UTC, and
 * anything already carrying `Z` / `+hh:mm` is handed to `new Date` untouched.
 * Date-only `YYYY-MM-DD` is also left alone (JS already reads it as UTC) so
 * `parseDateSafe`'s Windows behaviour is unaffected.
 *
 * Use this — not a bare `new Date(...)` — for any value that came from SQLite.
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

  // Anchored, so ANY trailing zone designator (`Z`, `+00:00`, `-06:00`) fails to
  // match and falls through to standard parsing. Only a genuinely zone-less
  // date+time is reinterpreted as UTC.
  const naive =
    /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?(?:\.(\d{1,6}))?$/.exec(raw);

  const normalized = naive
    ? `${naive[1]}-${naive[2]}-${naive[3]}T${naive[4]}:${naive[5]}:${naive[6] ?? "00"}.${(naive[7] ?? "").padEnd(3, "0").slice(0, 3)}Z`
    : raw;

  const d = new Date(normalized);
  return isNaN(d.getTime()) ? null : d;
}

/**
 * BACKLOG-2632 — display helper over {@link parseDbTimestamp}.
 *
 * Returns null (never the string "Invalid Date") when the value is missing or
 * unparseable, so callers can choose their own empty rendering.
 *
 * @param value - raw DB column value
 * @param options - Intl options; defaults to the app's "Aug 9, 2026" shape
 * @param locales - pass an explicit locale in tests; production uses the OS locale
 */
export function formatDbDate(
  value: Date | string | null | undefined,
  options: Intl.DateTimeFormatOptions = { month: "short", day: "numeric", year: "numeric" },
  locales?: string | string[],
): string | null {
  const parsed = parseDbTimestamp(value);
  return parsed ? parsed.toLocaleDateString(locales, options) : null;
}

/**
 * Format MAC timestamp for display as relative or absolute date
 * @param timestamp - MAC timestamp (nanoseconds since 2001-01-01)
 * @returns Formatted date string
 */
export function formatMessageDate(timestamp: number | Date | string): string {
  if (!timestamp) return "No messages";

  // Convert Mac timestamp to readable date
  const macEpoch = new Date("2001-01-01T00:00:00Z").getTime();
  const timestampNum = typeof timestamp === "number" ? timestamp : 0;
  const date = new Date(macEpoch + timestampNum / 1000000);

  // Compare calendar days, not just time differences
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const messageDay = new Date(
    date.getFullYear(),
    date.getMonth(),
    date.getDate(),
  );

  const diffTime = today.getTime() - messageDay.getTime();
  const diffDays = Math.floor(diffTime / (1000 * 60 * 60 * 24));

  if (diffDays === 0) return "Today";
  if (diffDays === 1) return "Yesterday";
  if (diffDays < 7) return `${diffDays} days ago`;

  return date.toLocaleDateString();
}
