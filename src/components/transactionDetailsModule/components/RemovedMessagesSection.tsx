/**
 * RemovedMessagesSection Component (BACKLOG-1577)
 * Shows a collapsible section at the bottom of the message thread list
 * that displays previously unlinked/removed conversations.
 * Users can view removed messages and optionally restore them.
 *
 * BACKLOG-1793: Ported ALL removed-section fixes from the Emails tab via the
 * SHARED useRemovedSection hook + RemovedItemsSection shell (no copy-paste):
 *  - No red "Removed" pill on removed cards (see MessageThreadCard).
 *  - Trash icon for remove on active cards (see MessageThreadCard).
 *  - Restore does NOT collapse the section (controlled-open lifted above the
 *    loading boundary in TransactionMessagesTab).
 *  - Restore does NOT move the scroll — SILENT in-place refresh via
 *    onRestoreComplete (refreshCommunicationsSilently("text")), never loadDetails.
 *  - View works on removed items (MessageThreadCard's read-only ConversationViewModal).
 */
import React, { useCallback } from "react";
import { extractAllHandles } from "../../../utils/phoneNormalization";
import { MessageThreadCard } from "./MessageThreadCard";
import type { MessageLike } from "./MessageThreadCard";
import { RemovedItemsSection } from "./RemovedItemsSection";
import { useRemovedSection, type RemovedRestoreResult } from "../hooks/useRemovedSection";
import { getContactMergeKey, mergeItemsByKey } from "../../../utils/threadMergeUtils";
import logger from "../../../utils/logger";

/** Shape of a removed message row from the IPC handler */
interface RemovedMessageRow {
  ignored_id: string;
  ic_thread_id: string | null;
  reason: string | null;
  ignored_at: string;
  message_id: string;
  body: string | null;
  subject: string | null;
  channel: string | null;
  thread_id: string | null;
  sent_at: string | null;
  received_at: string | null;
  participants: string | null;
  participants_flat: string | null;
  direction: string | null;
}

/**
 * A removed conversation as shown on ONE card.
 *
 * BACKLOG-2263: a single 1:1 conversation legitimately spans multiple macOS
 * chat_ids (SMS/iMessage, +1/bare phone, phone/email handles). Unlinking writes
 * one `ignored_communications` row per raw thread, so the same contact used to
 * render as several cards. We now contact-merge them into ONE card while keeping
 * every constituent `ignored_id` so restore can clear all suppression rows.
 *
 * `ignoredId` is the primary (first-seen) id, kept for display/back-compat;
 * `ignoredIds` is the full set of merged suppression rows on this card.
 */
interface RemovedThread {
  ignoredId: string;
  ignoredIds: string[];
  threadId: string | null;
  reason: string | null;
  ignoredAt: string;
  messages: RemovedMessageRow[];
}

interface RemovedMessagesSectionProps {
  transactionId: string;
  /** Map of phone number -> contact name for resolving senders */
  contactNames?: Record<string, string>;
  /**
   * BACKLOG-1793: SILENT refresh after restore (refreshCommunicationsSilently
   * in TransactionDetails) — no loading flag, no spinner, scroll never moves.
   * Mirrors the Emails tab's onRestoreComplete.
   */
  onRestoreComplete?: () => void | Promise<void>;
  /**
   * Legacy full-refresh callback (attach flow / fallback). Used as the restore
   * refresh only when onRestoreComplete is not provided.
   */
  onMessagesChanged?: () => void | Promise<void>;
  /** Toast handlers */
  onShowSuccess?: (message: string) => void;
  onShowError?: (message: string) => void;
  /** BACKLOG-1589: Callback to merge newly resolved contact names into parent state */
  onContactNamesResolved?: (names: Record<string, string>) => void;
  /**
   * BACKLOG-1793: externally controlled open state so the parent can lift this
   * above the loading spinner and keep the section expanded across refetches.
   */
  isOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  /**
   * BACKLOG-1793: increment after each successful unlink to trigger a silent
   * re-fetch of the removed list (updates the count label in place).
   */
  refreshKey?: number;
}

/**
 * Extract a phone number or identifier from a removed thread's messages.
 * Checks participants JSON for "from" (inbound) or first chat_member.
 */
