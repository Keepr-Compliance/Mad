/**
 * EmailThreadCard Component
 * TASK-1183: Container for an email conversation thread, displaying a header with subject and participants.
 * Clicking "View" opens the email thread in a modal.
 * Pattern follows MessageThreadCard for consistency.
 */
import React, { useState } from "react";
import type { Communication } from "../types";
import { isEmailMessage } from "@/utils/channelHelpers";
import { EmailThreadViewModal } from "./modals";
import { formatDateRange } from "../../../utils/dateRangeUtils";
import { filterSelfFromParticipants, formatParticipants } from "../../../utils/emailParticipantUtils";
import { getEmailAvatarInitial } from "../../../utils/avatarUtils";

/**
 * Email thread data structure for grouping emails into conversations
 */
export interface EmailThread {
  /** Thread identifier (thread_id, or generated from subject) */
  id: string;
  /** Thread subject (normalized, without Re:/Fwd: prefixes) */
  subject: string;
  /** All unique participants (from, to, cc) */
  participants: string[];
  /** Number of emails in the thread */
  emailCount: number;
  /** Date of first email */
  startDate: Date;
  /** Date of most recent email */
  endDate: Date;
  /** All emails in the thread, sorted chronologically */
  emails: Communication[];
}

export interface EmailThreadCardProps {
  /** The email thread to display */
  thread: EmailThread;
  /** Callback when an email is clicked for full view */
  onViewEmail?: (email: Communication) => void;
  /** Callback when unlink button is clicked */
  onUnlink?: (thread: EmailThread) => void;
  /** Whether the unlink action is in progress */
  isUnlinking?: boolean;
  /** User's email address — filtered from participant display */
  userEmail?: string;
  /**
   * BACKLOG-1762: lowercase email -> contact display_name map. Resolves
   * participant names from Contacts when the email header carries no name.
   */
  nameMap?: ReadonlyMap<string, string>;
  /**
   * BACKLOG-1719: when true, the card shows a selection checkbox (matching the
   * transaction-window selection UX) and clicking the card toggles selection
   * instead of opening. The per-card remove button is hidden — bulk remove is
   * driven by the floating BulkSelectionBar.
   */
  selectionMode?: boolean;
  /** BACKLOG-1719: whether this thread is currently selected. */
  isSelected?: boolean;
  /** BACKLOG-1719: toggle this thread's selection. */
  onToggleSelect?: () => void;
  /**
   * BACKLOG-1869: when true, the card shows a blue ring highlight to draw
   * attention after a cross-tab search navigation. Managed via React state in
   * the parent so the ring survives list remounts during loading flips.
   */
  isHighlighted?: boolean;
}

/**
 * EmailThreadCard component for displaying an email thread.
 * Compact layout with subject, participant count, and date range.
 */
