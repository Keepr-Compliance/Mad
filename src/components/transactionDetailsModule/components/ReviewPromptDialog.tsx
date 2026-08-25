/**
 * ReviewPromptDialog (BACKLOG-2791 P2 / BACKLOG-2792 P3)
 *
 * ONE component for both popups, because the founder specified P3 as "the same
 * visual style as P2". Two renderings of one dialog cannot drift apart the way
 * two components would.
 *
 *   P2 "found"   — over the transaction details after a sync found something:
 *                  "N total communications found" [Later] [Review now]
 *                  Shown ONLY when N > 0 (N = L + R). Dismissing costs nothing:
 *                  the items are already persisted, so Later just closes.
 *                  When R = 0 the buttons collapse to a single [Confirm]
 *                  (founder walk, 2026-08-23) — with nothing queued there is
 *                  nothing to review now and nothing to defer.
 *
 *   P3 "blocked" — the Complete gate:
 *                  "You have N communications that need to be reviewed before
 *                   completing the transaction" [Review] [Cancel]
 *                  There is NO bypass. The only affirmative action opens the
 *                  review screen.
 */
import React from "react";
// BACKLOG-2866: the blocked copy moved to the gate module BYTE-IDENTICAL, so the
// bulk-export refusal says the same thing as this dialog. One condition, one
// wording. The BACKLOG-2792 copy tests pass unmodified — that is the proof the
// extraction did not drift.
import { reviewBlockedBody, reviewBlockedTitle } from "@/services/exportReviewGate";

export type ReviewPromptVariant = "found" | "blocked";

export interface ReviewPromptDialogProps {
  variant: ReviewPromptVariant;
  /**
   * "found": the number that REQUIRE REVIEW from this run (the copy's R).
   * "blocked": the outstanding queue total, or -1 when it could not be read.
   */
  count: number;
  /**
   * "found" only — communications THIS run linked outright (the copy's L).
   * The total shown is L + R, so this must be the run's real linked count and
   * never a placeholder.
   */
  linkedCount?: number;
  onReview: () => void;
  onDismiss: () => void;
}

export function ReviewPromptDialog({
  variant,
  count,
  linkedCount = 0,
  onReview,
  onDismiss,
}: ReviewPromptDialogProps): React.ReactElement {
  const isBlocked = variant === "blocked";
  // BACKLOG-2791: -1 means the queue could not be READ. The gate blocks on that
  // rather than assuming empty, so the message must not claim a count it does
  // not have. `reviewBlockedTitle`/`reviewBlockedBody` carry that branch now.

  // FOUNDER-DICTATED COPY (2026-08-22 R-session), transcribed verbatim. The
  // announcement is identical for a brand-new transaction and for an
  // open/contact-save sync, and every number is THIS RUN's delta — never a
  // cumulative or pre-existing total.
  //
  //   "N total communications found
  //    L linked successfully
  //    R require review
  //    Communications that require review will only be linked after you approve
  //    them."
  //
  // N is computed as L + R rather than passed in, so the three lines cannot
  // disagree with each other.
  const requiresReview = count;
  const totalFound = linkedCount + requiresReview;

  // FOUNDER WALK, 2026-08-23. He was shown "18 total communications found / 18
  // linked successfully" over [Later] [Review now]. Both offers are nonsense
  // when R is 0: there is nothing to review now, and nothing left to do later —
  // the linking already happened. That shape gets ONE button, "Confirm", which
  // simply closes. R > 0 keeps both, because there the choice is real.
  const acknowledgeOnly = !isBlocked && requiresReview === 0;

  const title = isBlocked
    ? reviewBlockedTitle(count)
    : `${totalFound} total communications found`;

  const body = isBlocked ? reviewBlockedBody(count) : null;

  return (
    <div
      className="fixed inset-0 z-[80] flex items-center justify-center bg-black/40 p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="review-prompt-title"
      data-testid={`review-prompt-${variant}`}
    >
      <div className="w-full max-w-md rounded-xl bg-white p-6 shadow-2xl">
        <div className="flex items-start gap-3">
          <div className="mt-0.5 flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-full bg-amber-100">
            <svg className="h-5 w-5 text-amber-700" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M12 9v2m0 4h.01M5 19h14a2 2 0 001.84-2.75L13.74 4a2 2 0 00-3.48 0L3.16 16.25A2 2 0 005 19z"
              />
            </svg>
          </div>
          <div className="min-w-0">
            <h2 id="review-prompt-title" className="text-lg font-semibold text-gray-900">
              {title}
            </h2>
            {body !== null ? (
              <p className="mt-1 text-sm text-gray-600">{body}</p>
            ) : (
              /* Founder ruling, 2026-08-22: a zero line is noise, not information.
                 Symmetric — drop "0 linked successfully" when nothing linked,
                 drop "0 require review" (and the approval sentence with it) when
                 nothing needs review. The total line always shows. */
              <div className="mt-1 text-sm text-gray-600" data-testid="review-prompt-breakdown">
                {linkedCount > 0 && <p>{linkedCount} linked successfully</p>}
                {requiresReview > 0 && (
                  <>
                    <p>{requiresReview} require review</p>
                    <p className="mt-2">
                      Communications that require review will only be linked after you
                      approve them.
                    </p>
                  </>
                )}
              </div>
            )}
          </div>
        </div>

        <div className="mt-6 flex items-center justify-end gap-3">
          {acknowledgeOnly ? (
            /* Nothing to review: one affirmative button that closes. It is wired
               to onDismiss, NOT onReview — opening an empty review screen is the
               same dead end as the [Review now] it replaces. */
            <button
              type="button"
              onClick={onDismiss}
              className="rounded-lg bg-blue-600 px-4 py-2 font-semibold text-white shadow-md transition-all hover:bg-blue-700"
            >
              Confirm
            </button>
          ) : (
            <>
              <button
                type="button"
                onClick={onDismiss}
                className="rounded-lg px-4 py-2 font-medium text-gray-700 transition-all hover:bg-gray-100"
              >
                {isBlocked ? "Cancel" : "Later"}
              </button>
              <button
                type="button"
                onClick={onReview}
                className="rounded-lg bg-blue-600 px-4 py-2 font-semibold text-white shadow-md transition-all hover:bg-blue-700"
              >
                {isBlocked ? "Review" : "Review now"}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

export default ReviewPromptDialog;
