/**
 * Is this deal locked against automatic additions? — RENDERER MIRROR.
 *
 * ===========================================================================
 * THIS IS A MIRROR. THE CANONICAL COPY IS `dealLockReason` /
 * `DEAL_LOCK_REASON_BY_STATUS` IN `electron/services/transactionEligibility.ts`.
 * ===========================================================================
 *
 * BACKLOG-3910 (slice b). The main process asks this to decide whether any
 * automatic path may add a link or a Needs Review item to a deal; the deal
 * screen asks it to decide whether to show the locked notice and disable Sync.
 * Nothing under `electron/` may import from `src/` (`rootDir`), and the
 * renderer cannot value-import from `electron/`, so the rule is written twice.
 * `src/utils/__tests__/dealLock.parity.test.ts` imports both and fails when
 * they disagree, or when the schema gains a status neither names.
 *
 *   "submitted"  with the broker (submitted / under_review / resubmitted).
 *                Unlocks when the broker asks for changes or rejects it.
 *   "sealed"     approved. BACKLOG-2229 adds closed (Complete) deals.
 */

export type DealLockReason = "submitted" | "sealed";

export type SubmissionStatusValue =
  | "not_submitted"
  | "submitted"
  | "under_review"
  | "needs_changes"
  | "resubmitted"
  | "approved"
  | "rejected";

export const DEAL_LOCK_REASON_BY_STATUS: Readonly<
  Record<SubmissionStatusValue, DealLockReason | null>
> = {
  not_submitted: null,
  submitted: "submitted",
  under_review: "submitted",
  resubmitted: "submitted",
  needs_changes: null,
  rejected: null,
  approved: "sealed",
};

export function dealLockReason(
  submissionStatus: string | null | undefined,
): DealLockReason | null {
  if (!submissionStatus) return null;
  if (!Object.prototype.hasOwnProperty.call(DEAL_LOCK_REASON_BY_STATUS, submissionStatus)) {
    return null;
  }
  return DEAL_LOCK_REASON_BY_STATUS[submissionStatus as SubmissionStatusValue];
}

/**
 * What the deal screen says, per reason. Every clause is checked against the
 * code: no automatic path adds to a locked deal (main-process gates), manual
 * attach is not gated, and "submitted" ends when the broker returns the deal
 * (needs_changes / rejected map to open above).
 *
 * The "sealed" sentence names approval because approval is its only producer
 * in 2.41. BACKLOG-2229 must rewrite it when Complete starts sealing deals.
 */
export const DEAL_LOCK_NOTICE_COPY: Readonly<Record<DealLockReason, string>> = {
  submitted:
    "This deal is with your broker for review. Keepr won't add emails or texts to it automatically until it's returned to you. You can still attach them yourself.",
  sealed:
    "Your broker approved this deal, so it is sealed. Keepr no longer adds emails or texts to it automatically. You can still attach them yourself.",
};

/** Tooltip on the deal's disabled Sync buttons. */
export const DEAL_LOCK_SYNC_TOOLTIP: Readonly<Record<DealLockReason, string>> = {
  submitted: "Sync is off while your broker reviews this deal.",
  sealed: "Sync is off because this deal is sealed.",
};
