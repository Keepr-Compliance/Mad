/**
 * ReviewQueueSection (BACKLOG-2791)
 *
 * The "Needs review" section on the Emails and Texts tabs.
 *
 * DESIGN IS DEVELOP'S, DATA IS THE SHARED SET.
 * The chrome — collapsible chevron + "Needs review" + the (i) explainer + the
 * count in parentheses — is BACKLOG-2319's NeedsReviewSection, reproduced from
 * `origin/develop` rather than reinvented (founder revert, 2026-08-22). The
 * cards are the app's own EmailThreadCard (variant="needsReview": View +
 * checkmark + trash) and MessageThreadCard, not a bespoke card.
 *
 * What is NOT reverted is where the data comes from. Membership is the shared
 * review set from `getReviewState`, filtered by kind — never re-derived here.
 * The tab classifying for itself is what produced the duplicate-section bug, and
 * it is why the badge could say 5 while the tab's own section said 0.
 *
 * Rendering the real cards is also what fixes the NAMES regression: both cards
 * already resolve participants through `nameMap` (emails) and `contactNames`
 * (texts), so senders show as contacts rather than raw addresses and phone
 * numbers. The bespoke card had no name resolution at all — the lookup was
 * absent, not broken.
 *
 * Position: directly under the Select row, above the "Linked emails" divider —
 * develop's placement. The first cut moved it to the very top of the tab.
 */
import React, { useMemo, useState } from "react";
import { EmailThreadCard, type EmailThread } from "./EmailThreadCard";
import { MessageThreadCard, type MessageLike } from "./MessageThreadCard";
import type { Communication } from "../types";
import type { ReviewItemDto } from "../../../../electron/types/ipc/window-api-transactions";
// The grouping rule lives in utils/ so the COUNT (derived in useReviewQueue)
// and the CARDS drawn here cannot drift apart. Re-exported because three
// surfaces and their suites already import it from this module.
import { groupReviewItemsByThread, type ReviewThreadGroup } from "../utils/reviewThreads";

export { groupReviewItemsByThread };
export type { ReviewThreadGroup };

export interface ReviewQueueSectionProps {
  /** The full review set — filtered here by kind, never re-derived. */
  items: ReviewItemDto[];
  kind: "email" | "text";
  onApprove: (itemIds: string[]) => Promise<void>;
  onReject: (itemIds: string[]) => Promise<void>;
  /** Open a single email for reading (emails only). */
  onViewEmail?: (comm: Communication) => void;
  /** User's own address — filtered out of participant display. */
  userEmail?: string;
  /** lowercase email -> contact display_name (emails). */
  nameMap?: ReadonlyMap<string, string>;
  /** handle -> contact display_name (texts). */
  contactNames?: Record<string, string>;
  auditStartDate?: Date | string | null;
  auditEndDate?: Date | string | null;
}

/**
 * Project ONE review item into the Communication shape EmailThreadCard reads.
 *
 * The item carries the raw `emails` row fields precisely so this is a
 * projection of real data rather than a stand-in — participants come from the
 * genuine sender/recipients/cc, which is what lets nameMap resolve them.
 */
function reviewItemToCommunication(item: ReviewItemDto): Communication {
  const d = item.display;
  return {
    id: item.email_id ?? item.id,
    email_id: item.email_id ?? undefined,
    subject: d.title,
    sender: d.sender ?? "",
    recipients: d.recipients ?? "",
    cc: d.cc ?? "",
    // BOTH, and body_text is the load-bearing one: EmailThreadCard's third row
    // (the body preview) reads `body_text`, not `body_plain`. The projection set
    // only `body_plain` — the name of the underlying `emails` COLUMN — so
    // `bodyPreview` computed to null and the card silently rendered two rows
    // instead of three. The row was never missing from the card; it was never
    // being given anything to show.
    body_text: d.snippet,
    body_plain: d.snippet,
    sent_at: d.occurredAt ?? undefined,
    has_attachments: d.hasAttachments,
    communication_type: "email",
  } as unknown as Communication;
}

/**
 * Rebuild an EmailThread from a whole review THREAD.
 *
 * Mirrors the tabs' own `createEmailThreads`: emails oldest-first, the subject
 * taken from the oldest, participants unioned across every email, and
 * `emailCount` the real number of emails — which is what renders the card's
 * "(N emails)" affordance, so a two-email thread reads as one card that says so
 * rather than as two cards.
 */
