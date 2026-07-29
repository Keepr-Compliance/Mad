/**
 * Date range formatting utilities.
 * Extracted from TransactionMessagesTab, ConversationViewModal, AttachEmailsModal, EmailThreadCard.
 * TASK-2029: Renderer-side utility deduplication.
 */
import { parseDateSafe } from "./dateFormatters";

/**
 * Format a date range for display in filter/toggle labels.
 * Handles partial dates (only start, only end, or both).
 * BACKLOG-393: Includes year in date format for clarity.
 *
 * @param startDate - Start of the range, or null if open-ended
 * @param endDate - End of the range, or null if ongoing
 * @returns Formatted string like "Jan 1, 2025 - Mar 15, 2025" or "Jan 1, 2025 - Ongoing"
 */
export function formatDateRangeLabel(startDate: Date | null, endDate: Date | null): string {
  const formatDate = (d: Date) =>
    d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });

  if (startDate && endDate) {
    return `${formatDate(startDate)} - ${formatDate(endDate)}`;
  } else if (startDate) {
    return `${formatDate(startDate)} - Ongoing`;
  } else if (endDate) {
    return `Through ${formatDate(endDate)}`;
  }
  return "";
}

/**
 * Format a date range for display on thread cards.
 * Both dates are required (thread always has a start and end).
 * Shows a single date when start and end are the same day.
 *
 * @param startDate - Start of the range
 * @param endDate - End of the range
 * @returns Formatted string like "Jan 1, 2025 - Mar 15, 2025" or "Jan 1, 2025"
 */
export function formatDateRange(startDate: Date, endDate: Date): string {
  const formatDate = (d: Date) =>
    d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });

  if (startDate.toDateString() === endDate.toDateString()) {
    return formatDate(startDate);
  }
  return `${formatDate(startDate)} - ${formatDate(endDate)}`;
}

/**
 * Parse a bare "YYYY-MM-DD" calendar-day string (as produced by
 * `<input type="date">`) into its [year, monthIndex, day] parts.
 * Returns null for empty/malformed input.
 */
function parseCalendarDay(dateStr: string): [number, number, number] | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr.trim());
  if (!match) return null;
  const year = Number(match[1]);
  const monthIndex = Number(match[2]) - 1; // JS months are 0-based
  const day = Number(match[3]);
  // Guard against impossible components (e.g. "2026-13-40").
  if (monthIndex < 0 || monthIndex > 11 || day < 1 || day > 31) return null;
  return [year, monthIndex, day];
}

/**
 * BACKLOG-2247: Convert a LOCAL calendar day ("YYYY-MM-DD", as returned by an
 * `<input type="date">`) into the UTC ISO instant for the **start** of that day
 * in the user's local timezone.
 *
 * Why this exists: `new Date("2026-07-25")` parses the bare date as *UTC*
 * midnight, not local midnight. For a user west of UTC that shifts the start
 * boundary later by their offset, silently excluding early-morning emails.
 *
 * @param dateStr - Local calendar day, e.g. "2026-07-25"
 * @returns UTC ISO string (e.g. "2026-07-25T04:00:00.000Z") or undefined if empty/invalid
 */
export function startOfLocalDayISO(dateStr: string): string | undefined {
  const parts = parseCalendarDay(dateStr);
  if (!parts) return undefined;
  const [year, monthIndex, day] = parts;
  return new Date(year, monthIndex, day, 0, 0, 0, 0).toISOString();
}

/**
 * BACKLOG-2247: Convert a LOCAL calendar day ("YYYY-MM-DD") into the UTC ISO
 * instant for the **last millisecond** of that day in the user's local timezone.
 *
 * Why this exists: the Attach Emails date filter is an *inclusive* range —
 * selecting an end date of 7/25 must include emails that occurred at any clock
 * time on 7/25. `new Date("2026-07-25")` yields UTC midnight (the *start* of the
 * day), so a downstream `sent_at <= <end>` comparison drops the entire end day.
 * Returning end-of-day keeps the existing inclusive (`<=`) comparison correct.
 *
 * @param dateStr - Local calendar day, e.g. "2026-07-25"
 * @returns UTC ISO string (e.g. "2026-07-26T03:59:59.999Z") or undefined if empty/invalid
 */
