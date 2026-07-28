/**
 * ConversationViewModal Component
 * Phone-style popup modal for viewing a full conversation thread.
 * Supports inline display of image/GIF attachments (TASK-1012).
 */
import React, { useEffect, useState, useRef } from "react";
import { ResponsiveModal } from "../../../common/ResponsiveModal";
import { AuditPeriodToggle } from "../AuditPeriodToggle";
import type { MessageLike } from "../MessageThreadCard";
import { normalizePhoneForLookup, getSenderPhone } from "../../../../utils/phoneNormalization";
import { formatDateRangeLabel, parseLocalCalendarDay, isTimestampInAuditPeriod } from "../../../../utils/dateRangeUtils";
import { isEmptyOrReplacementChar, formatMessageTime } from "../../../../utils/messageFormatUtils";
import {
  partitionReactions,
  aggregateReactions,
  REACTION_EMOJI,
} from "../../../../utils/reactionUtils";
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

/**
 * BACKLOG-2280: resolve a reaction's actor identity for the pill tooltip.
 * Outbound tapbacks are the user ("You"); inbound tapbacks resolve the sender's
 * phone to a contact name via the shared contactNames map (falling back to the
 * raw handle).
 */
function resolveReactionActorName(
  msg: MessageLike,
  contactNames: Record<string, string>,
): string {
  if (msg.direction === "outbound") return "You";
  const sender = getSenderPhone(msg);
  if (!sender) return "Someone";
  const normalized = normalizePhoneForLookup(sender);
  if (contactNames[sender]) return contactNames[sender];
  if (contactNames[normalized]) return contactNames[normalized];
  for (const [phone, name] of Object.entries(contactNames)) {
    if (normalizePhoneForLookup(phone) === normalized) return name;
  }
  return sender;
}

/**
 * BACKLOG-2280: grouped tapback pills rendered below a message bubble. Collapses
 * add/remove events per (actor, kind) and shows one pill per active kind with a
 * count and an actor-name tooltip. Renders nothing when there are no active
 * reactions (e.g. every add was later removed, or an orphan bucket).
 */
