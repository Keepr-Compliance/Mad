/**
 * ConversationViewModal Component
 * Phone-style popup modal for viewing a full conversation thread.
 * Supports inline display of image/GIF attachments (TASK-1012).
 */
import React, { useEffect, useState, useRef } from "react";
import { ResponsiveModal } from "../../../common/ResponsiveModal";
import type { MessageLike } from "../MessageThreadCard";
import { parseDateSafe } from "../../../../utils/dateFormatters";
import { normalizePhoneForLookup, getSenderPhone } from "../../../../utils/phoneNormalization";
import { formatDateRangeLabel } from "../../../../utils/dateRangeUtils";
import { isEmptyOrReplacementChar, formatMessageTime } from "../../../../utils/messageFormatUtils";
import logger from '../../../../utils/logger';

/**
 * Attachment info for display (TASK-1012)
 */
interface MessageAttachmentInfo {
  id: string;
  message_id: string;
  filename: string;
  mime_type: string | null;
  file_size_bytes: number | null;
  data: string | null;
}

interface ConversationViewModalProps {
  /** Messages in the thread */
  messages: MessageLike[];
  /** Contact name for header */
  contactName?: string;
  /** Phone number for header */
  phoneNumber: string;
  /** Map of phone -> name for group chat sender resolution */
  contactNames?: Record<string, string>;
  /** Audit period start date for filtering */
  auditStartDate?: Date | string | null;
  /** Audit period end date for filtering */
  auditEndDate?: Date | string | null;
  /** Callback to close the modal */
  onClose: () => void;
  /**
   * BACKLOG-1935: when provided, renders a "See transaction" button in the
   * footer that jumps to this thread's owning transaction. Only supplied by the
   * contact card, and only when the thread is actually linked to a transaction —
   * omitted for the MessageThreadCard usage and for non-linked threads, so that
   * existing behaviour is byte-for-byte identical (additive, mirrors
   * EmailViewModal.onSeeTransaction in BACKLOG-1934).
   */
  onSeeTransaction?: () => void;
}

// normalizePhoneForLookup and getSenderPhone imported from src/utils/phoneNormalization.ts (TASK-2027)

/**
 * Check if a MIME type is a displayable image
 */
function isDisplayableImage(mimeType: string | null): boolean {
  if (!mimeType) return false;
  return (
    mimeType.startsWith("image/") &&
    !mimeType.includes("heic") // HEIC requires conversion
  );
}

/**
 * Get a human-readable label for an attachment MIME type
 */
function getAttachmentLabel(mimeType: string | null, filename: string): string {
  if (mimeType?.startsWith("video/")) return "Video";
  if (mimeType?.startsWith("audio/")) return "Audio";
  if (mimeType?.startsWith("image/")) return "Image";
  if (mimeType === "application/pdf") return "PDF";
  if (mimeType?.includes("word") || mimeType?.includes("document")) return "Document";

  // Fall back to extension
  const ext = filename.toLowerCase().split(".").pop() || "";
  const labels: Record<string, string> = {
    mp4: "Video", mov: "Video", m4v: "Video",
    mp3: "Audio", m4a: "Audio", caf: "Voice Message",
    pdf: "PDF", doc: "Document", docx: "Document",
  };
  return labels[ext] || "Attachment";
}

/**
 * Attachment image component with loading state and error handling
 */
