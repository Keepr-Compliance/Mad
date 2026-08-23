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
 * Rebuild an EmailThread from a review item.
 *
 * The item carries the raw `emails` row fields precisely so this is a
 * projection of real data rather than a stand-in — participants come from the
 * genuine sender/recipients/cc, which is what lets nameMap resolve them.
 */
export function reviewItemToEmailThread(item: ReviewItemDto): EmailThread {
  const d = item.display;
  const comm = {
    id: item.email_id ?? item.id,
    email_id: item.email_id ?? undefined,
    subject: d.title,
    sender: d.sender ?? "",
    recipients: d.recipients ?? "",
    cc: d.cc ?? "",
    body_plain: d.snippet,
    sent_at: d.occurredAt ?? undefined,
    has_attachments: d.hasAttachments,
    communication_type: "email",
  } as unknown as Communication;

  const participants = Array.from(
    new Set(
      [d.sender ?? "", ...(d.recipients ?? "").split(","), ...(d.cc ?? "").split(",")]
        .map((x) => x.trim())
        .filter((x) => x.length > 0),
    ),
  );
  const when = d.occurredAt ? new Date(d.occurredAt) : new Date();

  return {
    id: item.id,
    subject: d.title,
    participants,
    emailCount: 1,
    startDate: when,
    endDate: when,
    emails: [comm],
  };
}

function ReviewCards({
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
  busyId: string | null;
  onApproveItem: (id: string) => void;
  onRejectItem: (id: string) => void;
  onViewEmail?: (comm: Communication) => void;
  userEmail?: string;
  nameMap?: ReadonlyMap<string, string>;
  contactNames?: Record<string, string>;
  auditStartDate?: Date | string | null;
  auditEndDate?: Date | string | null;
}): React.ReactElement {
  return (
    <div className="mt-3 space-y-3" data-testid="needs-review-list">
      {items.map((item) => {
        if (kind === "email") {
          return (
            <EmailThreadCard
              key={item.id}
              thread={reviewItemToEmailThread(item)}
              variant="needsReview"
              onViewEmail={onViewEmail}
              onConfirm={() => onApproveItem(item.id)}
              onUnlink={() => onRejectItem(item.id)}
              isConfirming={busyId === item.id}
              isUnlinking={busyId === item.id}
              userEmail={userEmail}
              nameMap={nameMap}
            />
          );
        }
        const phone = item.display.threadParticipants[0] ?? item.display.title;
        return (
          <div key={item.id} data-testid="review-item" data-item-id={item.id} data-kind="text">
            <MessageThreadCard
              threadId={item.thread_id ?? item.id}
              messages={item.display.threadMessages as unknown as MessageLike[]}
              phoneNumber={phone}
              contactNames={contactNames}
              contactName={contactNames?.[phone]}
              auditStartDate={auditStartDate}
              auditEndDate={auditEndDate}
              onUnlink={() => onRejectItem(item.id)}
            />
            {/* MessageThreadCard has no confirm affordance on develop — texts
                never had a needs-review state — so the Keep action is rendered
                beside it rather than invented inside a shared card. */}
            <div className="mt-1 flex justify-end">
              <button
                type="button"
                onClick={() => onApproveItem(item.id)}
                disabled={busyId === item.id}
                className="text-gray-400 hover:text-green-600 hover:bg-green-50 rounded p-1 transition-all disabled:opacity-50"
                title="Keep — confirm this conversation belongs to the transaction"
                data-testid="confirm-thread-button"
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                </svg>
              </button>
            </div>
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

  // Nothing to review → render nothing, so a clean transaction is unchanged.
  if (mine.length === 0) return null;

  const act = (id: string, fn: (ids: string[]) => Promise<void>) => {
    setBusyId(id);
    void fn([id]).finally(() => setBusyId(null));
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
          ({mine.length})
        </span>
      </div>

      {isOpen && (
        <ReviewCards
          items={mine}
          kind={kind}
          busyId={busyId}
          onApproveItem={(id) => act(id, onApprove)}
          onRejectItem={(id) => act(id, onReject)}
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
