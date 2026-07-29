/**
 * NeedsReviewSection Component (BACKLOG-2319)
 *
 * A collapsible section at the TOP of the Emails tab, above the linked
 * conversations, holding emails that were auto-attached to the transaction
 * (contact-on-deal + within the audit period) but whose body never named the
 * property address — the ambiguous "contact-only" links.
 *
 * Mirrors the "Show removed emails" collapsible pattern (chevron + inline count)
 * but amber-tinted, and adds an info (i) popover explaining the section. Each
 * card is an EmailThreadCard in the "needsReview" variant with a Confirm (check)
 * action to keep the conversation (→ Linked) and the existing remove (trash)
 * action to drop it (→ Removed).
 */
import React, { useState } from "react";
import { EmailThreadCard, type EmailThread } from "./EmailThreadCard";
import type { Communication } from "../types";

export interface NeedsReviewSectionProps {
  /** Threads classified as needs-review (all emails are address_missing). */
  threads: EmailThread[];
  /** Open a thread / email for reading. */
  onViewEmail: (comm: Communication) => void;
  /** Confirm a thread — promotes it to Linked. */
  onConfirm: (thread: EmailThread) => void;
  /** Remove a thread — routes it to the Removed section (existing unlink). */
  onRemove: (thread: EmailThread) => void;
  /** Thread id whose confirm is in flight (spinner). */
  confirmingThreadId?: string | null;
  /** Thread id whose remove is in flight (spinner). */
  unlinkingThreadId?: string | null;
  /** User's email address — filtered from participant display. */
  userEmail?: string;
  /** lowercase email -> contact display_name map for participant resolution. */
  nameMap?: ReadonlyMap<string, string>;
}

export function NeedsReviewSection({
  threads,
  onViewEmail,
  onConfirm,
  onRemove,
  confirmingThreadId,
  unlinkingThreadId,
  userEmail,
  nameMap,
}: NeedsReviewSectionProps): React.ReactElement | null {
  // Default OPEN — this is the actionable review surface.
  const [isOpen, setIsOpen] = useState(true);
  const [showInfo, setShowInfo] = useState(false);

  // Nothing to review → render nothing (keeps a normal transaction unchanged).
  if (threads.length === 0) return null;

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
              Emails from contacts on this deal, within the audit period, that
              didn&apos;t mention the property address. Keep the ones that belong
              (<span aria-hidden="true">✓</span>), remove the ones that don&apos;t
              (<span aria-hidden="true">🗑</span>).
            </div>
          )}
        </div>

        <span className="text-sm font-semibold text-amber-700" data-testid="needs-review-count">
          ({threads.length})
        </span>
      </div>

      {/* Cards */}
      {isOpen && (
        <div className="mt-3 space-y-3" data-testid="needs-review-list">
          {threads.map((thread) => (
            <EmailThreadCard
              key={thread.id}
              thread={thread}
              variant="needsReview"
              onViewEmail={onViewEmail}
              onConfirm={onConfirm}
              onUnlink={onRemove}
              isConfirming={confirmingThreadId === thread.id}
              isUnlinking={unlinkingThreadId === thread.id}
              userEmail={userEmail}
              nameMap={nameMap}
            />
          ))}
        </div>
      )}
    </div>
  );
}
