/**
 * BACKLOG-3925 — WHY an email is waiting in Needs Review.
 *
 * A small enumerated value, never a boolean. Adding a kind is one more member here
 * plus one more row in the renderer's label table (`reviewMatchReasons.ts`).
 *
 *   "folder"   (BACKLOG-3926) the email sits in an Outlook folder or Gmail label whose
 *              name names the deal's street number AND street name (same address-only
 *              rule as "address"), whoever it is from.
 *   "address"  the email names the deal's street number AND street name, and no
 *              participant is a contact on the deal (local-cache discovery).
 *   "contact"  the email is from/to a contact on the deal but does not name the
 *              address (BACKLOG-2338's route). Also every row with no stored reason:
 *              everything queued before BACKLOG-3925, every legacy address_missing
 *              link, every text thread.
 *
 * Type-only for the renderer; the precedence list below is main-process data.
 */
export type ReviewMatchReason = "folder" | "address" | "contact";

/** What a review row with no stored reason is. */
export const DEFAULT_REVIEW_MATCH_REASON: ReviewMatchReason = "contact";

/**
 * Founder ruling 2026-10-12: when one email qualifies for more than one kind, the
 * EARLIER entry wins: folder > address > contact. This list is the ONE place the order
 * lives (the renderer holds a pinned mirror, reviewMatchReasons.ts).
 */
export const REVIEW_MATCH_REASON_PRECEDENCE: readonly ReviewMatchReason[] = ["folder", "address", "contact"];

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
