/**
 * MessageThreadCard Component
 * Container for a conversation thread, displaying a header with contact info.
 * Clicking "View" opens the conversation in a phone-style popup modal.
 */
import React, { useState } from "react";
import type { Communication, Message } from "../types";
import { ConversationViewModal } from "./modals";
import { normalizePhoneForLookup } from "../../../utils/phoneNormalization";
import { getContactAvatarInitial } from "../../../utils/avatarUtils";
import { formatDate } from "../../../utils/formatUtils";

/**
 * Union type for messages - can be from messages table or communications table
 */
export type MessageLike = Message | Communication;

export interface MessageThreadCardProps {
  /** Unique identifier for the thread */
  threadId: string;
  /** Messages in this thread, sorted chronologically */
  messages: MessageLike[];
  /** Contact name if available */
  contactName?: string;
  /** Phone number or identifier for the thread */
  phoneNumber: string;
  /** Callback when unlink button is clicked */
  onUnlink?: (threadId: string) => void;
  /** Map of phone number -> contact name for resolving senders */
  contactNames?: Record<string, string>;
  /** Audit period start date for filtering (TASK-1157) */
  auditStartDate?: Date | string | null;
  /** Audit period end date for filtering (TASK-1157) */
  auditEndDate?: Date | string | null;
  /** Whether this thread was removed/unlinked (grayed out styling) */
  isRemoved?: boolean;
  /** Callback when restore button is clicked (only shown when isRemoved) */
  onRestore?: (threadId: string) => void;
  /** Whether restore is in progress */
  isRestoring?: boolean;
  /**
   * BACKLOG-1719: when true (active cards only), the card shows a selection
   * checkbox and clicking the card toggles selection instead of opening. The
   * per-card remove button is hidden — bulk remove uses the floating bar.
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
 * Get all unique participants from a thread (excluding the user).
 * Returns an array of phone numbers/identifiers.
 *
 * Collects from multiple sources to ensure all participants are found:
 * 1. chat_members (from Apple's chat_handle_join) - authoritative list
 * 2. from/to fields - catches participants missed by chat_members
 */
function getThreadParticipants(messages: MessageLike[]): string[] {
  const participants = new Set<string>();

  for (const msg of messages) {
    try {
      if (msg.participants) {
        const parsed =
          typeof msg.participants === "string"
            ? JSON.parse(msg.participants)
            : msg.participants;

        // Collect from chat_members (authoritative, doesn't include user)
        if (parsed.chat_members && Array.isArray(parsed.chat_members)) {
          parsed.chat_members.forEach((m: string) => {
            if (m && m !== "unknown") participants.add(m);
          });
        }

        // Also collect from from/to fields to catch any missed participants
        // For inbound messages, the sender (from) is the other person
        if (msg.direction === "inbound" && parsed.from) {
          const from = parsed.from;
          if (from !== "me" && from !== "unknown") {
            participants.add(from);
          }
        }
        // For outbound messages, the recipient (to) is the other person
        if (msg.direction === "outbound" && parsed.to) {
          const toList = Array.isArray(parsed.to) ? parsed.to : [parsed.to];
          toList.forEach((p: string) => {
            if (p && p !== "me" && p !== "unknown") participants.add(p);
          });
        }
      }
    } catch {
      // Continue to next message
    }
  }

  return Array.from(participants);
}

/**
 * Check if a thread is a group chat (more than one unique external participant).
 * Considers resolved contact names to avoid treating one contact with multiple
 * phone numbers as a group chat.
 */
function isGroupChat(
  messages: MessageLike[],
  contactNames: Record<string, string> = {}
): boolean {
  const participants = getThreadParticipants(messages);

  // TASK-2026: Use normalizePhoneForLookup which handles both phones and emails
  const resolvedNames = new Set<string>();
  for (const p of participants) {
    // Try direct lookup
    if (contactNames[p]) {
      resolvedNames.add(contactNames[p]);
      continue;
    }
    // Try normalized lookup (handles both phone and email)
    const normalized = normalizePhoneForLookup(p);
    let found = false;
    for (const [phone, name] of Object.entries(contactNames)) {
      if (normalizePhoneForLookup(phone) === normalized) {
        resolvedNames.add(name);
        found = true;
        break;
      }
    }
    // If no name found, use the raw identifier
    if (!found) {
      resolvedNames.add(p);
    }
  }

  return resolvedNames.size > 1;
}

/**
 * Format participant names for display.
 * Uses contactNames map to resolve phone numbers to names.
 * Sorts resolved names first, unresolved phone numbers last.
 */
function formatParticipantNames(
  participants: string[],
  contactNames: Record<string, string>,
  maxShow: number = 3
): string {
  // Check if a string looks like a phone number (starts with + or is mostly digits)
  const isPhoneNumber = (s: string): boolean => {
    return s.startsWith("+") || /^\d[\d\s\-()]{6,}$/.test(s);
  };

  // TASK-2026: Use normalizePhoneForLookup which handles both phones and emails
  const names = participants.map((p) => {
    // Try direct lookup first
    if (contactNames[p]) return contactNames[p];
    // Try normalized lookup (handles both phone and email)
    const normalized = normalizePhoneForLookup(p);
    for (const [phone, name] of Object.entries(contactNames)) {
      if (normalizePhoneForLookup(phone) === normalized) return name;
    }
    // Fall back to raw identifier
    return p;
  });

  // Deduplicate names (same contact may have multiple phone numbers)
  const uniqueNames = [...new Set(names)];

  // Sort: resolved names first, phone numbers last
  uniqueNames.sort((a, b) => {
    const aIsPhone = isPhoneNumber(a);
    const bIsPhone = isPhoneNumber(b);
    if (aIsPhone && !bIsPhone) return 1;  // a is phone, b is name → b first
    if (!aIsPhone && bIsPhone) return -1; // a is name, b is phone → a first
    return 0; // preserve original order within same type
  });

  if (uniqueNames.length <= maxShow) {
    return uniqueNames.join(", ");
  }
  return `${uniqueNames.slice(0, maxShow).join(", ")} +${uniqueNames.length - maxShow} more`;
}

// getSenderPhone and normalizePhoneForLookup imported from src/utils/phoneNormalization.ts (TASK-2027)

/**
 * MessageThreadCard component for displaying a conversation thread.
 * Redesigned for TASK-1156: Compact single-line layout with date range.
 * Format: "ContactName (+1234567890)    Jan 1 - Jan 6    View Full ->"
 */
export function MessageThreadCard({
  threadId,
  messages,
  contactName,
  phoneNumber,
  onUnlink,
  contactNames = {},
  auditStartDate,
  auditEndDate,
  isRemoved = false,
  onRestore,
  isRestoring = false,
  selectionMode = false,
  isSelected = false,
  onToggleSelect,
  isHighlighted = false,
}: MessageThreadCardProps): React.ReactElement {
  const [showModal, setShowModal] = useState(false);

  // BACKLOG-1719: selection UX only applies to active cards, never to removed ones.
  const showSelection = selectionMode && !isRemoved;

  // Detect group chat (using contactNames to resolve duplicates)
  const participants = getThreadParticipants(messages);
  const isGroup = isGroupChat(messages, contactNames);
  const avatarInitial = getContactAvatarInitial(contactName, phoneNumber);

  // Get date range for the conversation
  const getDateRange = (): string => {
    if (messages.length === 0) return "";
    const first = messages[0];
    const last = messages[messages.length - 1];
    const firstDate = new Date(first.sent_at || first.received_at || 0);
    const lastDate = new Date(last.sent_at || last.received_at || 0);
    if (firstDate.toDateString() === lastDate.toDateString()) {
      return formatDate(firstDate);
    }
    return `${formatDate(firstDate)} - ${formatDate(lastDate)}`;
  };

  return (
    <>
      <div
        className={`rounded-lg border mb-3 overflow-hidden transition-colors ${
          isHighlighted
            ? "ring-2 ring-inset ring-blue-400 bg-blue-50 border-blue-400"
            : isRemoved
            ? "bg-gray-50 border-gray-200 opacity-60"
            : showSelection && isSelected
            ? "bg-blue-50 border-blue-400"
            : "bg-white border-gray-200 hover:bg-gray-50"
        }`}
        data-testid={isRemoved ? "removed-thread-card" : "message-thread-card"}
        data-thread-id={threadId}
      >
        {/* Compact single-line layout */}
        <div
          className={`bg-gray-50 px-3 py-3 sm:px-4 flex items-center justify-between gap-2 ${
            showSelection ? "cursor-pointer" : ""
          }`}
          onClick={showSelection ? () => onToggleSelect?.() : undefined}
        >
          <div className="flex items-center gap-2 sm:gap-3 min-w-0 flex-1">
            {/* BACKLOG-1719: selection checkbox (matches transaction-window style) */}
            {showSelection && (
              <div
                className="flex-shrink-0"
                onClick={(e) => { e.stopPropagation(); onToggleSelect?.(); }}
                data-testid="message-thread-select"
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

            {/* Avatar - Purple for group, Green for 1:1 */}
            {isGroup ? (
              <div className="w-8 h-8 rounded-full flex items-center justify-center flex-shrink-0 bg-purple-100">
                <svg
                  className="w-4 h-4 text-purple-600"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0zm6 3a2 2 0 11-4 0 2 2 0 014 0zM7 10a2 2 0 11-4 0 2 2 0 014 0z"
                  />
                </svg>
              </div>
            ) : (
              <div className="w-8 h-8 bg-gradient-to-br from-green-500 to-teal-600 rounded-full flex items-center justify-center text-white font-semibold text-sm flex-shrink-0">
                {avatarInitial}
              </div>
            )}

            {/* Contact info: Name on first line, phone/recipients on second line */}
            <div className="min-w-0 flex-1">
              {isGroup ? (
                <div data-testid="thread-contact-name">
                  {/* BACKLOG-1793: no "Removed" pill — removed cards are placed
                      under the "Show removed" section, so the pill is redundant. */}
                  <span className={`font-semibold block ${isRemoved ? "text-gray-500" : "text-gray-900"}`}>
                    Group Chat
                  </span>
                  <span
                    className="font-normal text-gray-500 text-sm block truncate"
                    title={formatParticipantNames(participants, contactNames, 999)}
                  >
                    {formatParticipantNames(participants, contactNames, 3)}
                  </span>
                </div>
              ) : (
                <div data-testid="thread-contact-name">
                  {/* BACKLOG-1793: no "Removed" pill — removed cards live under
                      the "Show removed" section, so the pill is redundant. */}
                  <span className={`font-semibold block ${isRemoved ? "text-gray-500" : "text-gray-900"}`}>
                    {contactName || phoneNumber}
                  </span>
                  {contactName && phoneNumber && (
                    <span className="font-normal text-gray-500 text-sm block">
                      {phoneNumber}
                    </span>
                  )}
                </div>
              )}
            </div>
          </div>

          {/* Date range and action buttons */}
          <div className="flex items-center gap-2 sm:gap-3 flex-shrink-0">
            {!isRemoved && (
              <span className="text-sm text-gray-500 hidden sm:inline">
                {getDateRange()}
              </span>
            )}
            <button
              onClick={(e) => { e.stopPropagation(); setShowModal(true); }}
              className="text-sm font-medium text-blue-600 hover:text-blue-800 transition-colors whitespace-nowrap"
              data-testid="toggle-thread-button"
            >
              View Full &rarr;
            </button>
            {/* BACKLOG-1719: hide the single-remove button in selection mode. */}
            {showSelection ? null : isRemoved && onRestore ? (
              <button
                onClick={() => onRestore(threadId)}
                disabled={isRestoring}
                className="flex items-center gap-1 px-2 py-1 text-xs font-medium text-green-600 hover:text-green-800 hover:bg-green-50 rounded transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                data-testid="restore-removed-message"
                title="Restore this conversation to the transaction"
              >
                {isRestoring ? (
                  <>
                    <div className="w-3 h-3 border-2 border-blue-400 border-t-transparent rounded-full animate-spin" />
                    Restoring...
                  </>
                ) : (
                  <>
                    <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 10h10a8 8 0 018 8v2M3 10l6 6m-6-6l6-6" />
                    </svg>
                    Restore
                  </>
                )}
              </button>
            ) : onUnlink ? (
              <button
                onClick={() => onUnlink(threadId)}
                className="text-gray-400 hover:text-red-600 hover:bg-red-50 rounded p-1 transition-all"
                title="Remove from transaction"
                data-testid="unlink-thread-button"
              >
                {/* BACKLOG-1793: trash icon (matches EmailThreadCard) instead of
                    the do-not-enter sign, for a consistent "remove" affordance. */}
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
              </button>
            ) : null}
          </div>
        </div>
      </div>

      {/* Conversation Popup Modal */}
      {showModal && (
        <ConversationViewModal
          messages={messages}
          contactName={contactName}
          phoneNumber={phoneNumber}
          contactNames={contactNames}
          auditStartDate={auditStartDate}
          auditEndDate={auditEndDate}
          onClose={() => setShowModal(false)}
        />
      )}
    </>
  );
}

/**
 * Generate a key for grouping messages into chats.
 * Uses thread_id (from macOS chat_id) first, as this is the actual conversation ID.
 * Falls back to participant-based grouping only if thread_id is not available.
 */
function getThreadKey(msg: MessageLike): string {
  // FIRST: Use thread_id if available - this is the actual iMessage chat ID
  // Format is "macos-chat-{chat_id}" from the import
  if (msg.thread_id) {
    return msg.thread_id;
  }

  // FALLBACK: Compute from participants if no thread_id
  try {
    if (msg.participants) {
      const parsed = typeof msg.participants === 'string'
        ? JSON.parse(msg.participants)
        : msg.participants;

      // Collect all participants
      const allParticipants = new Set<string>();

      if (parsed.from) {
        allParticipants.add(normalizeParticipant(parsed.from));
      }
      if (parsed.to) {
        const toList = Array.isArray(parsed.to) ? parsed.to : [parsed.to];
        toList.forEach((p: string) => allParticipants.add(normalizeParticipant(p)));
      }

      // Remove "me" - we only care about external participants for grouping
      allParticipants.delete('me');

      // Sort and join to create a consistent key
      if (allParticipants.size > 0) {
        return `participants-${Array.from(allParticipants).sort().join('|')}`;
      }
    }
  } catch {
    // Fall through to default
  }

  // Last resort: use message id (each message is its own "thread")
  return `msg-${msg.id}`;
}

/**
 * Normalize a participant identifier (phone/email) for consistent grouping.
 */
function normalizeParticipant(participant: string): string {
  if (!participant) return '';

  // If it looks like a phone number, normalize to digits only
  const digits = participant.replace(/\D/g, '');
  if (digits.length >= 10) {
    // Use last 10 digits to normalize +1 prefix variations
    return digits.slice(-10);
  }

  // Otherwise return lowercase trimmed version
  return participant.toLowerCase().trim();
}

/**
 * Utility function to group messages by conversation/chat.
 * Uses thread_id (actual iMessage chat ID) when available,
 * falls back to participant-based grouping otherwise.
 */
export function groupMessagesByThread(
  messages: MessageLike[]
): Map<string, MessageLike[]> {
  const threads = new Map<string, MessageLike[]>();

  messages.forEach((msg) => {
    const threadKey = getThreadKey(msg);
    const thread = threads.get(threadKey) || [];
    thread.push(msg);
    threads.set(threadKey, thread);
  });

  // Sort messages within each thread chronologically
  threads.forEach((msgs, key) => {
    threads.set(
      key,
      msgs.sort((a, b) => {
        const dateA = new Date(a.sent_at || a.received_at || 0).getTime();
        const dateB = new Date(b.sent_at || b.received_at || 0).getTime();
        return dateB - dateA; // TASK-1794: Newest first
      })
    );
  });

  return threads;
}

/**
 * Utility function to extract phone number from thread messages.
 * Looks at participants to find the external phone number.
 *
 * Priority order:
 * 1. from/to fields (for 1:1 messages with valid handle)
 * 2. chat_members array (for group chats or when handle_id was null)
 * 3. Legacy sender field
 * 4. "Unknown" fallback
 */
export function extractPhoneFromThread(messages: MessageLike[]): string {
  // First, identify the user's own identifiers to exclude them
  // The user is "from" in outbound messages, and "to" in inbound messages
  const userIdentifiers = new Set<string>();
  for (const msg of messages) {
    if (msg.participants) {
      try {
        const parsed = JSON.parse(msg.participants as string);
        // For outbound, user is in "from"
        if (msg.direction === "outbound" && parsed.from && parsed.from !== "me" && parsed.from !== "unknown") {
          userIdentifiers.add(parsed.from.toLowerCase());
        }
        // For inbound, user is in "to"
        if (msg.direction === "inbound" && parsed.to) {
          const toList = Array.isArray(parsed.to) ? parsed.to : [parsed.to];
          for (const t of toList) {
            if (t && t !== "me" && t !== "unknown") {
              userIdentifiers.add(t.toLowerCase());
            }
          }
        }
      } catch { /* ignore */ }
    }
  }

  // Helper to check if identifier belongs to user
  const isUserIdentifier = (id: string): boolean => {
    if (!id) return true;
    const lower = id.toLowerCase();
    return userIdentifiers.has(lower) || lower === "me" || lower === "unknown";
  };

  for (const msg of messages) {
    // Try to parse participants JSON
    if (msg.participants) {
      try {
        const participants = JSON.parse(msg.participants as string);

        // For inbound messages, "from" is the external phone
        if (msg.direction === "inbound" && participants.from && !isUserIdentifier(participants.from)) {
          return participants.from;
        }
        // For outbound messages, "to" contains the external phone
        if (msg.direction === "outbound" && participants.to?.length > 0 && !isUserIdentifier(participants.to[0])) {
          return participants.to[0];
        }

        // Fallback to chat_members for group chats or when from/to are "unknown"
        // chat_members contains all participants except "me"
        if (participants.chat_members && participants.chat_members.length > 0) {
          // Return first non-user member
          const validMember = participants.chat_members.find(
            (m: string) => !isUserIdentifier(m)
          );
          if (validMember) {
            return validMember;
          }
        }
      } catch {
        // Parsing failed, continue to fallback
      }
    }

    // Fallback to legacy sender field (only on Communication type)
    // But not if it's the user's own identifier
    if ("sender" in msg && msg.sender && !isUserIdentifier(msg.sender)) {
      return msg.sender;
    }
  }

  return "Unknown";
}

/**
 * Sort threads by most recent message (newest first).
 */
export function sortThreadsByRecent(
  threads: Map<string, MessageLike[]>
): [string, MessageLike[]][] {
  return Array.from(threads.entries()).sort(([, msgsA], [, msgsB]) => {
    const newestA = msgsA[0];
    const newestB = msgsB[0];
    const dateA = new Date(newestA?.sent_at || newestA?.received_at || 0).getTime();
    const dateB = new Date(newestB?.sent_at || newestB?.received_at || 0).getTime();
    return dateB - dateA; // Descending order (newest first)
  });
}