function extractPhoneFromRemovedThread(thread: RemovedThread): string {
  for (const msg of thread.messages) {
    if (!msg.participants) continue;
    try {
      const parsed = typeof msg.participants === "string" ? JSON.parse(msg.participants) : msg.participants;
      // For inbound, "from" is the external contact
      if (msg.direction === "inbound" && parsed.from && parsed.from !== "me" && parsed.from !== "unknown") {
        return parsed.from;
      }
      // For outbound, "to" is the external contact
      if (msg.direction === "outbound" && parsed.to) {
        const toList = Array.isArray(parsed.to) ? parsed.to : [parsed.to];
        const valid = toList.find((t: string) => t && t !== "me" && t !== "unknown");
        if (valid) return valid;
      }
      // Fallback to chat_members
      if (parsed.chat_members && Array.isArray(parsed.chat_members) && parsed.chat_members.length > 0) {
        const valid = parsed.chat_members.find((m: string) => m && m !== "me" && m !== "unknown");
        if (valid) return valid;
      }
      // Last fallback: "from" field regardless of direction
      if (parsed.from && parsed.from !== "me" && parsed.from !== "unknown") {
        return parsed.from;
      }
    } catch {
      // Continue to next message
    }
  }
  return "Unknown";
}

/**
 * Map RemovedMessageRow array to MessageLike array for use with MessageThreadCard.
 * Maps the removed message fields to the Message interface, using deprecated
 * "body" field for backwards compatibility with the conversation view modal.
 */
function mapToMessageLike(rows: RemovedMessageRow[]): MessageLike[] {
  return rows.map((row) => ({
    id: row.message_id,
    user_id: "",
    channel: (row.channel as MessageLike["channel"]) ?? undefined,
    direction: (row.direction as MessageLike["direction"]) ?? undefined,
    subject: row.subject ?? undefined,
    body: row.body ?? undefined,
    body_text: row.body ?? undefined,
    participants: row.participants ?? undefined,
    participants_flat: row.participants_flat ?? undefined,
    thread_id: row.thread_id ?? undefined,
    sent_at: row.sent_at ?? undefined,
    received_at: row.received_at ?? undefined,
    has_attachments: false,
    is_false_positive: false,
    created_at: row.sent_at ?? row.received_at ?? "",
  }));
}

/**
 * Format a date string for display.
 */
function formatRemovedDate(dateStr: string | null): string {
  if (!dateStr) return "";
  try {
    const date = new Date(dateStr);
    return date.toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
      year: "numeric",
    });
  } catch {
    return dateStr;
  }
}

/**
 * Group removed message rows by ignored_id (each ignored_communications record
 * may match multiple messages in the same thread).
 */
function groupByIgnoredId(rows: RemovedMessageRow[]): RemovedThread[] {
  const map = new Map<string, RemovedThread>();

  for (const row of rows) {
    let thread = map.get(row.ignored_id);
    if (!thread) {
      thread = {
        ignoredId: row.ignored_id,
        ignoredIds: [row.ignored_id],
        threadId: row.ic_thread_id || row.thread_id,
        reason: row.reason,
        ignoredAt: row.ignored_at,
        messages: [],
      };
      map.set(row.ignored_id, thread);
    }
    thread.messages.push(row);
  }

  return Array.from(map.values());
}

/**
 * BACKLOG-2263: group removed rows the SAME way the attached list does.
 *
 * First bucket by ignored_id (one bucket per suppression row), then contact-merge
 * those buckets using the shared identity rule (getContactMergeKey) so a single
 * contact's SMS/iMessage/phone/email threads collapse into ONE card. Real group
 * chats (merge key = null) stay their own separate card.
 *
 * The merged card aggregates every constituent row + ignored_id, which is what
 * makes restore able to clear ALL suppression records for the conversation.
 */
function groupByContact(
  rows: RemovedMessageRow[],
  contactNames: Record<string, string>,
): RemovedThread[] {
  const perIgnored = groupByIgnoredId(rows);
  return mergeItemsByKey(
    perIgnored,
    (thread) => getContactMergeKey(mapToMessageLike(thread.messages), contactNames),
    (existing, incoming) => ({
      ...existing,
      messages: [...existing.messages, ...incoming.messages],
      ignoredIds: [...existing.ignoredIds, ...incoming.ignoredIds],
      // Show the most recent removal timestamp for the merged card.
      ignoredAt:
        existing.ignoredAt >= incoming.ignoredAt ? existing.ignoredAt : incoming.ignoredAt,
    }),
  );
}

