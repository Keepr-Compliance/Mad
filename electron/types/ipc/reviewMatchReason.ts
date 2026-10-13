/**
 * BACKLOG-3925 — WHY an email is waiting in Needs Review.
 *
 * A small enumerated value, never a boolean: a third kind ("folder", BACKLOG-3926 —
 * an Outlook folder or Gmail label named after the deal address) is planned, and it
 * must be one more member here plus one more row in the renderer's label table
 * (`reviewMatchReasons.ts`), not a restructure.
 *
 *   "address"  the email names the deal's street number AND street name, and no
 *              participant is a contact on the deal (local-cache discovery).
 *   "contact"  the email is from/to a contact on the deal but does not name the
 *              address (BACKLOG-2338's route). Also every row with no stored reason:
 *              everything queued before BACKLOG-3925, every legacy address_missing
 *              link, every text thread.
 *
 * Type-only for the renderer; the precedence list below is main-process data.
 */
export type ReviewMatchReason = "address" | "contact";

/** What a review row with no stored reason is. */
export const DEFAULT_REVIEW_MATCH_REASON: ReviewMatchReason = "contact";

/**
 * Founder ruling 2026-10-12: when one email qualifies for more than one kind, the
 * EARLIER entry wins. Full order is folder > address > contact; "folder" joins at the
 * front when BACKLOG-3926 adds it. This list is the ONE place the order lives.
 */
export const REVIEW_MATCH_REASON_PRECEDENCE: readonly ReviewMatchReason[] = ["address", "contact"];

/** The reason that wins between an existing one (if any) and a new one. */
export function strongerReviewMatchReason(
  existing: ReviewMatchReason | null | undefined,
  incoming: ReviewMatchReason,
): ReviewMatchReason {
  if (!existing) return incoming;
  const rank = (r: ReviewMatchReason): number => {
    const i = REVIEW_MATCH_REASON_PRECEDENCE.indexOf(r);
    return i < 0 ? Number.MAX_SAFE_INTEGER : i;
  };
  return rank(incoming) < rank(existing) ? incoming : existing;
}

/** Narrow a stored column value; anything unknown reads as the default. */
export function toReviewMatchReason(value: string | null | undefined): ReviewMatchReason {
  return (REVIEW_MATCH_REASON_PRECEDENCE as readonly string[]).includes(value ?? "")
    ? (value as ReviewMatchReason)
    : DEFAULT_REVIEW_MATCH_REASON;
}
