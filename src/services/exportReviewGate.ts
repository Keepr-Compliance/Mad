/**
 * Export Review Gate (BACKLOG-2866)
 *
 * THE ONE GATE that stands between a user and an exported audit package.
 *
 * Founder ruling, 2026-08-25:
 *   "should emails still awaiting review be in the exported audit package at
 *    all? no they never should — and in fact a user is forced to review them
 *    before the submit or export"
 *
 * And, on HOW:
 *   "we don't need to filter because the same mechanism that stops a user from
 *    completing a transaction is the same one that will block them from
 *    exporting. no reason to filter it."
 *
 * So this module does NOT filter anything. `electron/services/exportPlan.ts`
 * knows nothing about review state and must stay that way — a filter would
 * silently drop emails from a package and hand a broker an artifact quietly
 * missing things. A gate refuses, and names the deal that needs attention.
 * `exportReviewGate.noFilter-2866.test.ts` is the tripwire on that.
 *
 * WHY ONE MODULE AND NOT A CHECK PER ROUTE
 * ----------------------------------------
 * There are four live routes to an export (details Complete, the brokerage-only
 * header Export button, the submit modal's Export offer, and Bulk Export). Four
 * copies of one rule is how they drift; `reviewStateService.ts` carries the
 * founder's one-source rule for exactly this reason. Every route calls
 * `evaluateExportGate`, and the proof is a control that mutates THIS function
 * once and watches all four route suites go red.
 *
 * THE RULE, LIFTED VERBATIM FROM `useCompleteTransaction.requestComplete`
 * ----------------------------------------------------------------------
 * 1. Read the review state AT CLICK TIME, never from a render-stale prop. A
 *    prop-based gate opens the export modal for a queue that filled a moment
 *    ago, and no test that renders with a fixed prop would ever catch it.
 * 2. A THROW means "cannot confirm the queue is empty", which is NOT the same
 *    as "the queue is empty". Exporting on an unverified queue is the failure
 *    this gate exists to prevent, so an unreadable queue BLOCKS, carrying
 *    `UNREADABLE_REVIEW_COUNT` so the message does not claim a count it does
 *    not have.
 * 3. `count > 0` blocks. There is no bypass.
 */
import type { ReviewStateResult } from "../../electron/types/ipc/window-api-transactions";

/**
 * The count carried when the review queue could not be READ. Distinct from 0
 * (verified empty) on purpose — see rule 2 above.
 */
export const UNREADABLE_REVIEW_COUNT = -1;

export interface ExportGateTarget {
  transactionId: string;
  /**
   * Human label — the property address. Only the bulk route needs it: a refusal
   * for a deal the user is not looking at has to name the deal.
   */
  label?: string;
}

export interface BlockedExportTarget extends ExportGateTarget {
  /** Outstanding queue total, or `UNREADABLE_REVIEW_COUNT`. */
  count: number;
}

export type ExportGateDecision =
  | { allowed: true }
  | { allowed: false; blocked: BlockedExportTarget[] };

export type ReviewStateReader = (
  transactionId: string,
) => Promise<ReviewStateResult>;

/**
 * The default reader: `getReviewState`, the single source of truth
 * (`reviewStateService.ts`). Nothing here may derive review state any other way.
 */
const readReviewStateFromApi: ReviewStateReader = (transactionId) =>
  window.api.transactions.getReviewState(transactionId);

/**
 * Decide whether an export may proceed for every one of `targets`.
 *
 * ALL-OR-NOTHING BY DESIGN. One blocked deal blocks the whole set, and the
 * caller starts no export at all. The alternative — export the clean deals and
 * quietly exclude the rest — was rejected: it does not force the review the
 * founder's rule requires, it makes one click mean two different things
 * depending on the selection, and it reproduces the "artifact quietly missing
 * things" defect at batch level.
 *
 * This is deliberately NOT the BACKLOG-2075 paywall shape, which excludes locked
 * deals and exports the rest. A locked deal cannot be fixed in-app, so blocking
 * there would brick bulk export permanently; a review queue is fixable right
 * now, so blocking is a prompt to act rather than a dead end.
 *
 * @param read Overridable so the details screen can pass its BOUND
 *   `reviewQueue.refresh` — the same read that refreshes the badge, keeping the
 *   gate and the visible count on one path.
 */
export async function evaluateExportGate(
  targets: ExportGateTarget[],
  read: ReviewStateReader = readReviewStateFromApi,
): Promise<ExportGateDecision> {
  const blocked: BlockedExportTarget[] = [];

  for (const target of targets) {
    let state: ReviewStateResult;
    try {
      state = await read(target.transactionId);
    } catch {
      blocked.push({ ...target, count: UNREADABLE_REVIEW_COUNT });
      continue;
    }
    if (state.count > 0) {
      blocked.push({ ...target, count: state.count });
    }
  }

  return blocked.length > 0 ? { allowed: false, blocked } : { allowed: true };
}

// ===========================================================================
// COPY — ONE wording for one condition.
//
// These two strings are the P3 gate copy, moved here BYTE-IDENTICAL from
// `ReviewPromptDialog`, which now imports them. The bulk route builds its
// message from the same sentence rather than inventing a second one for the
// same condition, so the details screen and the transactions list can never
// tell the user two different things about the same queue.
//
// NOTE FOR THE FOUNDER (BACKLOG-2866): the sentence ends "...before completing
// the transaction". On the brokerage-only header Export button, export is a
// local-copy action rather than completion, so "completing" reads slightly off
// there. Changing it would mean a second wording, so it is left alone pending a
// copy ruling.
// ===========================================================================

/** P3 heading. `count < 0` is the unreadable-queue case. */
export function reviewBlockedTitle(count: number): string {
  return count < 0
    ? "Couldn't check Needs Review"
    : "Review needed before completing";
}

/** P3 body. `count < 0` is the unreadable-queue case. */
export function reviewBlockedBody(count: number): string {
  if (count < 0) {
    return "The transaction can't be completed until the review queue can be read. Open Needs Review to try again.";
  }
  const plural = count === 1 ? "communication" : "communications";
  return `You have ${count} ${plural} that need to be reviewed before completing the transaction.`;
}

/**
 * The bulk refusal: the P3 sentence, then the deals that caused it BY NAME.
 *
 * Naming them is the whole point. "Some transactions need review" sends the
 * user hunting through a selection of twenty; "123 Main St (3)" is one click of
 * work. Every blocked deal is listed — no truncation, because the omitted one
 * is exactly the one the user then cannot find.
 */
export function describeBlockedExport(blocked: BlockedExportTarget[]): string {
  const readableTotal = blocked
    .filter((b) => b.count >= 0)
    .reduce((sum, b) => sum + b.count, 0);

  // Every blocked deal unreadable → the queue could not be read at all, which
  // is a different failure from "there are N items", and says so.
  const lead =
    readableTotal > 0
      ? reviewBlockedBody(readableTotal)
      : reviewBlockedBody(UNREADABLE_REVIEW_COUNT);

  const names = blocked.map((b) => {
    const label = b.label ?? b.transactionId;
    return b.count < 0 ? `${label} (couldn't check)` : `${label} (${b.count})`;
  });

  return `${lead} Needs review: ${names.join(", ")}.`;
}
