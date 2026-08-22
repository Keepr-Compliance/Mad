/**
 * ReviewQueueSection (BACKLOG-2791)
 *
 * The needs-review section that appears at the TOP of the Emails tab and the
 * Texts tab.
 *
 * Founder ruling, 2026-08-22: the review data "can be displayed combined
 * (email+text) in Needs Review or separately in the needs-review sections of the
 * emails/texts tabs, but the data and state should be the same in the backend".
 *
 * So this section does NOT classify anything itself. It receives items straight
 * from `getReviewState` (via useReviewQueue) and filters by kind. That is what
 * makes the three renderings — this section on Emails, this section on Texts,
 * and the combined screen — provably the same set: asserted by id in
 * reviewQueueSameSet-2791.
 *
 * The failure this prevents is concrete: before it, the badge could say 5 while
 * the Emails tab's own section said 0, because pending items are deliberately
 * not in `communications` and the tab's render-time classification cannot see
 * them.
 */
import React, { useState } from "react";
import { ReviewItemCard } from "./ReviewItemCard";
import type { ReviewItemDto } from "../../../../electron/types/ipc/window-api-transactions";

export interface ReviewQueueSectionProps {
  /** The full review set — filtered here, never re-derived. */
  items: ReviewItemDto[];
  /** Which half of the set this tab shows. */
  kind: "email" | "text";
  onApprove: (itemIds: string[]) => Promise<void>;
  onReject: (itemIds: string[]) => Promise<void>;
  /** Opens the combined screen (S2) — the same set, both kinds. */
  onOpenAll?: () => void;
}

export function ReviewQueueSection({
  items,
  kind,
  onApprove,
  onReject,
  onOpenAll,
}: ReviewQueueSectionProps): React.ReactElement | null {
  const [isOpen, setIsOpen] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);

  const mine = items.filter((i) => i.kind === kind);

  // Nothing to review → render nothing, so a clean transaction is unchanged.
  if (mine.length === 0) return null;

  const act = async (id: string, fn: (ids: string[]) => Promise<void>) => {
    setBusyId(id);
    try {
      await fn([id]);
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="mb-4" data-testid={`review-queue-section-${kind}`}>
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => setIsOpen((v) => !v)}
          aria-expanded={isOpen}
          className="flex items-center gap-2 rounded-lg px-1 py-1 text-sm font-semibold text-amber-800 transition-all hover:bg-amber-50"
        >
          <svg
            className={`h-4 w-4 transition-transform ${isOpen ? "rotate-90" : ""}`}
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
          </svg>
          Needs review
          <span className="inline-flex min-w-[1.25rem] items-center justify-center rounded-full bg-amber-600 px-1.5 py-0.5 text-xs font-bold text-white">
            {mine.length}
          </span>
        </button>

        {onOpenAll && (
          <button
            type="button"
            onClick={onOpenAll}
            className="ml-auto rounded-lg px-2 py-1 text-xs font-medium text-blue-700 transition-all hover:bg-blue-50"
          >
            Review all
          </button>
        )}
      </div>

      {isOpen && (
        <ul className="mt-2 flex flex-col gap-2">
          {mine.map((item) => (
            <ReviewItemCard
              key={item.id}
              item={item}
              busy={busyId === item.id}
              onApprove={() => act(item.id, onApprove)}
              onReject={() => act(item.id, onReject)}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

export default ReviewQueueSection;