// ---------------------------------------------------------------------------
// Adapter callbacks for the shared useRemovedSection hook.
// ---------------------------------------------------------------------------

/** Conversations count thread groups (not individual rows). */
const computeMessageCount = (_rows: RemovedMessageRow[], groups: RemovedThread[]): number =>
  groups.length;

/**
 * Stable per-card key across refetches. Uses the SORTED set of constituent
 * ignored_ids so the key is order-independent (a merged card keeps the same key
 * regardless of row fetch order).
 */
const messageGroupKey = (thread: RemovedThread): string =>
  thread.ignoredIds.slice().sort().join("|");

const removeRestoredMessageRows = (
  rows: RemovedMessageRow[],
  thread: RemovedThread
): RemovedMessageRow[] => {
  const removed = new Set(thread.ignoredIds);
  return rows.filter((r) => !removed.has(r.ignored_id));
};

export function RemovedMessagesSection({
  transactionId,
  onRestoreComplete,
  onMessagesChanged,
  contactNames = {},
  onShowSuccess,
  onShowError,
  onContactNamesResolved,
  isOpen: externalIsOpen,
  onOpenChange,
  refreshKey,
}: RemovedMessagesSectionProps): React.ReactElement | null {
  // Message-specific data fetch — reject on unavailable/failure so the shared
  // hook applies the correct spinner-vs-silent failure behaviour.
  const fetchRows = useCallback(
    async (txId: string): Promise<RemovedMessageRow[]> => {
      if (!window.api?.transactions?.getRemovedMessages) {
        throw new Error("getRemovedMessages unavailable");
      }
      const result = await window.api.transactions.getRemovedMessages(txId);
      if (result.success) return result.removedMessages ?? [];
      throw new Error(result.error || "Failed to fetch removed messages");
    },
    []
  );

  const restoreGroup = useCallback(
    async (thread: RemovedThread): Promise<RemovedRestoreResult> => {
      // BACKLOG-2263: the restore IPC removes exactly ONE ignored_communications
      // row per call, so a contact-merged card must restore EACH constituent
      // ignored_id (with that row's own message_ids) or leftover suppression
      // records would re-hide the other threads on the next auto-link.
      let restoredTotal = 0;
      let firstError: string | null = null;

      for (const ignoredId of thread.ignoredIds) {
        const messageIds = thread.messages
          .filter((m) => m.ignored_id === ignoredId)
          .map((m) => m.message_id);
        if (messageIds.length === 0) continue;

        try {
          const result = await window.api.transactions.restoreRemovedMessage(
            ignoredId,
            messageIds,
            transactionId
          );
          if (result.success) {
            restoredTotal += messageIds.length;
          } else if (!firstError) {
            firstError = result.error || null;
          }
        } catch (err) {
          if (!firstError) firstError = err instanceof Error ? err.message : null;
        }
      }

      if (firstError && restoredTotal === 0) {
        return { success: false, error: firstError };
      }
      return { success: true, restoredCount: restoredTotal };
    },
    [transactionId]
  );

  // BACKLOG-1589: resolve contact names for removed message handles so phone
  // numbers display as contact names. Runs after every successful fetch.
  const onRowsFetched = useCallback(
    async (rows: RemovedMessageRow[]) => {
      if (!onContactNamesResolved || rows.length === 0) return;
      const messageLike = mapToMessageLike(rows);
      const handles = extractAllHandles(messageLike);
      if (handles.length === 0) return;
      try {
        const nameResult = await window.api.contacts.resolveHandles(handles);
        if (nameResult.success && nameResult.names) {
          const namesWithNormalized: Record<string, string> = {};
          Object.entries(nameResult.names as Record<string, string>).forEach(([handle, name]) => {
            namesWithNormalized[handle] = name;
            const isPhone = handle.startsWith("+") || /^\d[\d\s\-()]{6,}$/.test(handle);
            if (isPhone) {
              const normalized = handle.replace(/\D/g, "").slice(-10);
              if (normalized.length >= 7) {
                namesWithNormalized[normalized] = name;
              }
            }
            if (handle.includes("@")) {
              namesWithNormalized[handle.toLowerCase()] = name;
            }
          });
          onContactNamesResolved(namesWithNormalized);
        }
      } catch (err) {
        logger.error("Failed to resolve removed message contact names:", err);
      }
    },
    [onContactNamesResolved]
  );

  // BACKLOG-2263: contact-merge the removed rows using the SAME identity rule as
  // the attached list. Re-runs when resolved contactNames change (async name
  // resolution) so cards collapse as names arrive.
  const groupRows = useCallback(
    (rows: RemovedMessageRow[]): RemovedThread[] => groupByContact(rows, contactNames),
    [contactNames]
  );

  const {
    isOpen,
    loading,
    groups,
    totalCount,
    restoringId,
    handleToggle,
    handleRestore,
    selectionMode,
    enterSelectionMode,
    exitSelectionMode,
    selectedCount,
    isGroupSelected,
    toggleGroupSelection,
    selectAllGroups,
    deselectAllGroups,
    bulkRestore,
    isBulkRestoring,
  } = useRemovedSection<RemovedMessageRow, RemovedThread>({
      transactionId,
      isOpen: externalIsOpen,
      onOpenChange,
      refreshKey,
      fetchRows,
      groupRows,
      computeCount: computeMessageCount,
      restoreGroup,
      removeRestoredRows: removeRestoredMessageRows,
      getRestoreKey: messageGroupKey,
      // BACKLOG-1793: silent refresh (no loading cycle). Falls back to the full
      // refresh only when the parent doesn't supply the silent one.
      onRestoreComplete: onRestoreComplete ?? onMessagesChanged,
      onRowsFetched,
      onShowSuccess,
      onShowError,
      successMessage: () => "Conversation restored successfully",
      // BACKLOG-1719: bulk restore counts conversations (thread groups).
      bulkSuccessMessage: (_restoredTotal, groupCount) =>
        groupCount > 1 ? `${groupCount} conversations restored` : "Conversation restored successfully",
      errorMessage: "Failed to restore conversation",
      logLabel: "removed messages",
    });

  const renderGroup = (thread: RemovedThread): React.ReactNode => {
    const messageLikeMessages = mapToMessageLike(thread.messages);
    const phoneNumber = extractPhoneFromRemovedThread(thread);
    const messageCount = thread.messages.length;

    return (
      <div>
        <MessageThreadCard
          threadId={thread.threadId || thread.ignoredId}
          messages={messageLikeMessages}
          phoneNumber={phoneNumber}
          contactName={contactNames[phoneNumber] || contactNames[phoneNumber.replace(/\D/g, '').slice(-10)] || undefined}
          contactNames={contactNames}
          isRemoved={true}
          onRestore={() => handleRestore(thread)}
          isRestoring={restoringId === messageGroupKey(thread)}
        />
        {/* Removal metadata below the card */}
        <div className="flex items-center gap-3 -mt-2 mb-3 ml-1 text-xs text-gray-400">
          <span>
            {messageCount} message{messageCount !== 1 ? "s" : ""}
          </span>
          {thread.ignoredAt && (
            <span>
              Removed {formatRemovedDate(thread.ignoredAt)}
            </span>
          )}
          {thread.reason && (
            <span className="truncate max-w-[200px]" title={thread.reason}>
              {thread.reason}
            </span>
          )}
        </div>
      </div>
    );
  };

  return (
    <RemovedItemsSection<RemovedThread>
      isOpen={isOpen}
      onToggle={handleToggle}
      loading={loading}
      groups={groups}
      totalCount={totalCount}
      emptyToggleLabel="Show removed conversations"
      loadingLabel="Loading removed conversations..."
      emptyMessage="No removed conversations found."
      toggleTestId="show-removed-messages-toggle"
      sectionTestId="removed-messages-section"
      getGroupKey={messageGroupKey}
      renderGroup={renderGroup}
      selectionMode={selectionMode}
      onEnterSelectionMode={enterSelectionMode}
      onExitSelectionMode={exitSelectionMode}
      isGroupSelected={isGroupSelected}
      onToggleGroupSelect={toggleGroupSelection}
      selectedCount={selectedCount}
      onSelectAll={selectAllGroups}
      onDeselectAll={deselectAllGroups}
      onBulkRestore={bulkRestore}
      isBulkRestoring={isBulkRestoring}
      bulkActionLabel="Restore"
      selectEntryTestId="select-removed-messages"
    />
  );
}
