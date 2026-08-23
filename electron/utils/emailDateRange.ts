/**
 * TASK-2068: Canonical date-range calculation for email/communication fetching.
 *
 * Replaces 3 separate implementations:
 * 1. computeEmailFetchSinceDate() in emailSyncHandlers.ts
 * 2. getTransactionDateRange() + getDefaultDateRange() in autoLinkService.ts
 * 3. DEFAULT_LOOKBACK_MONTHS constant in autoLinkService.ts
 *
 * Unifies the logic so all callers use the same date-range computation.
 *
 * BACKLOG-2788: the END of the range is no longer computed here. The closing
 * day's end belongs to `auditWindowEnd()` (electron/services/exportPlan.ts) —
 * one helper owns "where does the user's day end", and this file's 30-day
 * buffer advances from it. See that function for the local-midnight contract.
 */
import { auditWindowEnd } from "../services/exportPlan";

/** Buffer days added after closed_at date to catch post-closing communications */
export const DEFAULT_BUFFER_DAYS = 30;

/** Fallback lookback period when no transaction dates are available */
const FALLBACK_YEARS = 2;

/**
 * Compute the date range for fetching emails/communications related to a transaction.
 *
 * Start date priority:
 *   1. started_at (when the transaction formally started)
 *   2. created_at (when it was created in the system)
 *   3. Fallback: 2 years ago
 *
 * End date:
 *   - the END of the closing day in the user's LOCAL timezone (BACKLOG-2788's
 *     `auditWindowEnd`) + a 30-day buffer, to catch post-closing communications
 *   - Or today if closed_at is not set
 *
 * The end therefore sits ~24h later than it did before BACKLOG-2788 (it used to
 * be UTC MIDNIGHT of closing-day+30, i.e. the START of that day). The direction
 * is deliberate and safe for every consumer: the email fetch and the auto-link
 * candidate window get the whole buffered final day, and `deriveAuditSpans`
 * protects the whole buffered final day from the import cap.
 *
 * @param params - Transaction date fields (all optional)
 * @param now - The clock for the two "today" fallbacks. Defaults to the real
 *   one; pass an explicit value when TWO ranges are being compared, so an
 *   open-ended deal does not appear to grow by a millisecond between the calls
 *   (BACKLOG-2791 — that is exactly what made every save look like an audit
 *   window extension).
 * @returns Object with start and end Date
 */
export function computeTransactionDateRange(
  params: {
    started_at?: Date | string | null;
    created_at?: Date | string | null;
    closed_at?: Date | string | null;
  },
  now: Date = new Date(),
): { start: Date; end: Date } {
  // --- Start date ---
  let start: Date | null = null;

  // Try started_at first (most meaningful for audit period)
  if (params.started_at) {
    const d = new Date(params.started_at);
    if (!isNaN(d.getTime())) start = d;
  }

  // Fall back to created_at
  if (!start && params.created_at) {
    const d = new Date(params.created_at);
    if (!isNaN(d.getTime())) start = d;
  }

  // Last resort: 2 years ago
  if (!start) {
    start = new Date(now.getTime());
    start.setFullYear(start.getFullYear() - FALLBACK_YEARS);
  }

  // --- End date ---
  let end: Date = new Date(now.getTime()); // default: today

  if (params.closed_at) {
    // BACKLOG-2788: the buffer runs from the end of the closing DAY as the user
    // experiences it — local midnight — not from UTC midnight of that date.
    // `auditWindowEnd()` is the single place that decides where a closing day
    // ends; the buffer then advances 30 LOCAL days from that instant, so the
    // last buffered day also ends at local midnight and both DST-transition
    // days land exact (setDate preserves the local wall clock).
    const bufferedEnd = auditWindowEnd(params.closed_at);
    if (bufferedEnd && !isNaN(bufferedEnd.getTime())) {
      bufferedEnd.setDate(bufferedEnd.getDate() + DEFAULT_BUFFER_DAYS);
      end = bufferedEnd;
    }
  }

  return { start, end };
}

/** The stored audit dates `computeTransactionDateRange` reads. */
export interface AuditWindowDates {
  started_at?: Date | string | null;
  created_at?: Date | string | null;
  closed_at?: Date | string | null;
}

/**
 * BACKLOG-2791: did this date edit EXTEND the deal's audit window?
 *
 * Founder, 2026-08-23: the review sync and its popup must also run when the
 * user changes the audit dates so the window covers more — "extending the
 * window brings new communications into scope; today nothing happens until the
 * next open".
 *
 * TRUE SUPERSET, deliberately. The new window must CONTAIN the old one on both
 * ends and be strictly wider on at least one. A mixed edit — one end reaching
 * out while the other pulls in — is not an extension here, because it contains a
 * NARROWING, and the Communication Lifecycle Contract parks narrowing as an open
 * founder decision ("what leaves the deal, and how it's shown — undecided,
 * deliberately not built"). Discovering over the half that grew while the half
 * that shrank has no agreed semantics would ship the decision by accident.
 *
 * Both windows are measured against ONE clock: `computeTransactionDateRange`
 * falls back to "today" when there is no close date, so two back-to-back calls
 * differ by the time between them and every save on an open-ended deal would
 * report an extension.
 */
export function isAuditWindowExtended(
  before: AuditWindowDates,
  after: AuditWindowDates,
  now: Date = new Date(),
): boolean {
  const a = computeTransactionDateRange(before, now);
  const b = computeTransactionDateRange(after, now);

  const contains =
    b.start.getTime() <= a.start.getTime() && b.end.getTime() >= a.end.getTime();
  const strictlyWider =
    b.start.getTime() < a.start.getTime() || b.end.getTime() > a.end.getTime();

  return contains && strictlyWider;
}

/**
 * BACKLOG-2276: Compute the earliest audit-period start across a set of
 * transactions, using the SAME source of truth the email fetch uses
 * (`computeTransactionDateRange`, i.e. started_at → created_at → 2-year fallback).
 *
 * The macOS Messages import is a bulk import (not per-transaction), so to avoid
 * silently omitting texts that ANY transaction's audit period needs, the import
 * lower bound must reach back to the earliest such start.
 *
 * @param transactions - Transaction date fields (started_at/created_at/closed_at)
 * @returns The earliest computed start Date, or null when the list is empty
 */
export function computeEarliestAuditStart(
  transactions: Array<{
    started_at?: Date | string | null;
    created_at?: Date | string | null;
    closed_at?: Date | string | null;
  }>
): Date | null {
  let earliest: Date | null = null;
  for (const txn of transactions) {
    const { start } = computeTransactionDateRange(txn);
    if (!earliest || start.getTime() < earliest.getTime()) {
      earliest = start;
    }
  }
  return earliest;
}

/**
 * Backwards-compatible wrapper that returns only the start date.
 *
 * This is a thin re-export so existing callers of the old
 * `computeEmailFetchSinceDate()` in emailSyncHandlers.ts continue to work
 * without changing their call sites (they only need the start date).
 *
 * @deprecated Prefer computeTransactionDateRange() for new code.
 */
export function computeEmailFetchSinceDate(transactionDetails: {
  started_at?: Date | string;
  created_at?: Date | string;
}): Date {
  return computeTransactionDateRange(transactionDetails).start;
}
