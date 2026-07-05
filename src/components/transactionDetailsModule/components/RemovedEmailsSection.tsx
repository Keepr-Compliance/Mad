/**
 * RemovedEmailsSection Component (BACKLOG-1578)
 * Shows a collapsible section at the bottom of the email thread list
 * that displays previously unlinked/removed emails.
 * Users can view removed emails and optionally restore them.
 *
 * BACKLOG-1766: Removed emails that share a thread_id are grouped into one
 * card (matching the thread-grouped presentation of the main email list).
 *
 * BACKLOG-1793: The removed-section machinery (controlled-open, mount-rehydrate,
 * refreshKey, restore + silent refresh) now lives in the shared useRemovedSection
 * hook + RemovedItemsSection shell. This component is a thin EMAIL adapter that
 * provides the email-specific data shape, grouping, restore call and card
 * rendering. The Texts tab consumes the same shared code path.
 */
import React, { useState, useCallback } from "react";
import { resolveDisplayName } from "../../../utils/emailParticipantUtils";
import type { Communication } from "../types";
import type { EmailThread } from "./EmailThreadCard";
import { EmailThreadViewModal } from "./modals";
import { RemovedItemsSection } from "./RemovedItemsSection";
import { useRemovedSection, type RemovedRestoreResult } from "../hooks/useRemovedSection";

/** Shape of a removed email row from the IPC handler */
interface RemovedEmailRow {
  ignored_id: string;
  ic_email_id: string | null;
  reason: string | null;
  ignored_at: string;
  email_id: string;
  subject: string | null;
  sender: string | null;
  recipients: string | null;
  cc: string | null;
  sent_at: string | null;
  thread_id: string | null;
  body_preview: string | null;
  body_plain: string | null;
  has_attachments: boolean | number | null;
  source: string | null;
}