export function endOfLocalDayISO(dateStr: string): string | undefined {
  const parts = parseCalendarDay(dateStr);
  if (!parts) return undefined;
  const [year, monthIndex, day] = parts;
  return new Date(year, monthIndex, day, 23, 59, 59, 999).toISOString();
}

/**
 * BACKLOG-2277: Interpret an audit-period boundary as a LOCAL calendar day and
 * return a Date at LOCAL midnight of that day — suitable for *display* (e.g. via
 * formatDateRangeLabel), so the shown date matches exactly what the user set.
 *
 * Why this exists: `new Date("2026-01-01")` parses the bare date as *UTC*
 * midnight. Rendering that instant with toLocaleDateString() in a negative-offset
 * timezone (e.g. US) shifts the shown day back by one — a "Jan 1" audit start
 * displays as "Dec 31". Auditors pick a calendar day, not an instant, so the
 * displayed range must reflect the exact day chosen regardless of timezone. This
 * mirrors the local-day interpretation the BACKLOG-2247 email-range fix uses.
 *
 * Accepts a bare "YYYY-MM-DD", an ISO string carrying a time component
 * ("2026-01-01T00:00:00.000Z" — the calendar-day portion is used), a Date
 * (passed through), or null/undefined.
 *
 * @param value - Audit boundary value from the transaction record.
 * @returns Date at LOCAL midnight of the calendar day, or null if empty/invalid.
 */
export function parseLocalCalendarDay(
  value: Date | string | null | undefined
): Date | null {
  if (!value) return null;
  if (value instanceof Date) {
    return isNaN(value.getTime()) ? null : value;
  }
  // Use only the calendar-day portion so "2026-01-01" and
  // "2026-01-01T00:00:00.000Z" both resolve to the same LOCAL day.
  const dayPart = String(value).split("T")[0];
  const parts = parseCalendarDay(dayPart);
  if (parts) {
    const [year, monthIndex, day] = parts;
    return new Date(year, monthIndex, day, 0, 0, 0, 0); // LOCAL midnight
  }
  // Fallback: let Date parse any other already-instant format.
  const d = new Date(value);
  return isNaN(d.getTime()) ? null : d;
}

/**
 * BACKLOG-2277 / BACKLOG-2295: SINGLE source of truth for classifying a message
 * timestamp against the audit period. `startDate`/`endDate` are the LOCAL
 * start-of-day Dates produced by `parseLocalCalendarDay` (so a message early on
 * the first audit day is INCLUDED, and the whole final audit day is inclusive
 * via local end-of-day). The message timestamp itself is parsed with
 * `parseDateSafe` for Windows-safe handling.
 *
 * Used by both the Texts tab (to CROP its list) and the ConversationViewModal
 * (to CLASSIFY each bubble in-range vs out-of-range for exclusion shading —
 * BACKLOG-2295 — not to hide it when the "show before/after" toggle is ON), so
 * the two surfaces can never disagree on the boundary.
 *
 * @param timestamp - Message sent_at/received_at (ISO or local "no-Z" string).
 * @param startDate - Local start-of-day of the audit start, or null.
 * @param endDate - Local start-of-day of the audit end, or null.
 * @returns true when the timestamp falls within the (inclusive) audit period.
 */
export function isTimestampInAuditPeriod(
  timestamp: string | null | undefined,
  startDate: Date | null,
  endDate: Date | null
): boolean {
  const msgDate = parseDateSafe(timestamp) || new Date(0);

  // Start boundary: local start-of-day of the first audit day.
  if (startDate && msgDate < startDate) {
    return false;
  }

  // End boundary: last millisecond of the local audit end day (inclusive).
  if (endDate) {
    const endOfDay = new Date(endDate);
    endOfDay.setHours(23, 59, 59, 999);
    if (msgDate > endOfDay) {
      return false;
    }
  }

  return true;
}