function AttachmentImage({
  attachment,
  isOutbound,
}: {
  attachment: MessageAttachmentInfo;
  isOutbound: boolean;
}): React.ReactElement | null {
  const [imageError, setImageError] = useState(false);
  const [isLoading, setIsLoading] = useState(true);

  if (!attachment.data || imageError) {
    // Show placeholder for missing/failed attachments
    return (
      <div
        className={`text-xs italic ${isOutbound ? "text-green-100" : "text-gray-400"}`}
      >
        [Image: {attachment.filename || "attachment"}]
      </div>
    );
  }

  const mimeType = attachment.mime_type || "image/jpeg";
  const dataUrl = `data:${mimeType};base64,${attachment.data}`;

  return (
    <div className="relative">
      {isLoading && (
        <div className="absolute inset-0 flex items-center justify-center bg-gray-100 rounded">
          <div className="w-4 h-4 border-2 border-gray-300 border-t-gray-600 rounded-full animate-spin" />
        </div>
      )}
      <img
        src={dataUrl}
        alt={attachment.filename || "Attachment"}
        className="max-w-full max-h-48 sm:max-h-64 rounded-lg cursor-pointer hover:opacity-90 transition-opacity"
        onLoad={() => setIsLoading(false)}
        onError={() => {
          setIsLoading(false);
          setImageError(true);
        }}
        onClick={() => {
          // Open in new window for full-size view
          const win = window.open("", "_blank");
          if (win) {
            win.document.write(`<img src="${dataUrl}" style="max-width: 100%; height: auto;" />`);
          }
        }}
      />
    </div>
  );
}