interface RemovedEmailsSectionProps {
  transactionId: string;
  /**
   * BACKLOG-1780: called on successful restore. Uses refreshCommunicationsSilently
   * in TransactionDetails — no loading flag, no spinner, scroll never moves.
   * Separate from onEmailsChanged (attach flow) so the attach path is unchanged.
   */
  onRestoreComplete?: () => Promise<void>;
  /** Toast handlers */
  onShowSuccess?: (message: string) => void;
  onShowError?: (message: string) => void;
  /** User's email address for filtering from participant display */
  userEmail?: string;
  /**
   * BACKLOG-1762: lowercase email -> contact display_name map. Resolves the
   * sender / recipient names from Contacts when the header carries no name.
   */
  nameMap?: ReadonlyMap<string, string>;
  /**
   * BACKLOG-1780: externally controlled open state so the parent can lift this
   * up above the loading spinner and keep the section expanded across refetches.
   */
  isOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  /**
   * BACKLOG-1780: increment this after each successful unlink to trigger a
   * silent re-fetch of the removed list (updates the count label in place).
   */
  refreshKey?: number;
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
 * Extract a display name from a sender string.
 * Handles formats like "Name <email@example.com>" or plain "email@example.com".
 */
function extractSenderDisplay(sender: string | null): string {
  if (!sender) return "Unknown";
  // Try to extract name from "Name <email>" format
  const match = sender.match(/^([^<]+)\s*</);
  if (match) {
    return match[1].trim();
  }
  // Plain email - show the part before @
  const atIndex = sender.indexOf("@");
  if (atIndex > 0) {
    return sender.substring(0, atIndex);
  }
  return sender;
}

/**
 * Get the first letter for the avatar.
 */
function getAvatarInitial(sender: string | null): string {
  const display = extractSenderDisplay(sender);
  return display.charAt(0).toUpperCase() || "?";
}

/**
 * A group of removed emails that share a thread_id (or a singleton if thread_id is null).
 * BACKLOG-1766: display-layer grouping — no schema change.
 */
interface RemovedEmailGroup {
  /** Shared thread_id, or null for single emails without a thread. */
  threadId: string | null;
  /** Members of this group, sorted newest-first by sent_at. */
  emails: RemovedEmailRow[];
}

/**
 * Group removed email rows by thread_id.
 * Emails with the same non-null thread_id form one group; others are singletons.
 * Groups preserve the insertion order of their first member.
 */
function groupRemovedEmailsByThread(emails: RemovedEmailRow[]): RemovedEmailGroup[] {
  const threadMap = new Map<string, RemovedEmailRow[]>();
  const singletons: RemovedEmailRow[] = [];
  const order: string[] = [];

  for (const email of emails) {
    if (email.thread_id) {
      if (!threadMap.has(email.thread_id)) {
        order.push(email.thread_id);
        threadMap.set(email.thread_id, []);
      }
      threadMap.get(email.thread_id)!.push(email);
    } else {
      singletons.push(email);
    }
  }

  const groups: RemovedEmailGroup[] = [];

  for (const tid of order) {
    const members = threadMap.get(tid)!.slice().sort((a, b) => {
      const dateA = a.sent_at ? new Date(a.sent_at).getTime() : 0;
      const dateB = b.sent_at ? new Date(b.sent_at).getTime() : 0;
      return dateB - dateA; // newest first
    });
    groups.push({ threadId: tid, emails: members });
  }

  for (const email of singletons) {
    groups.push({ threadId: null, emails: [email] });
  }

  return groups;
}

/**
 * Convert a RemovedEmailGroup to a synthetic EmailThread so we can reuse
 * EmailThreadViewModal for read-only viewing of removed emails.
 * Maps RemovedEmailRow fields to the subset of Communication/Message that the
 * modal reads for display (sender, recipients, cc, sent_at, body_text, etc.).
 */
function groupToEmailThread(group: RemovedEmailGroup): EmailThread {
  const comms: Communication[] = group.emails.map((r) => ({
    id: r.email_id,
    user_id: "",
    created_at: r.ignored_at,
    has_attachments: !!r.has_attachments,
    is_false_positive: false,
    subject: r.subject ?? undefined,
    sender: r.sender ?? undefined,
    recipients: r.recipients ?? undefined,
    cc: r.cc ?? undefined,
    sent_at: r.sent_at ?? undefined,
    thread_id: r.thread_id ?? undefined,
    body_text: r.body_plain ?? undefined,
    body_plain: r.body_plain ?? undefined,
  }));

  // Sort chronologically (oldest first) for the modal's conversation view
  const sorted = [...comms].sort((a, b) => {
    const da = a.sent_at ? new Date(a.sent_at).getTime() : 0;
    const db = b.sent_at ? new Date(b.sent_at).getTime() : 0;
    return da - db;
  });

  // Collect unique participants for thread metadata
  const seen = new Set<string>();
  const participants: string[] = [];
  for (const r of group.emails) {
    const add = (raw: string | null) => {
      if (!raw) return;
      raw.split(",").map(s => s.trim()).filter(Boolean).forEach(p => {
        if (!seen.has(p)) { seen.add(p); participants.push(p); }
      });
    };
    add(r.sender);
    add(r.recipients);
    add(r.cc);
  }

  return {
    id: group.threadId ?? `removed-${group.emails[0].email_id}`,
    subject: group.emails[0].subject || "(No Subject)",
    participants,
    emailCount: sorted.length,
    startDate: new Date(sorted[0]?.sent_at || 0),
    endDate: new Date(sorted[sorted.length - 1]?.sent_at || 0),
    emails: sorted,
  };
}

// ---------------------------------------------------------------------------
// Adapter callbacks for the shared useRemovedSection hook. Module-level where
// possible so their identity is stable across renders.
// ---------------------------------------------------------------------------

/** Emails count individual messages (not thread groups). */
const computeEmailCount = (rows: RemovedEmailRow[]): number => rows.length;

/** The representative row for a group is its newest member (index 0). */
const emailRestoreKey = (group: RemovedEmailGroup): string => group.emails[0].ignored_id;

const emailGroupKey = (group: RemovedEmailGroup): string =>
  group.threadId ?? group.emails[0].ignored_id;

/**
 * In-place removal after a restore. Backend (R4) restores the whole thread, so
 * purge all siblings sharing the representative's thread_id; otherwise drop the
 * single ignored record.
 */
const removeRestoredEmailRows = (
  rows: RemovedEmailRow[],
  group: RemovedEmailGroup
): RemovedEmailRow[] => {
  const representative = group.emails[0];
  if (representative.thread_id) {
    return rows.filter((e) => e.thread_id !== representative.thread_id);
  }
  return rows.filter((e) => e.ignored_id !== representative.ignored_id);
};

const emailSuccessMessage = (count: number): string =>
  count > 1 ? `${count} emails restored` : "Email restored successfully";

/** BACKLOG-1719: toast for a bulk restore — counts underlying emails restored. */
const emailBulkSuccessMessage = (restoredTotal: number): string =>
  restoredTotal > 1 ? `${restoredTotal} emails restored` : "Email restored successfully";

export function RemovedEmailsSection({
  transactionId,
  onRestoreComplete,
  onShowSuccess,
  onShowError,
  userEmail,
  nameMap,
  isOpen: externalIsOpen,
  onOpenChange,
  refreshKey,
}: RemovedEmailsSectionProps): React.ReactElement | null {
  // BACKLOG-1780: group selected for read-only modal view
  const [viewingGroup, setViewingGroup] = useState<RemovedEmailGroup | null>(null);

  // Email-specific data fetch — reject when unavailable / backend failure so the
  // shared hook applies the correct spinner-vs-silent failure behaviour.
  const fetchRows = useCallback(
    async (txId: string): Promise<RemovedEmailRow[]> => {
      if (!window.api?.transactions?.getRemovedEmails) {
        throw new Error("getRemovedEmails unavailable");
      }
      const result = await window.api.transactions.getRemovedEmails(txId);
      if (result.success) return result.removedEmails ?? [];
      throw new Error(result.error || "Failed to fetch removed emails");
    },
    []
  );

  const restoreGroup = useCallback(
    async (group: RemovedEmailGroup): Promise<RemovedRestoreResult> => {
      const representative = group.emails[0];
      return window.api.transactions.restoreRemovedEmail(
        representative.ignored_id,
        representative.email_id,
        transactionId
      );
    },
    [transactionId]
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
  } = useRemovedSection<RemovedEmailRow, RemovedEmailGroup>({
      transactionId,
      isOpen: externalIsOpen,
      onOpenChange,
      refreshKey,
      fetchRows,
      groupRows: groupRemovedEmailsByThread,
      computeCount: computeEmailCount,
      restoreGroup,
      removeRestoredRows: removeRestoredEmailRows,
      getRestoreKey: emailRestoreKey,
      onRestoreComplete,
      onShowSuccess,
      onShowError,
      successMessage: emailSuccessMessage,
      bulkSuccessMessage: emailBulkSuccessMessage,
      errorMessage: "Failed to restore email",
      logLabel: "removed emails",
    });

  // Filter out user's own email from recipients for display.
  // BACKLOG-1762: resolve each remaining recipient to a contact display name
  // (header name > contact name > bare address).
  const formatRecipients = (recipients: string | null): string => {
    if (!recipients) return "";
    const parts = recipients.split(",").map((r) => r.trim()).filter(Boolean);
    let visible = parts;
    if (userEmail) {
      const filtered = parts.filter((r) => {
        const emailMatch = r.match(/<([^>]+)>/);
        const addr = emailMatch ? emailMatch[1] : r;
        return addr.toLowerCase() !== userEmail.toLowerCase();
      });
      if (filtered.length > 0) visible = filtered;
    }
    return visible.map((r) => resolveDisplayName(r, nameMap)).join(", ");
  };

  const renderGroup = (group: RemovedEmailGroup): React.ReactNode => {
    // Representative email: newest member (index 0 after newest-first sort)
    const representative = group.emails[0];
    const isThread = group.emails.length > 1;
    const bodyPreview = representative.body_preview || representative.body_plain?.substring(0, 200) || null;

    // For thread groups: show date range from oldest to newest
    const oldestEmail = isThread ? group.emails[group.emails.length - 1] : null;
    const dateLabel = isThread && oldestEmail?.sent_at && representative.sent_at
      ? `${formatRemovedDate(oldestEmail.sent_at)} – ${formatRemovedDate(representative.sent_at)}`
      : representative.sent_at
      ? formatRemovedDate(representative.sent_at)
      : null;

    const isRestoring = restoringId === representative.ignored_id;

    return (
      <div>
        {/* Card: same design as EmailThreadCard (BACKLOG-1780 design request) */}
        <div
          className="bg-white rounded-lg border border-gray-200 mb-3 overflow-hidden hover:bg-gray-50 transition-colors"
          data-testid="removed-email-card"
        >
          <div className="bg-gray-50 px-3 py-3 sm:px-4 flex items-center justify-between gap-2">
            <div className="flex items-center gap-2 sm:gap-3 min-w-0 flex-1">
              {/* Avatar - gray for removed (only visual distinction from active card) */}
              <div className="w-8 h-8 bg-gradient-to-br from-gray-400 to-gray-500 rounded-full flex items-center justify-center text-white font-semibold text-sm flex-shrink-0">
                {getAvatarInitial(representative.sender)}
              </div>

              {/* Email / thread info — same structure as EmailThreadCard */}
              <div className="min-w-0 flex-1">
                <div data-testid="thread-subject">
                  <span className="font-semibold text-gray-900 block truncate text-sm sm:text-base">
                    {representative.subject || "(No Subject)"}
                  </span>
                  <span className="font-normal text-gray-500 text-xs sm:text-sm block truncate">
                    {resolveDisplayName(representative.sender ?? "", nameMap)}
                    {representative.recipients && (
                      <span className="text-gray-400">
                        {" "}to {formatRecipients(representative.recipients)}
                      </span>
                    )}
                    {isThread && (
                      <span className="ml-2 text-gray-400">
                        ({group.emails.length} emails)
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

            {/* Actions: attachment, date, view button, restore button */}
            <div className="flex items-center gap-2 sm:gap-4 flex-shrink-0">
              {representative.has_attachments ? (
                <svg className="w-4 h-4 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.172 7l-6.586 6.586a2 2 0 102.828 2.828l6.414-6.586a4 4 0 00-5.656-5.656l-6.415 6.585a6 6 0 108.486 8.486L20.5 13" />
                </svg>
              ) : null}
              {dateLabel && (
                <span className="text-sm text-gray-500 hidden sm:inline">
                  {dateLabel}
                </span>
              )}
              {/* View button — opens read-only thread modal (audit context) */}
              <button
                type="button"
                onClick={() => setViewingGroup(group)}
                className="text-sm font-medium text-blue-600 hover:text-blue-800 transition-colors whitespace-nowrap"
                data-testid="view-removed-email-button"
              >
                {isThread ? "View Thread →" : "View"}
              </button>
              {/* Restore button — icon button, green hover (mirrors delete button style) */}
              <button
                type="button"
                onClick={() => handleRestore(group)}
                disabled={isRestoring}
                className="text-gray-400 hover:text-green-600 hover:bg-green-50 rounded p-1 transition-all disabled:opacity-50"
                title="Restore to transaction"
                data-testid="restore-email-button"
              >
                {isRestoring ? (
                  <svg className="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                  </svg>
                ) : (
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    {/* Arrow-uturn-left: undo/restore semantic */}
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 15L3 9m0 0l6-6M3 9h12a6 6 0 010 12h-3" />
                  </svg>
                )}
              </button>
            </div>
          </div>
        </div>

        {/* Removal metadata below the card */}
        <div className="flex items-center gap-3 mb-3 ml-1 text-xs text-gray-400">
          {representative.ignored_at && (
            <span>
              Removed {formatRemovedDate(representative.ignored_at)}
            </span>
          )}
          {representative.reason && (
            <span className="truncate max-w-[200px]" title={representative.reason}>
              {representative.reason}
            </span>
          )}
        </div>
      </div>
    );
  };

  return (
    <>
      <RemovedItemsSection<RemovedEmailGroup>
        isOpen={isOpen}
        onToggle={handleToggle}
        loading={loading}
        groups={groups}
        totalCount={totalCount}
        emptyToggleLabel="Show removed emails"
        loadingLabel="Loading removed emails..."
        emptyMessage="No removed emails found."
        toggleTestId="show-removed-emails-toggle"
        sectionTestId="removed-emails-section"
        getGroupKey={emailGroupKey}
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
        selectEntryTestId="select-removed-emails"
      />
      {/* BACKLOG-1780: read-only view modal for removed emails */}
      {viewingGroup && (
        <EmailThreadViewModal
          thread={groupToEmailThread(viewingGroup)}
          onClose={() => setViewingGroup(null)}
          userEmail={userEmail}
          nameMap={nameMap}
        />
      )}
    </>
  );
}
