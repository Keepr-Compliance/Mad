/**
 * Date range formatting utilities.
 * Extracted from TransactionMessagesTab, ConversationViewModal, AttachEmailsModal, EmailThreadCard.
 * TASK-2029: Renderer-side utility deduplication.
 */

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
