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
import React, { useState } from "react";
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
    <div
      className="fixed inset-0 z-[70] flex flex-col bg-gradient-to-br from-blue-50 via-indigo-50 to-purple-50 overflow-hidden"
      data-testid="needs-review-screen"
    >
      {/* Screen chrome copied from the app's existing full-screen surfaces —
          TransactionToolbar (Transactions) and Contacts (Clients & Contacts) —
          rather than invented: gradient bar with shadow-lg and NO border, back
          button hard left as a text button with the long-arrow icon, and a
          right-aligned title block whose subtitle carries the count in the
          gradient's own 100-weight hue.
          Amber/orange is this screen's identity (blue/purple and purple/pink
          are taken by the two reference screens) and already denotes review in
          TransactionHeader's pending-review state.
          The z-index stays z-[70]: unlike those screens, which are positioned by
          an AppModals wrapper, this overlay is its own positioner and must sit
          ABOVE TransactionDetails at z-[60]. */}
      <div className="flex-shrink-0 bg-gradient-to-r from-amber-500 to-orange-500 px-3 sm:px-6 pt-6 sm:pt-10 pb-3 sm:pb-4 flex items-center justify-between shadow-lg">
        <button
          type="button"
          onClick={onClose}
          className="text-white hover:bg-white hover:bg-opacity-20 rounded-lg px-2 sm:px-4 py-2 transition-all flex items-center gap-1 sm:gap-2 font-medium text-sm sm:text-base"
        >
          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M10 19l-7-7m0 0l7-7m-7 7h18"
            />
          </svg>
          {/* "Back to Transaction", not the references' "Back to Dashboard":
              this overlay sits on top of the transaction, which is where the
              button actually returns you. */}
          <span className="hidden sm:inline">Back to Transaction</span>
          <span className="sm:hidden">Back</span>
        </button>

        <div className="flex items-center gap-2 sm:gap-4">
          {items.length > 0 && (
            /* On-gradient action treatment, matching the Contacts header's
               review-duplicates button. flex-shrink-0 here + min-w-0 on the
               title block decide which side gives way on overflow
               (BACKLOG-2671). */
            <div className="flex flex-shrink-0 items-center gap-2">
              <button
                type="button"
                onClick={() => actAll(onReject)}
                disabled={bulkBusy}
                className="whitespace-nowrap text-white bg-white bg-opacity-20 hover:bg-opacity-30 rounded-lg px-2.5 py-2 sm:px-3.5 transition-all font-medium text-xs sm:text-sm disabled:opacity-50"
              >
                Reject all
              </button>
              <button
                type="button"
                onClick={() => actAll(onApprove)}
                disabled={bulkBusy}
                className="whitespace-nowrap text-amber-700 bg-white hover:bg-opacity-90 rounded-lg px-2.5 py-2 sm:px-3.5 transition-all font-semibold text-xs sm:text-sm disabled:opacity-50"
              >
                Approve all
              </button>
            </div>
          )}

          <div className="text-right min-w-0" data-testid="needs-review-title-block">
            <h2 className="text-lg sm:text-2xl font-bold text-white">Needs Review</h2>
            <p
              className="text-amber-100 text-xs sm:text-sm"
              data-testid="needs-review-header-count"
            >
              {items.length} {items.length === 1 ? "thread" : "threads"} need review
            </p>
          </div>
        </div>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto p-3 sm:p-6">
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