export function reviewThreadToEmailThread(group: ReviewThreadGroup): EmailThread {
  const ordered = [...group.items].sort((a, b) =>
    (a.display.occurredAt ?? "").localeCompare(b.display.occurredAt ?? ""),
  );
  const emails = ordered.map(reviewItemToCommunication);

  const participants = Array.from(
    new Set(
      ordered
        .flatMap((item) => [
          item.display.sender ?? "",
          ...(item.display.recipients ?? "").split(","),
          ...(item.display.cc ?? "").split(","),
        ])
        .map((x) => x.trim())
        .filter((x) => x.length > 0),
    ),
  );

  const times = ordered.map((item) =>
    item.display.occurredAt ? new Date(item.display.occurredAt) : new Date(),
  );

  return {
    id: group.key,
    subject: ordered[0]?.display.title ?? "(no subject)",
    participants,
    emailCount: ordered.length,
    startDate: times[0] ?? new Date(),
    endDate: times[times.length - 1] ?? new Date(),
    emails,
  };
}

export function ReviewCards({
  items,
  kind,
  busyId,
  onApproveItem,
  onRejectItem,
  onViewEmail,
  userEmail,
  nameMap,
  contactNames,
  auditStartDate,
  auditEndDate,
}: {
  items: ReviewItemDto[];
  kind: "email" | "text";
  /** The THREAD key currently acting, not an item id. */
  busyId: string | null;
  /**
   * Called with EVERY item id in the thread — the contract's rows T3/T4 act on
   * the whole thread, and the toasts count what came back (emails), so the
   * caller needs the full list rather than a representative.
   */
  onApproveItem: (ids: string[], threadKey: string) => void;
  onRejectItem: (ids: string[], threadKey: string) => void;
  onViewEmail?: (comm: Communication) => void;
  userEmail?: string;
  nameMap?: ReadonlyMap<string, string>;
  contactNames?: Record<string, string>;
  auditStartDate?: Date | string | null;
  auditEndDate?: Date | string | null;
}): React.ReactElement {
  // ONE CARD PER THREAD. Grouping happens here rather than in each caller so the
  // review screen and both tab sections cannot drift into different units.
  const groups = groupReviewItemsByThread(items);

  return (
    <div className="mt-3 space-y-3" data-testid="needs-review-list">
      {groups.map((group) => {
        const item = group.items[0];
        const ids = group.items.map((i) => i.id);
        if (kind === "email") {
          return (
            <EmailThreadCard
              key={group.key}
              thread={reviewThreadToEmailThread(group)}
              variant="needsReview"
              onViewEmail={onViewEmail}
              onConfirm={() => onApproveItem(ids, group.key)}
              onUnlink={() => onRejectItem(ids, group.key)}
              isConfirming={busyId === group.key}
              isUnlinking={busyId === group.key}
              userEmail={userEmail}
              nameMap={nameMap}
            />
          );
        }
        // Resolved EXACTLY as the Texts tab resolves its own rows
        // (TransactionMessagesTab: `contactNames[phoneNumber] || contactNames[normalized]`).
        // The first cut looked up a single raw key, so a handle stored under its
        // normalized 10-digit form never matched and every sender rendered as a
        // bare number — the defect the founder saw as "# 13609181693".
        const phoneNumber = item.display.threadParticipants[0] ?? item.display.title;
        const normalized = phoneNumber.replace(/\D/g, "").slice(-10);
        const contactName = contactNames?.[phoneNumber] || contactNames?.[normalized];
        return (
          // The SAME card the rest of the tab uses, with the confirm affordance
          // inside it — no bespoke row, no button hung beside it.
          <div
            key={group.key}
            data-testid="review-item"
            data-item-id={item.id}
            data-thread-key={group.key}
            data-kind="text"
          >
            <MessageThreadCard
              threadId={item.thread_id ?? item.id}
              messages={item.display.threadMessages as unknown as MessageLike[]}
              /* BACKLOG-2295: the tab passes fullMessages so the conversation
                 modal's own before/after toggle is independent of the tab's
                 audit crop. The review surface passes it for the same reason —
                 and here the two are genuinely the same set, because the queue
                 hydrates the whole thread rather than a cropped window. Omitting
                 it fell back to `messages`, which worked by accident rather than
                 by matching the tab. */
              fullMessages={item.display.threadMessages as unknown as MessageLike[]}
              phoneNumber={phoneNumber}
              contactName={contactName}
              contactNames={contactNames}
              auditStartDate={auditStartDate}
              auditEndDate={auditEndDate}
              onConfirm={() => onApproveItem(ids, group.key)}
              isConfirming={busyId === group.key}
              onUnlink={() => onRejectItem(ids, group.key)}
            />
          </div>
        );
      })}
    </div>
  );
}

