/**
 * Why a submit is refused, in the words the user is shown — CANONICAL COPY.
 *
 * ===========================================================================
 * THIS IS THE CANONICAL COPY. THE RENDERER MIRROR IS THE `BLOCKED_STATUS_COPY`
 * MAP IN `src/components/transactionDetailsModule/components/modals/SubmitForReviewModal.tsx`.
 * ===========================================================================
 *
 * BACKLOG-2868. One question, asked in two places:
 *   - `submissionService.submitTransaction`, to decide whether to refuse and
 *     what to put in the thrown Error
 *   - `SubmitForReviewModal`, to decide what to put on screen BEFORE the user
 *     presses anything
 *
 * Those two answers were written separately and disagreed, which is the defect
 * this module exists to prevent recurring. BACKLOG-2853 disabled the modal's
 * action in all four of these statuses but wrote a lead paragraph for only one
 * of them, so a REJECTED deal was told its submission "is with your broker for
 * review" and that "if your broker asks for changes, you will be able to
 * resubmit it here". Both false in a terminal state. And because the same
 * change disabled the button, the accurate line below — which the user used to
 * reach by pressing it and reading the service's error — became unreachable.
 * A wrong explanation, and the right one taken away.
 *
 * THE STRINGS CANNOT SIMPLY BE IMPORTED BY BOTH. `tsconfig.electron.json` sets
 * `rootDir: "./electron"`, so nothing under `electron/` may import from `src/`;
 * and the renderer cannot VALUE-import from `electron/` because Vite parses it
 * as JavaScript. (`@keepr/shared` is not a way out either: its entry point is
 * unbuilt TypeScript and `electron-builder`'s `files` list excludes
 * `packages/**` — the same reason `electron/types/license.ts` is a hand
 * duplicate of `shared/types/license.ts`.) The repo's answer to this is a
 * mirror plus a parity test — see `contactSourceDefaults`.
 *
 * What keeps the two copies honest is not this comment.
 * `SubmitForReviewModal.blockedStatusCopy-2868.test.tsx` imports THIS module
 * and asserts that what the modal actually RENDERS at each status contains the
 * message below. Edit one without the other and that test goes red.
 *
 * ---------------------------------------------------------------------------
 * SCOPE — THIS MODULE HOLDS REFUSAL COPY AND NOTHING ELSE.
 * ---------------------------------------------------------------------------
 * It is not the `SubmissionStatus` union (that is `electron/types/models.ts`),
 * and it is not a statement about which statuses a deal may be IN — only about
 * which ones a fresh `submitTransaction` is refused in, and why. `needs_changes`
 * and `resubmitted` are deliberately absent; see `submissionService.ts` at the
 * check site for what each of them does instead.
 */

/**
 * The statuses `submitTransaction` refuses.
 *
 * `submitted` was added by BACKLOG-2853 and is the damage-stopper: without it
 * a deal awaiting the broker fell through to a delete whose own comment
 * advertises that it cascades to messages and attachments.
 *
 * `resubmitted` is NOT here. It is not an oversight and it is not a decision
 * that this list is the right place to take: a row only ever reaches
 * `resubmitted` at version >= 2 (`submissionService.ts` — `finalStatus` is
 * `resubmitted` only when `options.version` is set, and `resubmitTransaction`
 * always sets it to `current + 1`), by which point two rows share
 * `(organization_id, local_transaction_id)`, the `.maybeSingle()` lookup ahead
 * of this check returns PGRST116, and the check is never reached at all.
 * Adding the word here would change nothing until BACKLOG-2867 fixes that
 * lookup. Proven by execution in `submissionResubmitGuard-2853.test.ts`.
 */
export const BLOCKED_SUBMISSION_STATUSES = [
  "submitted",
  "under_review",
  "approved",
  "rejected",
] as const;

export type BlockedSubmissionStatus =
  (typeof BLOCKED_SUBMISSION_STATUSES)[number];

/**
 * What the user is told, per status.
 *
 * Each line must be true of ITS OWN status and of no other — that is the whole
 * point of the module. Before BACKLOG-2868 one sentence stood in for all four,
 * and it happened to be the `submitted` one, so the three terminal-ish states
 * inherited a description of a deal still under review.
 *
 * These are the strings the SERVICE throws. The modal shows them before the
 * user presses anything, and may add a next-step sentence of its own on top
 * (at `rejected` it adds "Please contact your broker."), but it may never
 * REPLACE them — the parity test asserts containment, not equality, precisely
 * so the renderer can be more helpful without being able to drift.
 */
export const BLOCKED_SUBMISSION_MESSAGES: Record<
  BlockedSubmissionStatus,
  string
> = {
  submitted:
    "This transaction has already been submitted and is waiting for your broker to review it. If your broker asks for changes you will be able to resubmit.",
  under_review:
    "Cannot resubmit while broker is reviewing. Please wait for their decision.",
  approved: "This submission has already been approved.",
  rejected: "This submission has been rejected.",
};
