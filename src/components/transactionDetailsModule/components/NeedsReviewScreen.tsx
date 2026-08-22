/**
 * NeedsReviewScreen — S2 (BACKLOG-2791)
 *
 * Emails and texts COMBINED, in one list, approved or rejected per item.
 *
 * NOT A TAB, by founder instruction ("tabs are not action specific so maybe a
 * tab isn't the place"). It is a full-surface overlay ABOVE the details screen,
 * reached three ways: the header's Needs Review button, P2's Review, and P3's
 * Review. Rendered as an overlay rather than an early return in
 * TransactionDetails so the four tabs stay mounted underneath and keep their
 * scroll position, highlight state and loaded channels — an early return
 * discards all of it and the user lands back at the top of a re-fetching tab.
 *
 * The list comes from the ONE review-state read (useReviewQueue →
 * review:get-state → reviewStateService.getReviewState), so it is the same set,
 * by id, that the header badge counts and the Complete gate blocks on.
 *
 * DEVIATION FROM THE FLOW CHART, recorded deliberately: the founder asked to
 * "reuse the components... just put them together". EmailThreadCard and
 * MessageThreadCard both require fully-hydrated `Communication[]` / message
 * rows, which a PENDING item does not have — it is not in `communications` at
 * all, which is the entire point of the design. Rendering those cards would
 * therefore have shown nothing for exactly the items this screen exists to show.
 * ReviewItemCard below matches their visual language (same card chrome, same
 * amber needs-review treatment, same check/trash affordances) against the
 * display payload that travels with each item.
 */
import React, { useMemo, useState } from "react";
import type { ReviewItemDto } from "../../../../electron/types/ipc/window-api-transactions";
import { ReviewItemCard } from "./ReviewItemCard";

export interface NeedsReviewScreenProps {
  items: ReviewItemDto[];
  isLoading: boolean;
  onApprove: (itemIds: string[]) => Promise<void>;
  onReject: (itemIds: string[]) => Promise<void>;
  onClose: () => void;
}

export function NeedsReviewScreen({
  items,
  isLoading,
  onApprove,
  onReject,
  onClose,
}: NeedsReviewScreenProps): React.ReactElement {
  const [busyId, setBusyId] = useState<string | null>(null);
  const [bulkBusy, setBulkBusy] = useState(false);

  const { emails, texts } = useMemo(
    () => ({
      emails: items.filter((i) => i.kind === "email"),
      texts: items.filter((i) => i.kind === "text"),
    }),
    [items],
  );

  const act = async (id: string, fn: (ids: string[]) => Promise<void>) => {
    setBusyId(id);
    try {
      await fn([id]);
    } finally {
      setBusyId(null);
    }
  };

  const actAll = async (fn: (ids: string[]) => Promise<void>) => {
    setBulkBusy(true);
    try {
      await fn(items.map((i) => i.id));
    } finally {
      setBulkBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[70] flex flex-col bg-gray-50" data-testid="needs-review-screen">
      <header className="flex items-center justify-between gap-3 border-b border-gray-200 bg-white px-4 py-3 sm:px-6">
        <div className="flex min-w-0 items-center gap-3">
          <button
            type="button"
            onClick={onClose}
            aria-label="Back"
            className="rounded-lg p-2 text-gray-600 transition-all hover:bg-gray-100"
          >
            <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
            </svg>
          </button>
          <div className="min-w-0">
            <h1 className="truncate text-lg font-semibold text-gray-900">Needs Review</h1>
            <p className="truncate text-sm text-gray-500">
              {items.length === 0
                ? "Nothing to review"
                : `${items.length} item${items.length === 1 ? "" : "s"} · ${emails.length} email${emails.length === 1 ? "" : "s"}, ${texts.length} text${texts.length === 1 ? "" : "s"}`}
            </p>
          </div>
        </div>

        {items.length > 0 && (
          <div className="flex flex-shrink-0 items-center gap-2">
            <button
              type="button"
              onClick={() => actAll(onReject)}
              disabled={bulkBusy}
              className="rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm font-medium text-gray-700 transition-all hover:bg-gray-100 disabled:opacity-50"
            >
              Reject all
            </button>
            <button
              type="button"
              onClick={() => actAll(onApprove)}
              disabled={bulkBusy}
              className="rounded-lg bg-green-600 px-3 py-2 text-sm font-semibold text-white transition-all hover:bg-green-700 disabled:opacity-50"
            >
              Approve all
            </button>
          </div>
        )}
      </header>

      <div className="flex-1 overflow-y-auto px-4 py-4 sm:px-6">
        {isLoading && items.length === 0 ? (
          <p className="text-sm text-gray-500">Loading…</p>
        ) : items.length === 0 ? (
          <div className="mx-auto mt-16 max-w-sm text-center">
            <p className="font-medium text-gray-900">Everything is reviewed</p>
            <p className="mt-1 text-sm text-gray-600">
              New communications will appear here when they are found.
            </p>
          </div>
        ) : (
          <ul className="mx-auto flex max-w-3xl flex-col gap-3">
            {items.map((item) => (
              <ReviewItemCard
                key={item.id}
                item={item}
                busy={busyId === item.id || bulkBusy}
                onApprove={() => act(item.id, onApprove)}
                onReject={() => act(item.id, onReject)}
              />
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

export default NeedsReviewScreen;