function ReactionPills({
  reactions,
  contactNames,
  isOutbound,
}: {
  reactions: MessageLike[];
  contactNames: Record<string, string>;
  isOutbound: boolean;
}): React.ReactElement | null {
  const nameByActorKey = new Map<string, string>();
  const events = reactions.map((r) => {
    const actorKey = r.direction === "outbound" ? "me" : getSenderPhone(r) || "unknown";
    nameByActorKey.set(actorKey, resolveReactionActorName(r, contactNames));
    return {
      actor: actorKey,
      sentAt: r.sent_at || r.received_at || "",
      associatedType: r.associated_message_type,
    };
  });

  const aggregated = aggregateReactions(events);
  if (aggregated.length === 0) return null;

  return (
    <div
      className={`flex flex-wrap gap-1 mt-1 ${isOutbound ? "justify-end" : "justify-start"}`}
      data-testid="reaction-pills"
    >
      {aggregated.map((agg) => {
        const names = agg.actors.map((a) => nameByActorKey.get(a) || a);
        return (
          <span
            key={agg.kind}
            title={names.join(", ")}
            data-testid={`reaction-pill-${agg.kind}`}
            className="inline-flex items-center gap-0.5 rounded-full bg-white/90 border border-gray-200 px-1.5 py-0.5 text-xs shadow-sm text-gray-700"
          >
            <span aria-hidden="true">{REACTION_EMOJI[agg.kind]}</span>
            {agg.count > 1 && <span className="font-medium">{agg.count}</span>}
          </span>
        );
      })}
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
  // BACKLOG-2280: split reaction rows out of the bubble list and key them to
  // their parent message guid. Reactions render as pills under their parent, not
  // as standalone (empty) bubbles, and never inflate the header count.
  const { messages: bubbleMessages, reactionsByParentGuid } = React.useMemo(
    () => partitionReactions(messages),
    [messages],
  );
  // Attachments state (TASK-1012)
  const [attachmentsMap, setAttachmentsMap] = useState<
    Record<string, MessageAttachmentInfo[]>
  >({});
  const [attachmentsLoading, setAttachmentsLoading] = useState(false);
  const loadedAttachmentsKeyRef = useRef<string>("");

  // TASK-1157 / BACKLOG-2295: Audit date state.
  // BACKLOG-2277: parse the audit boundaries as LOCAL calendar days so the modal
  // shares the EXACT same boundary as the tab (TransactionMessagesTab) via the
  // shared isTimestampInAuditPeriod. parseDateSafe only fixed this on Windows, so
  // on macOS a "YYYY-MM-DD" boundary parsed as UTC midnight and a last-audit-day
  // text visible in the tab vanished inside the modal (and the header range read
  // a day off).
  const parsedStartDate = parseLocalCalendarDay(auditStartDate);
  const parsedEndDate = parseLocalCalendarDay(auditEndDate);
  // Show the control if at least one date is set (handles ongoing transactions
  // with only a start date).
  const hasAuditDates = !!(parsedStartDate || parsedEndDate);
  // BACKLOG-2291: formatted range fed to the shared AuditPeriodToggle so the
  // modal's control (and its "(i)" popover copy) is identical to the Texts tab.
  const auditRangeLabel = formatDateRangeLabel(parsedStartDate, parsedEndDate);

  // BACKLOG-2295: INVERTED semantics — the modal no longer hides/shows via an
  // "audit period only" filter. Instead this toggle controls whether out-of-range
  // messages are ALSO shown (with a gray exclusion treatment) as visible context.
  // DEFAULT OFF: only audit-range messages are shown (same visible result as the
  // old default-ON filter). The toggle is INDEPENDENT of the Texts-tab toggle —
  // the modal now always receives the full, uncropped thread (see fullMessages in
  // MessageThreadCard / TransactionMessagesTab).
  const [showOutOfRange, setShowOutOfRange] = useState<boolean>(false);

  // TASK-1794: Sort messages newest-first (reverse chronological)
  const sortedMessages = [...bubbleMessages].sort((a, b) => {
    const dateA = new Date(a.sent_at || a.received_at || 0).getTime();
    const dateB = new Date(b.sent_at || b.received_at || 0).getTime();
    return dateB - dateA; // Newest first
  });

  // Classify each bubble against the audit period. When there are no audit dates,
  // everything is treated as in-range (no toggle, no shading).
  const isInAuditRange = React.useCallback(
    (msg: MessageLike): boolean =>
      !hasAuditDates ||
      isTimestampInAuditPeriod(msg.sent_at || msg.received_at, parsedStartDate, parsedEndDate),
    [hasAuditDates, parsedStartDate, parsedEndDate],
  );

  // BACKLOG-2295: which bubbles are visible.
  // - no audit dates          → all messages
  // - dates + toggle OFF       → only in-range (the audit set, as before)
  // - dates + toggle ON        → all messages (out-of-range ones get shaded)
  const visibleMessages = React.useMemo(() => {
    if (!hasAuditDates || showOutOfRange) {
      return sortedMessages;
    }
    return sortedMessages.filter(isInAuditRange);
  }, [sortedMessages, hasAuditDates, showOutOfRange, isInAuditRange]);

  // Collect unique participants from all sources (not just inbound senders)
  const uniqueSenders = new Set<string>();
  bubbleMessages.forEach((msg) => {
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
    for (const msg of bubbleMessages) {
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
  const attachmentsKey = bubbleMessages
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
          <div className="flex-1">
            <h4 className="text-white font-semibold">
              {isGroupChat ? getGroupChatTitle() : (contactName || phoneNumber)}
            </h4>
            <p className="text-green-100 text-xs">
              {visibleMessages.length} message{visibleMessages.length !== 1 ? "s" : ""}
              {hasAuditDates && visibleMessages.length !== sortedMessages.length && (
                <span className="ml-1">of {sortedMessages.length}</span>
              )}
            </p>
          </div>
          {/* BACKLOG-2303: close (X) moved to the RIGHT of the header (standard
              placement). The title div's flex-1 pushes it to the right edge. */}
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
        </div>

        {/* TASK-1157 / BACKLOG-2291 / BACKLOG-2295: audit-context toggle. Uses the
            shared AuditPeriodToggle (pill "(i)" info button + label + switch) so it
            stays visually identical to the Texts tab, but with the "context"
            variant + INVERTED semantics: DEFAULT OFF shows only audit-range
            messages; turning it ON ALSO shows out-of-range messages with a gray
            exclusion treatment. Independent of the Texts-tab toggle — the modal
            receives the full, uncropped thread. */}
        {hasAuditDates && (
          <div className="bg-gray-100 px-4 py-2 border-b border-gray-200">
            <AuditPeriodToggle
              variant="context"
              checked={showOutOfRange}
              onChange={setShowOutOfRange}
              auditRangeLabel={auditRangeLabel}
            />
          </div>
        )}

        {/* Messages list - phone style */}
        <div className="flex-1 overflow-y-auto p-4 space-y-3">
          {visibleMessages.map((msg, index) => {
            const isOutbound = msg.direction === "outbound";
            // BACKLOG-2295: an out-of-range bubble gets a gray exclusion treatment
            // (only possible when the "show before & after" toggle is ON, since
            // OFF never renders out-of-range messages). In-range bubbles are
            // unchanged. bubbleIsDark drives inner text color: light-on-green for a
            // normal outbound bubble, but muted-on-gray for an excluded one.
            const isOutOfRange = showOutOfRange && hasAuditDates && !isInAuditRange(msg);
            const bubbleIsDark = isOutbound && !isOutOfRange;
            // BACKLOG-2280: tapbacks targeting this bubble (matched by parent guid).
            const parentReactions =
              (msg.external_id && reactionsByParentGuid.get(msg.external_id)) || [];
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
                const prevSender = getSenderPhone(visibleMessages[index - 1]);
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
                  className={`flex flex-col max-w-[85%] sm:max-w-[80%] ${
                    isOutbound ? "items-end" : "items-start"
                  }`}
                >
                <div
                  data-testid={isOutOfRange ? "out-of-range-message" : "in-range-message"}
                  data-out-of-range={isOutOfRange ? "true" : "false"}
                  className={`rounded-2xl px-3 py-2 sm:px-4 ${
                    isOutOfRange
                      ? `bg-gray-200 text-gray-500 border border-gray-300 ${isOutbound ? "rounded-br-md" : "rounded-bl-md"}`
                      : isOutbound
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
                          isOutbound={bubbleIsDark}
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
                          className={`text-xs italic ${bubbleIsDark ? "text-green-100" : "text-gray-500"} cursor-help`}
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
                        className={`text-xs italic mb-1 ${bubbleIsDark ? "text-green-100" : "text-gray-400"}`}
                      >
                        Loading attachment...
                      </div>
                    )}
                  {/* Show generic placeholder when we know there's an attachment but can't load it */}
                  {!!msg.has_attachments &&
                    messageAttachments.length === 0 &&
                    !attachmentsLoading && (
                      <div
                        className={`text-xs italic mb-1 ${bubbleIsDark ? "text-green-100" : "text-gray-400"} cursor-help`}
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
                        className={`text-xs italic ${bubbleIsDark ? "text-green-100" : "text-gray-400"}`}
                      >
                        [Media not available]
                      </p>
                    )}
                  <p
                    className={`text-xs mt-1 ${
                      bubbleIsDark ? "text-green-100" : "text-gray-400"
                    }`}
                  >
                    {formatMessageTime(msgTime)}
                  </p>
                </div>
                {/* BACKLOG-2280: tapback pills below the bubble, aligned to its side. */}
                {parentReactions.length > 0 && (
                  <ReactionPills
                    reactions={parentReactions}
                    contactNames={contactNames}
                    isOutbound={isOutbound}
                  />
                )}
                </div>
              </div>
            );
          })}
        </div>

        {/* BACKLOG-2295: exclusion legend — only while out-of-range messages are
            being shown. Explains the gray treatment and that those messages are
            NOT part of the export (DISPLAY-only; the export set is unchanged). */}
        {showOutOfRange && hasAuditDates && (
          <div
            className="bg-gray-100 border-t border-gray-200 px-4 py-2 flex items-start gap-2 text-xs text-gray-600"
            data-testid="exclusion-legend"
          >
            <span
              className="mt-0.5 inline-block w-3.5 h-3.5 flex-shrink-0 rounded bg-gray-200 border border-gray-300"
              aria-hidden="true"
            />
            <span>
              Messages with a gray background are outside the audit range and
              won&rsquo;t be included in the export &mdash; to include them, change
              the audit date range.
            </span>
          </div>
        )}

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