export function EmailThreadCard({
  thread,
  onViewEmail,
  onUnlink,
  isUnlinking = false,
  userEmail,
  nameMap,
  selectionMode = false,
  isSelected = false,
  onToggleSelect,
  isHighlighted = false,
}: EmailThreadCardProps): React.ReactElement {
  const [showModal, setShowModal] = useState(false);

  const firstEmail = thread.emails[0];
  const lastEmail = thread.emails[thread.emails.length - 1];
  const isMultipleEmails = thread.emailCount > 1;
  const threadHasAttachments = thread.emails.some(e => e.has_attachments);

  // Filter out the user's own email from participants
  const otherParticipants = filterSelfFromParticipants(thread.participants, userEmail);

  // Avatar: use first non-user participant if sender is the user, otherwise use sender
  const avatarInitial = otherParticipants.length > 0
    ? getEmailAvatarInitial(otherParticipants[0])
    : getEmailAvatarInitial(firstEmail?.sender);

  // Body preview from most recent email, fall back to first
  const bodyPreview = lastEmail?.body_text?.substring(0, 200)
    || firstEmail?.body_text?.substring(0, 200)
    || null;

  return (
    <>
      <div
        className={`rounded-lg border mb-3 overflow-hidden transition-colors ${
          isHighlighted
            ? "ring-4 ring-inset ring-blue-600 bg-blue-100 border-blue-500"
            : selectionMode && isSelected
              ? "bg-white border-blue-400 bg-blue-50"
              : "bg-white border-gray-200 hover:bg-gray-50"
        }`}
        data-testid="email-thread-card"
        data-thread-id={thread.id}
      >
        {/* Compact single-line layout */}
        <div
          className={`bg-gray-50 px-3 py-3 sm:px-4 flex items-center justify-between gap-2 ${
            selectionMode ? "cursor-pointer" : ""
          }`}
          onClick={selectionMode ? () => onToggleSelect?.() : undefined}
        >
          <div className="flex items-center gap-2 sm:gap-3 min-w-0 flex-1">
            {/* BACKLOG-1719: selection checkbox (matches transaction-window style) */}
            {selectionMode && (
              <div
                className="flex-shrink-0"
                onClick={(e) => { e.stopPropagation(); onToggleSelect?.(); }}
                data-testid="email-thread-select"
              >
                <div
                  className={`w-6 h-6 rounded-md border-2 flex items-center justify-center transition-all ${
                    isSelected ? "bg-blue-500 border-blue-500" : "border-gray-300 hover:border-blue-400"
                  }`}
                >
                  {isSelected && (
                    <svg className="w-4 h-4 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" />
                    </svg>
                  )}
                </div>
              </div>
            )}

            {/* Avatar - Blue for email */}
            <div className="w-8 h-8 bg-gradient-to-br from-blue-500 to-indigo-600 rounded-full flex items-center justify-center text-white font-semibold text-sm flex-shrink-0">
              {avatarInitial}
            </div>

            {/* Thread info: Subject and participants */}
            <div className="min-w-0 flex-1">
              <div data-testid="thread-subject">
                <span className="font-semibold text-gray-900 block truncate text-sm sm:text-base">
                  {thread.subject || "(No Subject)"}
                </span>
                <span className="font-normal text-gray-500 text-xs sm:text-sm block truncate">
                  {formatParticipants(otherParticipants, 2, nameMap)}
                  {isMultipleEmails && (
                    <span className="ml-2 text-gray-400">
                      ({thread.emailCount} emails)
                    </span>
                  )}
                </span>
                {bodyPreview && (
                  <span className="text-xs text-gray-400 block truncate mt-0.5 hidden sm:block">
                    {bodyPreview.length > 120 ? bodyPreview.substring(0, 120) + "..." : bodyPreview}
                  </span>
                )}
              </div>
            </div>
          </div>

          {/* Attachment icon, date range, and action buttons */}
          <div className="flex items-center gap-2 sm:gap-4 flex-shrink-0">
            {threadHasAttachments && (
              <svg className="w-4 h-4 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.172 7l-6.586 6.586a2 2 0 102.828 2.828l6.414-6.586a4 4 0 00-5.656-5.656l-6.415 6.585a6 6 0 108.486 8.486L20.5 13" />
              </svg>
            )}
            <span className="text-sm text-gray-500 hidden sm:inline">
              {formatDateRange(thread.startDate, thread.endDate)}
            </span>
            <button
              onClick={(e) => {
                e.stopPropagation();
                if (isMultipleEmails) {
                  setShowModal(true);
                } else if (onViewEmail && firstEmail) {
                  // Single email - open directly in original viewer
                  onViewEmail(firstEmail);
                }
              }}
              className="text-sm font-medium text-blue-600 hover:text-blue-800 transition-colors whitespace-nowrap"
              data-testid="view-thread-button"
            >
              {isMultipleEmails ? "View Thread →" : "View"}
            </button>
            {/* BACKLOG-1719: hide the single-remove button in selection mode —
                bulk remove is driven by the floating BulkSelectionBar. */}
            {!selectionMode && onUnlink && (
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  onUnlink(thread);
                }}
                disabled={isUnlinking}
                className="text-gray-400 hover:text-red-600 hover:bg-red-50 rounded p-1 transition-all disabled:opacity-50"
                title="Remove from transaction"
                data-testid="unlink-thread-button"
              >
                {isUnlinking ? (
                  <svg className="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24">
                    <circle
                      className="opacity-25"
                      cx="12"
                      cy="12"
                      r="10"
                      stroke="currentColor"
                      strokeWidth="4"
                    ></circle>
                    <path
                      className="opacity-75"
                      fill="currentColor"
                      d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
                    ></path>
                  </svg>
                ) : (
                  <svg
                    className="w-4 h-4"
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"
                    />
                  </svg>
                )}
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Email Thread View Modal */}
      {showModal && (
        <EmailThreadViewModal
          thread={thread}
          onClose={() => setShowModal(false)}
          onViewEmail={onViewEmail}
          userEmail={userEmail}
          nameMap={nameMap}
        />
      )}
    </>
  );
}

// ============================================
// EMAIL THREADING UTILITIES
// ============================================

/**
 * Normalize email subject for thread grouping.
 * Removes common reply/forward prefixes: Re:, Fwd:, FW:, RE:, etc.
 */
export function normalizeSubject(subject: string | undefined | null): string {
  if (!subject) return "";

  // Remove Re:, Fwd:, FW:, RE:, Fw: prefixes (case-insensitive, can be repeated)
  let normalized = subject.trim();
  const prefixPattern = /^(re:|fwd:|fw:)\s*/i;

  while (prefixPattern.test(normalized)) {
    normalized = normalized.replace(prefixPattern, "").trim();
  }

  return normalized.toLowerCase();
}

