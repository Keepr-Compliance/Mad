/**
 * Dashboard panel formatting — BACKLOG-3965 PR-4b.
 *
 * Pure helpers, no ambient time zone in the string steps, so each one can be
 * tested on any runner (BACKLOG-2632: jest's jsdom ignores process.env.TZ).
 */
import { parseDbTimestamp } from "../../../utils/dateFormatters";

/** A `YYYY-MM-DD` day as [year, month, day], or null. */
function dayParts(value: string): [number, number, number] | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

/** The LOCAL calendar day of `now` as `YYYY-MM-DD`. */
export function localDay(now: Date): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/**
 * Whole days from `today` to the deal's Closing Date, both `YYYY-MM-DD`.
 *
 * The closing date is compared by its calendar components, never through
 * `new Date("YYYY-MM-DD")` (that is UTC midnight, which is the previous day
 * west of Greenwich). A stored ISO timestamp is cut to its first 10 characters,
 * the same rule PR-3's ORDER BY uses (`substr(closing_deadline, 1, 10)`).
 * Null when the deal has no closing date or it does not read as a day.
 */
export function daysUntilClosing(closingDeadline: string | null, today: string): number | null {
  if (!closingDeadline) return null;
  const target = dayParts(closingDeadline.trim().slice(0, 10));
  const from = dayParts(today);
  if (!target || !from) return null;
  const toUtc = ([y, m, d]: [number, number, number]) => Date.UTC(y, m - 1, d);
  return Math.round((toUtc(target) - toUtc(from)) / 86_400_000);
}

export type ClosingBadgeTone = "danger" | "warning";

export interface ClosingBadge {
  label: string;
  tone: ClosingBadgeTone;
}

/** Red at 14 days or fewer (and today, and overdue), amber above. */
export const CLOSING_SOON_DAYS = 14;

/** The closing-date badge for a row, or null when the deal has no date. */
export function closingBadge(days: number | null): ClosingBadge | null {
  if (days === null) return null;
  if (days < 0) return { label: "Overdue", tone: "danger" };
  if (days === 0) return { label: "Today", tone: "danger" };
  return { label: `${days} d`, tone: days <= CLOSING_SOON_DAYS ? "danger" : "warning" };
}

/**
 * When a deal was opened, as an instant. `transaction_opens.opened_at` is
 * written as ISO 8601 UTC (`new Date().toISOString()`,
 * electron/handlers/transactionOpenHandlers.ts); a zone-less value is read as
 * UTC too, never as local time (parseDbTimestamp).
 */
export function parseOpenedAt(openedAt: string): Date | null {
  return parseDbTimestamp(openedAt);
}

/** "Just now", "5m ago", "2h ago", "Yesterday", "3d ago", then the date. */
export function openedAgo(openedAt: string, now: Date): string {
  const at = parseOpenedAt(openedAt);
  if (!at) return "";
  const minutes = Math.floor((now.getTime() - at.getTime()) / 60_000);
  if (minutes < 1) return "Just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days === 1) return "Yesterday";
  if (days < 7) return `${days}d ago`;
  return at.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/** "3 of 5" for a deal with required items; "No required items" otherwise. */
export function requiredProgressText(done: number, total: number): string {
  if (!(total > 0)) return "No required items";
  return `${done} of ${total}`;
}