export function ReviewQueueSection({
  items,
  kind,
  onApprove,
  onReject,
  onViewEmail,
  userEmail,
  nameMap,
  contactNames,
  auditStartDate,
  auditEndDate,
}: ReviewQueueSectionProps): React.ReactElement | null {
  // Default OPEN — this is the actionable surface (develop's behaviour).
  const [isOpen, setIsOpen] = useState(true);
  const [showInfo, setShowInfo] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);

  const mine = useMemo(() => items.filter((i) => i.kind === kind), [items, kind]);
  // The count in the header is a THREAD count (contract: "badges and subtitles
  // count threads"), derived from the same grouping ReviewCards renders — so
  // the number beside "Needs review" can never disagree with the cards below it.
  const threadCount = useMemo(() => groupReviewItemsByThread(mine).length, [mine]);

  // Nothing to review → render nothing, so a clean transaction is unchanged.
  if (mine.length === 0) return null;

  // `ids` is the whole thread; `busyId` is keyed by the thread, so both buttons
  // on the acting card disable together and no sibling card is affected.
  const act = (ids: string[], threadKey: string, fn: (ids: string[]) => Promise<void>) => {
    setBusyId(threadKey);
    void fn(ids).finally(() => setBusyId(null));
  };

  return (
    <div className="mb-4" data-testid="needs-review-section">
      {/* Header row — one line: chevron + "Needs review" + (i) + (N), amber. */}
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => setIsOpen((v) => !v)}
          className="flex items-center gap-1.5 text-sm font-semibold text-amber-700 hover:text-amber-800 transition-colors"
          data-testid="needs-review-toggle"
          aria-expanded={isOpen}
        >
          <svg
            className={`w-3.5 h-3.5 transition-transform ${isOpen ? "rotate-90" : ""}`}
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
          </svg>
          Needs review
        </button>

        {/* Info popover — mirrors the retired filter toggle's (i), amber-tinted. */}
        <div className="relative">
          <button
            type="button"
            onClick={() => setShowInfo((v) => !v)}
            className="w-5 h-5 rounded-full bg-amber-100 text-amber-700 text-xs font-bold flex items-center justify-center hover:bg-amber-200 transition-colors"
            aria-label="About Needs review"
            data-testid="needs-review-info-button"
          >
            i
          </button>
          {showInfo && (
            <div
              className="absolute left-0 top-7 z-20 w-72 rounded-lg border border-amber-200 bg-white p-3 text-xs text-gray-600 shadow-lg"
              data-testid="needs-review-info-popover"
              role="tooltip"
            >
              {kind === "email"
                ? "Emails found for contacts on this deal, within the audit period, that aren't linked yet."
                : "Text conversations found for contacts on this deal, within the audit period, that aren't linked yet."}{" "}
              Keep the ones that belong (<span aria-hidden="true">✓</span>), remove the
              ones that don&apos;t (<span aria-hidden="true">🗑</span>).
            </div>
          )}
        </div>

        <span className="text-sm font-semibold text-amber-700" data-testid="needs-review-count">
          ({threadCount})
        </span>
      </div>

      {isOpen && (
        <ReviewCards
          items={mine}
          kind={kind}
          busyId={busyId}
          onApproveItem={(ids, key) => act(ids, key, onApprove)}
          onRejectItem={(ids, key) => act(ids, key, onReject)}
          onViewEmail={onViewEmail}
          userEmail={userEmail}
          nameMap={nameMap}
          contactNames={contactNames}
          auditStartDate={auditStartDate}
          auditEndDate={auditEndDate}
        />
      )}
    </div>
  );
}

export default ReviewQueueSection;