export function ConversationViewModal({
  messages,
  contactName,
  phoneNumber,
  contactNames = {},
  auditStartDate,
  auditEndDate,
  onClose,
  onSeeTransaction,
}: ConversationViewModalProps): React.ReactElement {
  // Attachments state (TASK-1012)
  const [attachmentsMap, setAttachmentsMap] = useState<
    Record<string, MessageAttachmentInfo[]>
  >({});
  const [attachmentsLoading, setAttachmentsLoading] = useState(false);
  const loadedAttachmentsKeyRef = useRef<string>("");

  // TASK-1157: Audit date filtering state
  // TASK-1795: Uses parseDateSafe from utils for Windows timezone handling
  const parsedStartDate = parseDateSafe(auditStartDate, 'ConversationViewModal');
  const parsedEndDate = parseDateSafe(auditEndDate, 'ConversationViewModal');
  // Show filter if at least one date is set (handles ongoing transactions with only start date)
  const hasAuditDates = !!(parsedStartDate || parsedEndDate);

  // Default to showing audit period only when dates are available
  const [showAuditPeriodOnly, setShowAuditPeriodOnly] = useState<boolean>(hasAuditDates);

  // TASK-1794: Sort messages newest-first (reverse chronological)
  const sortedMessages = [...messages].sort((a, b) => {
    const dateA = new Date(a.sent_at || a.received_at || 0).getTime();
    const dateB = new Date(b.sent_at || b.received_at || 0).getTime();
    return dateB - dateA; // Newest first
  });

  // TASK-1157: Filter messages by audit date range
  const filteredMessages = React.useMemo(() => {
    if (!showAuditPeriodOnly || !hasAuditDates) {
      return sortedMessages;
    }

    return sortedMessages.filter((msg) => {
      // Use parseDateSafe for consistent timezone handling (Windows-safe)
      const msgDate = parseDateSafe(msg.sent_at || msg.received_at) || new Date(0);

      // Check start date (if set)
      if (parsedStartDate && msgDate < parsedStartDate) {
        return false;
      }

      // Check end date (if set) - use end of day for inclusive comparison
      if (parsedEndDate) {
        const endOfDay = new Date(parsedEndDate);
        endOfDay.setHours(23, 59, 59, 999);
        if (msgDate > endOfDay) {
          return false;
        }
      }

      return true;
    });
  }, [sortedMessages, showAuditPeriodOnly, hasAuditDates, parsedStartDate, parsedEndDate]);

  // Collect unique participants from all sources (not just inbound senders)
  const uniqueSenders = new Set<string>();
  messages.forEach((msg) => {
    try {
      if (msg.participants) {
        const parsed =
          typeof msg.participants === "string"
            ? JSON.parse(msg.participants)
            : msg.participants;

        // Collect from chat_members (authoritative list of other participants)
        if (parsed.chat_members && Array.isArray(parsed.chat_members)) {
          parsed.chat_members.forEach((m: string) => {
            if (m && m !== "unknown") uniqueSenders.add(normalizePhoneForLookup(m));
          });
        }

        // Collect from inbound message sender
        if (msg.direction === "inbound" && parsed.from) {
          if (parsed.from !== "me" && parsed.from !== "unknown") {
            uniqueSenders.add(normalizePhoneForLookup(parsed.from));
          }
        }

        // Collect from outbound message recipients
        if (msg.direction === "outbound" && parsed.to) {
          const toList = Array.isArray(parsed.to) ? parsed.to : [parsed.to];
          toList.forEach((p: string) => {
            if (p && p !== "me" && p !== "unknown") {
              uniqueSenders.add(normalizePhoneForLookup(p));
            }
          });
        }
      }
    } catch {
      // Continue
    }
  });

  // Resolve senders to names and deduplicate
  const resolveToName = (normalizedPhone: string): string => {
    for (const [phone, name] of Object.entries(contactNames)) {
      if (normalizePhoneForLookup(phone) === normalizedPhone) {
        return name;
      }
    }
    // Find original phone format for display
    for (const msg of messages) {
      const msgSender = getSenderPhone(msg);
      if (msgSender && normalizePhoneForLookup(msgSender) === normalizedPhone) {
        return msgSender;
      }
    }
    return normalizedPhone;
  };

  // Get unique participant names (deduplicated by resolved name)
  const uniqueParticipantNames = [...new Set(
    Array.from(uniqueSenders).map(resolveToName)
  )];

  // Group chat = more than one unique participant (by resolved name)
  const isGroupChat = uniqueParticipantNames.length > 1;

  /**
   * Get title for group chat header.
   * Shows participant names (up to 3) with "+X more" for larger groups.
   */
  const getGroupChatTitle = (): string => {
    if (uniqueParticipantNames.length === 0) {
      return `Group (${uniqueSenders.size} participants)`;
    }

    // Show up to 3 names, then "+X more"
    if (uniqueParticipantNames.length <= 3) {
      return uniqueParticipantNames.join(", ");
    }
    return `${uniqueParticipantNames.slice(0, 3).join(", ")} +${uniqueParticipantNames.length - 3} more`;
  };

  // Load attachments for messages that have them (TASK-1012)
  // Create stable key from message IDs to prevent re-fetching
  const attachmentsKey = messages
    .filter((msg) => msg.has_attachments && msg.message_id)
    .map((msg) => msg.message_id)
    .sort()
    .join(",");

  useEffect(() => {
    // Skip if we've already loaded for this key
    if (attachmentsKey === loadedAttachmentsKeyRef.current || !attachmentsKey) {
      return;
    }

    const messageIdsWithAttachments = attachmentsKey.split(",");
    loadedAttachmentsKeyRef.current = attachmentsKey;

    const loadAttachments = async () => {
      setAttachmentsLoading(true);
      try {
        // Check if API is available (may not be on all platforms)
        if (window.api?.messages?.getMessageAttachmentsBatch) {
          const result = await window.api.messages.getMessageAttachmentsBatch(
            messageIdsWithAttachments
          );
          setAttachmentsMap(result);
        }
      } catch (error) {
        logger.error("Failed to load attachments:", error);
      } finally {
        setAttachmentsLoading(false);
      }
    };

    loadAttachments();
  }, [attachmentsKey]);

  return (
    <ResponsiveModal onClose={onClose} zIndex="z-[80]" overlayClassName="bg-black bg-opacity-50" panelBg="bg-gray-100" panelClassName="max-w-md sm:h-[600px] sm:rounded-2xl sm:overflow-hidden">
        {/* Phone-style header */}
        <div className="bg-gradient-to-r from-green-500 to-teal-600 px-4 py-3 flex items-center gap-3">
          <button
            onClick={onClose}
            className="text-white hover:bg-white hover:bg-opacity-20 rounded-full p-1 transition-colors"
          >
            <svg
              className="w-5 h-5"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M6 18L18 6M6 6l12 12"
              />
            </svg>
          </button>
          <div className="flex-1">
            <h4 className="text-white font-semibold">
              {isGroupChat ? getGroupChatTitle() : (contactName || phoneNumber)}
            </h4>
            <p className="text-green-100 text-xs">
              {filteredMessages.length} message{filteredMessages.length !== 1 ? "s" : ""}
              {showAuditPeriodOnly && hasAuditDates && filteredMessages.length !== sortedMessages.length && (
                <span className="ml-1">of {sortedMessages.length}</span>
              )}
            </p>
          </div>
        </div>

        {/* TASK-1157: Audit date filter toggle */}
        {hasAuditDates && (
          <div className="bg-gray-100 px-4 py-2 flex items-center justify-between border-b border-gray-200">
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={showAuditPeriodOnly}
                onChange={(e) => setShowAuditPeriodOnly(e.target.checked)}
                className="w-5 h-5 rounded border-gray-300 text-green-500 focus:ring-green-500"
              />
              <span className="text-sm text-gray-700">
                Show audit period only ({formatDateRangeLabel(parsedStartDate, parsedEndDate)})
              </span>
            </label>
            <span className="text-xs text-gray-500">
              Showing {filteredMessages.length} of {sortedMessages.length}
            </span>
          </div>
        )}

        {/* Messages list - phone style */}
        <div className="flex-1 overflow-y-auto p-4 space-y-3">
          {filteredMessages.map((msg, index) => {
            const isOutbound = msg.direction === "outbound";
            const rawText =
              msg.body_text ||
              msg.body_plain ||
              ("body" in msg ? (msg as { body?: string }).body : "") ||
              "";

            const msgText = rawText;
            const msgTime = new Date(msg.sent_at || msg.received_at || 0);

            // Get sender info for group chats
            const senderPhone = getSenderPhone(msg);
            let senderName: string | undefined;
            let showSender = false;

            if (isGroupChat && senderPhone && !isOutbound) {
              const normalized = normalizePhoneForLookup(senderPhone);
              senderName =
                contactNames[senderPhone] ||
                contactNames[normalized] ||
                senderPhone;

              // Show sender if different from previous message
              if (index === 0) {
                showSender = true;
              } else {
                const prevSender = getSenderPhone(filteredMessages[index - 1]);
                if (prevSender) {
                  const prevNormalized = normalizePhoneForLookup(prevSender);
                  showSender = normalized !== prevNormalized;
                } else {
                  showSender = true;
                }
              }
            }

            // Get attachments for this message (TASK-1012)
            // Use message_id to look up attachments (attachments table uses message_id, not communication id)
            const messageAttachments = msg.message_id ? (attachmentsMap[msg.message_id] || []) : [];
            const displayableAttachments = messageAttachments.filter((att) =>
              isDisplayableImage(att.mime_type)
            );
            const nonDisplayableAttachments = messageAttachments.filter((att) =>
              !isDisplayableImage(att.mime_type)
            );

            // Check if message text is empty or just replacement character
            const hasRealText = !isEmptyOrReplacementChar(msgText);

            return (
              <div
                key={msg.id}
                className={`flex ${isOutbound ? "justify-end" : "justify-start"}`}
              >
                <div
                  className={`max-w-[85%] sm:max-w-[80%] rounded-2xl px-3 py-2 sm:px-4 ${
                    isOutbound
                      ? "bg-green-500 text-white rounded-br-md"
                      : "bg-white text-gray-900 rounded-bl-md shadow-sm"
                  }`}
                >
                  {showSender && senderName && (
                    <p
                      className="text-xs font-semibold text-green-600 mb-1"
                      data-testid="group-message-sender"
                    >
                      {senderName}
                    </p>
                  )}
                  {/* Display inline images (TASK-1012) */}
                  {displayableAttachments.length > 0 && (
                    <div className="mb-2 space-y-2">
                      {displayableAttachments.map((att) => (
                        <AttachmentImage
                          key={att.id}
                          attachment={att}
                          isOutbound={isOutbound}
                        />
                      ))}
                    </div>
                  )}
                  {/* Show placeholders for non-displayable attachments (videos, documents, etc.) */}
                  {nonDisplayableAttachments.length > 0 && (
                    <div className="mb-2 space-y-1">
                      {nonDisplayableAttachments.map((att) => (
                        <div
                          key={att.id}
                          className={`text-xs italic ${isOutbound ? "text-green-100" : "text-gray-500"} cursor-help`}
                          title="Some attachments can only be viewed during export or submission for review"
                        >
                          [{getAttachmentLabel(att.mime_type, att.filename)}: {att.filename}]
                        </div>
                      ))}
                    </div>
                  )}
                  {/* Show placeholder for attachments still loading */}
                  {!!msg.has_attachments &&
                    messageAttachments.length === 0 &&
                    attachmentsLoading && (
                      <div
                        className={`text-xs italic mb-1 ${isOutbound ? "text-green-100" : "text-gray-400"}`}
                      >
                        Loading attachment...
                      </div>
                    )}
                  {/* Show generic placeholder when we know there's an attachment but can't load it */}
                  {!!msg.has_attachments &&
                    messageAttachments.length === 0 &&
                    !attachmentsLoading && (
                      <div
                        className={`text-xs italic mb-1 ${isOutbound ? "text-green-100" : "text-gray-400"} cursor-help`}
                        title="Some attachments can only be viewed during export or submission for review"
                      >
                        [Attachment]
                      </div>
                    )}
                  {/* Show message text if it's not just a replacement character */}
                  {hasRealText && (
                    <p className="text-sm whitespace-pre-wrap break-words">
                      {msgText}
                    </p>
                  )}
                  {/* Fallback: show placeholder if message has no content to display */}
                  {!hasRealText &&
                    !msg.has_attachments &&
                    displayableAttachments.length === 0 &&
                    nonDisplayableAttachments.length === 0 && (
                      <p
                        className={`text-xs italic ${isOutbound ? "text-green-100" : "text-gray-400"}`}
                      >
                        [Media not available]
                      </p>
                    )}
                  <p
                    className={`text-xs mt-1 ${
                      isOutbound ? "text-green-100" : "text-gray-400"
                    }`}
                  >
                    {formatMessageTime(msgTime)}
                  </p>
                </div>
              </div>
            );
          })}
        </div>

        {/* Footer */}
        {onSeeTransaction ? (
          // BACKLOG-1935: contact-card context — offer a jump to the thread's
          // owning transaction alongside Close. Only rendered when the caller
          // supplies onSeeTransaction (i.e. the thread is transaction-linked);
          // the MessageThreadCard usage omits it, so its footer is unchanged.
          <div className="bg-white border-t px-4 py-3 flex items-center justify-between gap-2">
            <button
              onClick={onSeeTransaction}
              className="px-4 py-2 text-blue-600 hover:bg-blue-50 rounded-full text-sm font-medium transition-all flex items-center gap-2"
              data-testid="conversation-view-see-transaction"
            >
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
                  d="M9 5l7 7-7 7"
                />
              </svg>
              See transaction
            </button>
            <button
              onClick={onClose}
              className="px-6 py-2 bg-gray-200 hover:bg-gray-300 rounded-full text-sm font-medium text-gray-700 transition-all"
            >
              Close
            </button>
          </div>
        ) : (
          <div className="bg-white border-t px-4 py-3 flex justify-center">
            <button
              onClick={onClose}
              className="px-6 py-2 bg-gray-200 hover:bg-gray-300 rounded-full text-sm font-medium text-gray-700 transition-all"
            >
              Close
            </button>
          </div>
        )}
    </ResponsiveModal>
  );
}

export default ConversationViewModal;