/**
 * Extract sender email address (without name part) for participant deduplication.
 */
function extractEmail(emailString: string): string {
  // Format: "Name <email@example.com>" or just "email@example.com"
  const match = emailString.match(/<([^>]+)>/);
  return match ? match[1].toLowerCase() : emailString.toLowerCase().trim();
}

/**
 * Get all unique participants from an email (from, to, cc).
 */
function getEmailParticipants(email: Communication): string[] {
  const participants = new Set<string>();

  if (email.sender) {
    participants.add(email.sender);
  }

  if (email.recipients) {
    // Recipients can be comma-separated
    email.recipients.split(",").forEach(r => {
      const trimmed = r.trim();
      if (trimmed) participants.add(trimmed);
    });
  }

  if (email.cc) {
    email.cc.split(",").forEach(c => {
      const trimmed = c.trim();
      if (trimmed) participants.add(trimmed);
    });
  }

  return Array.from(participants);
}

/**
 * Generate a thread key for grouping emails.
 * Priority:
 * 1. thread_id (canonical thread identifier)
 * 2. Normalized subject (fallback)
 */
function getEmailThreadKey(email: Communication): string {
  // Use thread_id if available (canonical field since BACKLOG-1579)
  if (email.thread_id) {
    return `thread-${email.thread_id}`;
  }

  // Fallback to normalized subject
  const normalizedSubject = normalizeSubject(email.subject);
  if (normalizedSubject) {
    return `subject-${normalizedSubject}`;
  }

  // Last resort: unique per email
  return `email-${email.id}`;
}

/**
 * Group emails by conversation thread.
 * Uses thread_id first, falls back to subject matching.
 */
export function groupEmailsByThread(
  emails: Communication[]
): Map<string, Communication[]> {
  const threads = new Map<string, Communication[]>();

  emails.forEach((email) => {
    // Only process emails (not texts); untyped records are treated as emails
    if (!isEmailMessage(email) && (email.channel || email.communication_type)) return;

    const threadKey = getEmailThreadKey(email);
    const thread = threads.get(threadKey) || [];
    thread.push(email);
    threads.set(threadKey, thread);
  });

  // Sort emails within each thread chronologically (oldest first)
  threads.forEach((msgs, key) => {
    threads.set(
      key,
      msgs.sort((a, b) => {
        const dateA = new Date(a.sent_at || a.received_at || 0).getTime();
        const dateB = new Date(b.sent_at || b.received_at || 0).getTime();
        return dateA - dateB;
      })
    );
  });

  return threads;
}

/**
 * Convert grouped emails to EmailThread objects for display.
 */
export function createEmailThreads(
  groupedEmails: Map<string, Communication[]>
): EmailThread[] {
  const threads: EmailThread[] = [];

  groupedEmails.forEach((emails, threadKey) => {
    if (emails.length === 0) return;

    const firstEmail = emails[0];
    const lastEmail = emails[emails.length - 1];

    // Collect all unique participants across all emails in thread
    const allParticipants = new Set<string>();
    emails.forEach(email => {
      getEmailParticipants(email).forEach(p => allParticipants.add(p));
    });

    // Deduplicate participants by email address
    const uniqueEmails = new Map<string, string>();
    allParticipants.forEach(p => {
      const email = extractEmail(p);
      // Keep the version with the display name if available
      if (!uniqueEmails.has(email) || p.includes("<")) {
        uniqueEmails.set(email, p);
      }
    });

    threads.push({
      id: threadKey,
      subject: firstEmail.subject || "(No Subject)",
      participants: Array.from(uniqueEmails.values()),
      emailCount: emails.length,
      startDate: new Date(firstEmail.sent_at || firstEmail.received_at || 0),
      endDate: new Date(lastEmail.sent_at || lastEmail.received_at || 0),
      emails: emails,
    });
  });

  return threads;
}

/**
 * Sort email threads by most recent email (newest first).
 */
export function sortEmailThreadsByRecent(threads: EmailThread[]): EmailThread[] {
  return threads.sort((a, b) => b.endDate.getTime() - a.endDate.getTime());
}

/**
 * Process communications into sorted email threads ready for display.
 * This is the main entry point for email thread grouping.
 */
export function processEmailThreads(communications: Communication[]): EmailThread[] {
  // Filter to only emails (untyped records default to email for backward compatibility)
  const emails = communications.filter(c =>
    isEmailMessage(c) || (!c.channel && !c.communication_type)
  );

  // Group into threads
  const grouped = groupEmailsByThread(emails);

  // Create thread objects
  const threads = createEmailThreads(grouped);

  // Sort by most recent
  return sortEmailThreadsByRecent(threads);
}
