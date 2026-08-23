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
 * CARDS ARE THE TABS' OWN, NOT A BESPOKE ONE.
 * The first cut rendered a purpose-built ReviewItemCard here, on the reasoning
 * that a PENDING item is absent from `communications` and so cannot hydrate the
 * real cards. That reasoning was right about the data and wrong about the fix:
 * the answer was to hydrate the item (the queue now carries the raw email and
 * message fields), not to build a second card. The bespoke card also had no
 * name resolution at all, which is why senders rendered as raw addresses and
 * phone numbers.
 *
 * So: EmailThreadCard and MessageThreadCard, with the SAME props the tabs pass —
 * including click-to-preview — plus the review surfaces' approve/reject
 * affordances. One component per medium, three surfaces (the tab, the tab's
 * needs-review section, and this screen).
 *
 * Two lists behind an Emails | Texts switcher rather than one combined list
 * (founder, 2026-08-22). The switcher supplies the medium, which is why the
 * cards carry no type label.
 */
import React, { useMemo, useState } from "react";
import type { ReviewItemDto } from "../../../../electron/types/ipc/window-api-transactions";
import { ReviewCards, groupReviewItemsByThread } from "./ReviewQueueSection";
import type { Communication } from "../types";

export interface NeedsReviewScreenProps {
  items: ReviewItemDto[];
  isLoading: boolean;
  onApprove: (itemIds: string[]) => Promise<void>;
  onReject: (itemIds: string[]) => Promise<void>;
  onClose: () => void;
  /** Open an email for reading — the tabs' own click-to-preview behaviour. */
  onViewEmail?: (comm: Communication) => void;
  /** User's own address, filtered from participant display (as on the tab). */
  userEmail?: string;
  /** lowercase email -> contact name (emails). */
  nameMap?: ReadonlyMap<string, string>;
  /** handle -> contact name (texts). */
  contactNames?: Record<string, string>;
  auditStartDate?: Date | string | null;
  auditEndDate?: Date | string | null;
}

export function NeedsReviewScreen({
  items,
  isLoading,
  onApprove,
  onReject,
  onClose,
  onViewEmail,
  userEmail,
  nameMap,
  contactNames,
  auditStartDate,
  auditEndDate,
}: NeedsReviewScreenProps): React.ReactElement {
  const [busyId, setBusyId] = useState<string | null>(null);
  const [bulkBusy, setBulkBusy] = useState(false);

  // Founder, 2026-08-22: two lists behind an Emails | Texts switcher, not one
  // combined list. The tab supplies the medium, so the cards carry no type
  // label — that context used to live on every row.
  const emails = items.filter((i) => i.kind === "email");
  const texts = items.filter((i) => i.kind === "text");
  const [medium, setMedium] = useState<"email" | "text">("email");

  // THREAD counts for every number on this screen (contract: "badges and
  // subtitles count threads"). The subtitle already said "threads" while
  // counting items, so a two-email conversation read as "2 threads need review"
  // above a single card. Derived from the same grouping ReviewCards renders.
  const emailThreadCount = useMemo(() => groupReviewItemsByThread(emails).length, [emails]);
  const textThreadCount = useMemo(() => groupReviewItemsByThread(texts).length, [texts]);
  const threadCount = emailThreadCount + textThreadCount;

  // Open on the side that actually has something, so the screen never lands on
  // an empty list while the other one is full.
  const [pinned, setPinned] = useState(false);
  const active: "email" | "text" =
    pinned || (medium === "email" ? emails.length > 0 : texts.length > 0)
      ? medium
      : emails.length > 0
        ? "email"
        : "text";
  const shown = active === "email" ? emails : texts;


  // Acts on the WHOLE thread (contract rows T3/T4); `busyId` is the thread key,
  // so the acting card disables and its siblings do not.
  const act = async (ids: string[], threadKey: string, fn: (ids: string[]) => Promise<void>) => {
    setBusyId(threadKey);
    try {
      await fn(ids);
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
              {threadCount} {threadCount === 1 ? "thread" : "threads"} need review
            </p>
          </div>
        </div>
      </div>

      {/* Emails | Texts switcher. Two lists, not one combined one — the tab
          supplies the medium, which is why the cards carry no type label. */}
      {items.length > 0 && (
        <div
          className="flex-shrink-0 border-b border-gray-200 bg-white px-3 sm:px-6"
          data-testid="needs-review-medium-tabs"
          role="tablist"
        >
          {(
            [
              ["email", "Emails", emailThreadCount],
              ["text", "Texts", textThreadCount],
            ] as Array<["email" | "text", string, number]>
          ).map(([value, label, count]) => (
            <button
              key={value}
              type="button"
              role="tab"
              aria-selected={active === value}
              data-testid={`needs-review-tab-${value}`}
              onClick={() => {
                setMedium(value);
                setPinned(true);
              }}
              className={`relative px-4 py-3 text-sm font-medium transition-colors ${
                active === value
                  ? "text-amber-700 border-b-2 border-amber-600"
                  : "text-gray-500 hover:text-gray-700 border-b-2 border-transparent"
              }`}
            >
              {label}
              {count > 0 && (
                <span className="ml-1.5 text-xs font-semibold">({count})</span>
              )}
            </button>
          ))}
        </div>
      )}

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
        ) : shown.length === 0 ? (
          <div className="mx-auto mt-16 max-w-sm text-center">
            <p className="font-medium text-gray-900">
              No {active === "email" ? "emails" : "texts"} need review
            </p>
            <p className="mt-1 text-sm text-gray-600">
              Switch to {active === "email" ? "Texts" : "Emails"} to review the rest.
            </p>
          </div>
        ) : (
          /* THE SAME card renderer the tabs' needs-review sections use, with the
             same props — including click-to-preview. One component per medium,
             three surfaces (tab, tab section, this screen). */
          <div className="mx-auto max-w-3xl">
            <ReviewCards
              items={shown}
              kind={active}
              busyId={bulkBusy ? shown[0]?.id ?? busyId : busyId}
              onApproveItem={(ids, key) => void act(ids, key, onApprove)}
              onRejectItem={(ids, key) => void act(ids, key, onReject)}
              onViewEmail={onViewEmail}
              userEmail={userEmail}
              nameMap={nameMap}
              contactNames={contactNames}
              auditStartDate={auditStartDate}
              auditEndDate={auditEndDate}
            />
          </div>
        )}
      </div>
    </div>
  );
}

export default NeedsReviewScreen;
