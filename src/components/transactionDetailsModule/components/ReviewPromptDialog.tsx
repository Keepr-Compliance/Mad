/**
 * ReviewPromptDialog (BACKLOG-2791 P2 / BACKLOG-2792 P3)
 *
 * ONE component for both popups, because the founder specified P3 as "the same
 * visual style as P2". Two renderings of one dialog cannot drift apart the way
 * two components would.
 *
 *   P2 "found"   — over the transaction details after a sync added something:
 *                  "N new communications found" [Review] [Later]
 *                  Shown ONLY when N > 0. Dismissing costs nothing: the items
 *                  are already persisted in the queue, so Later just closes.
 *
 *   P3 "blocked" — the Complete gate:
 *                  "You have N communications that need to be reviewed before
 *                   completing the transaction" [Review] [Cancel]
 *                  There is NO bypass. The only affirmative action opens the
 *                  review screen.
 */
import React from "react";

export type ReviewPromptVariant = "found" | "blocked";

export interface ReviewPromptDialogProps {
  variant: ReviewPromptVariant;
  count: number;
  onReview: () => void;
  onDismiss: () => void;
}

export function ReviewPromptDialog({
  variant,
  count,
  onReview,
  onDismiss,
}: ReviewPromptDialogProps): React.ReactElement {
  const isBlocked = variant === "blocked";
  const plural = count === 1 ? "communication" : "communications";

  const title = isBlocked
    ? "Review needed before completing"
    : `${count} new ${plural} found`;

  const body = isBlocked
    ? `You have ${count} ${plural} that need to be reviewed before completing the transaction.`
    : `They've been added to Needs Review. Nothing is linked to this transaction until you approve it.`;

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
            <p className="mt-1 text-sm text-gray-600">{body}</p>
          </div>
        </div>

        <div className="mt-6 flex items-center justify-end gap-3">
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
            Review
          </button>
        </div>
      </div>
    </div>
  );
}

export default ReviewPromptDialog;
