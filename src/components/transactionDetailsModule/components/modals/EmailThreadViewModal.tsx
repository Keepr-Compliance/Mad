/**
 * EmailThreadViewModal Component
 * TASK-1183: Modal for viewing all emails in a conversation thread.
 * Displays emails in a chat-bubble style for easy reading.
 * Click to expand for full email details.
 * TASK-1782: Added attachment display per email in thread view.
 */
import React, { useState, useCallback, useMemo, useEffect } from "react";
import DOMPurify from "dompurify";
import { ResponsiveModal } from "../../../common/ResponsiveModal";
import type { Communication } from "../../types";
import type { EmailThread } from "../EmailThreadCard";
import { AttachmentPreviewModal } from "./AttachmentPreviewModal";
import { formatFileSize } from "../../../../utils/formatUtils";
import { getEmailAvatarInitial } from "../../../../utils/avatarUtils";
import { resolveDisplayName, formatParticipantLine, formatParticipantListLine } from "../../../../utils/emailParticipantUtils";
import logger from '../../../../utils/logger';

/**
 * Email attachment structure from IPC
 */
interface EmailAttachment {
  id: string;
  filename: string;
  mime_type: string | null;
  file_size_bytes: number | null;
  storage_path: string | null;
}

/**
 * Get icon for file type based on MIME type
 */
function getFileTypeIcon(mimeType: string | null): React.ReactElement {
  const iconClass = "w-4 h-4 flex-shrink-0";

  if (!mimeType) {
    // Default file icon
    return (
      <svg className={iconClass} fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 21h10a2 2 0 002-2V9.414a1 1 0 00-.293-.707l-5.414-5.414A1 1 0 0012.586 3H7a2 2 0 00-2 2v14a2 2 0 002 2z" />
      </svg>
    );
  }

  if (mimeType.startsWith("image/")) {
    return (
      <svg className={iconClass} fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
      </svg>
    );
  }

  if (mimeType === "application/pdf") {
    return (
      <svg className={iconClass} fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
      </svg>
    );
  }

  if (mimeType.includes("spreadsheet") || mimeType.includes("excel") || mimeType === "text/csv") {
    return (
      <svg className={iconClass} fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 10h18M3 14h18m-9-4v8m-7 0h14a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z" />
      </svg>
    );
  }

  if (mimeType.includes("document") || mimeType.includes("word")) {
    return (
      <svg className={iconClass} fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
      </svg>
    );
  }

  // Default file icon
  return (
    <svg className={iconClass} fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 21h10a2 2 0 002-2V9.414a1 1 0 00-.293-.707l-5.414-5.414A1 1 0 0012.586 3H7a2 2 0 00-2 2v14a2 2 0 002 2z" />
    </svg>
  );
}

interface EmailThreadViewModalProps {
  /** The email thread to display */
  thread: EmailThread;
  /** Callback to close the modal */
  onClose: () => void;
  /** Optional callback when an email is clicked for full view */
  onViewEmail?: (email: Communication) => void;
  /** User's email address — emails from this sender show as "You" */
  userEmail?: string;
  /**
   * BACKLOG-1762: lowercase email -> contact display_name map. Resolves sender
   * / From / To names from Contacts when the email header carries no name.
   */
  nameMap?: ReadonlyMap<string, string>;
}

/**
 * Sanitize HTML content to prevent XSS attacks
 */
function sanitizeHtml(html: string): string {
  return DOMPurify.sanitize(html, {
    ALLOWED_TAGS: [
      "p", "br", "div", "span", "a", "b", "i", "strong", "em", "u",
      "ul", "ol", "li", "blockquote",
    ],
    ALLOWED_ATTR: ["href"],
    ALLOW_DATA_ATTR: false,
    FORBID_ATTR: ["onerror", "onload", "onclick", "onmouseover"],
  });
}

/**
 * A quoted-reply header block, as the mail clients actually emit one.
 *
 * BACKLOG-2862. The rule this replaces was
 * `/\nFrom:.*?\nSent:.*?(?:\nTo:.*?)?(?:\nSubject:.*?)?(?:\n|$)/gi`, and it
 * had two faults that compounded:
 *
 *   1. It REQUIRED `Sent:`. Windows Outlook writes `Sent:`, but Outlook for Mac
 *      and Apple Mail write `Date:` — which is the founder's own mail — so the
 *      rule never fired on his client at all.
 *   2. Even when it did fire it ended at `(?:\n|$)`, so it removed the header
 *      LINES and left the entire quoted message beneath them. Contrast the
 *      Gmail rule below, whose `[\s\S]*` runs to the end and does remove it.
 *
 * Anchoring on a single token (`Date:`) would over-match: a body with "Date:"
 * in ordinary prose ("...confirm the Date: Thursday works") would be truncated
 * there. So the anchor is the whole BLOCK — a `From:` line followed by a run of
 * contiguous header lines, at least one of which is `Sent:` or `Date:`. Prose
 * cannot satisfy that without looking exactly like a header block.
 *
 * Matching is order-independent inside the block, because the producers
 * disagree on order and hardcoding one would silently miss the others. The
 * three shapes covered, each transcribed from something that actually emits it
 * rather than recalled (see the test file for the citation of each):
 *
 *   From: / Sent: / To: / Subject:        Windows Outlook
 *   From: / Date: / To: / Subject:        Outlook for Mac, Apple Mail
 *   From: / To: / Cc: / Subject: / Date:  an RFC-822 block, Subject BEFORE Date
 *
 * The third is why the rule cannot assume Date follows From: this repo's own
 * .eml export writes exactly that order, so a forwarded export produces it.
 */
const REPLY_HEADER_START = /^[ \t]*From:[ \t]*\S/i;
const REPLY_HEADER_KEY = /^[ \t]*(?:From|Sent|Date|To|Cc|Bcc|Reply-To|Subject|Importance|Attachments):/i;
/** The line that PROVES the block is a header block rather than prose. */
const REPLY_HEADER_PROOF = /^[ \t]*(?:Sent|Date):[ \t]*\S/i;

/**
 * Cut from the first quoted-reply header block to the end of the text.
 *
 * Returns the text unchanged when no block is found. Everything from a header
 * block down is the PREVIOUS message, so a two-level chain collapses in one
 * pass — there is no need to walk the levels.
 */
function stripQuotedReplyChain(text: string): string {
  const lines = text.split("\n");

  for (let i = 0; i < lines.length; i++) {
    if (!REPLY_HEADER_START.test(lines[i])) continue;

    // Consume the contiguous run of header lines that follows.
    let end = i + 1;
    let proven = false;
    while (end < lines.length && REPLY_HEADER_KEY.test(lines[end])) {
      if (REPLY_HEADER_PROOF.test(lines[end])) proven = true;
      end++;
    }

    if (proven) return lines.slice(0, i).join("\n");
    // Not a header block (a bare "From: the seller" line in prose). Keep looking
    // — a real block may still appear further down.
  }

  return text;
}

/**
 * Strip HTML and quoted content and return the message's plain text.
 *
 * BACKLOG-2851 removed a 300-character cap that was cutting ordinary mail.
 * BACKLOG-2862 removed the `max-h-96 overflow-y-auto` height bound that
 * replaced it: a long message scrolled inside a bubble that itself sits inside
 * the scrolling thread, so two scroll regions competed for one gesture.
 *
 * There is deliberately NO character cap. The founder deferred it once the
 * header block proved to be a reliable boundary — "we can build the char limit
 * later now that i know it's easy for us to find out where emails start and end
 * using the sent/to/from repeated section" — which makes quote stripping the
 * whole mechanism for keeping a bubble short. A genuinely long body with NO
 * quoted chain (a newsletter, an automated report) is therefore unbounded here;
 * that is a known, accepted consequence recorded on BACKLOG-2862, not an
 * oversight.
 */
function getPlainTextBody(email: Communication): string {
  let text = "";

  // Prefer plain text
  const plain = email.body_text || email.body_plain;
  if (plain) {
    text = plain;
  } else {
    // Fall back to stripping HTML
    const html = email.body_html || email.body;
    if (html) {
      const div = document.createElement("div");
      div.innerHTML = sanitizeHtml(html);
      text = div.textContent || div.innerText || "";
    }
  }

  if (!text) return "";

  // The header-block strip MUST run BEFORE the underscore rule below.
  //
  // Outlook emits `____...____\nFrom:\nSent:\nTo:\nSubject:\n\n<quoted body>`.
  // The underscore rule is LAZY to the first blank line, so running it first
  // eats the header lines and leaves the quoted body orphaned with no anchor
  // for this rule to find. Run this first and the underscore remnant is left
  // trailing at `$`, where the underscore rule still removes it.
  const withoutQuotedChain = stripQuotedReplyChain(text);
  // A bare forward — the sender added no words of their own — strips to nothing.
  // Showing "No content" there would be a regression: the forwarded message IS
  // the content. Keep the original when stripping would empty the bubble.
  if (withoutQuotedChain.trim()) {
    text = withoutQuotedChain;
  }

  // Remove the Outlook separator rule left behind above (and any that stands
  // alone, e.g. an "-----Original Message-----"-style divider run of "_").
  const outlookReplyPattern = /_{10,}[\s\S]*?(?=\n\n|$)/g;
  text = text.replace(outlookReplyPattern, '');

  // Remove Gmail-style quoted content "On [date], [name] wrote:"
  const gmailQuotePattern = /On .+? wrote:[\s\S]*/gi;
  text = text.replace(gmailQuotePattern, '');

  // Remove lines starting with > (traditional quote style)
  const lines = text.split('\n').filter(line => !line.trim().startsWith('>'));
  text = lines.join('\n');

  // Clean up excessive whitespace
  text = text.replace(/\n{3,}/g, '\n\n').replace(/[ \t]+/g, ' ').trim();

  return text;
}

/**
 * Format time for chat bubble
 */
function formatTime(date: Date): string {
  return date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

/**
 * Check if sender matches the user's email
 */
function isSelfSender(sender: string | undefined, userEmail?: string): boolean {
  if (!sender || !userEmail) return false;
  const normalizedUser = userEmail.toLowerCase().trim();
  const match = sender.match(/<([^>]+)>/);
  const email = match ? match[1].toLowerCase() : sender.toLowerCase().trim();
  return email === normalizedUser;
}

/**
 * Extract sender name from email address.
 * BACKLOG-1762: resolves via Contacts (nameMap) when the header has no name.
 * Priority: "You" (self) > real header name > contact name > bare address.
 */
function extractSenderName(
  sender: string | undefined,
  userEmail?: string,
  nameMap?: ReadonlyMap<string, string>,
): string {
  if (!sender) return "Unknown";

  // Show "You" for the user's own emails
  if (isSelfSender(sender, userEmail)) return "You";

  // Real header name > contact name > bare email address
  return resolveDisplayName(sender, nameMap);
}

/**
 * Get consistent color for sender
 */
function getSenderColor(sender: string | undefined): string {
  const colors = [
    "from-blue-500 to-indigo-600",
    "from-green-500 to-teal-600",
    "from-purple-500 to-pink-600",
    "from-orange-500 to-red-600",
    "from-cyan-500 to-blue-600",
  ];
  const hash = (sender || "").split("").reduce((acc, char) => acc + char.charCodeAt(0), 0);
  return colors[hash % colors.length];
}

/**
 * The attachment list, as a popup.
 *
 * BACKLOG-2862 replaced TASK-1782's in-bubble collapsible strip (the
 * `mt-3 pt-2 border-t` block with `data-testid="attachment-toggle-*"`) with the
 * header pill opening this. The strip put a second disclosure INSIDE a bubble
 * that is itself a disclosure, and pushed the message text down to make room
 * for filenames the reader had not asked for.
 *
 * The three states the strip owned all move here rather than being dropped:
 * loading, BACKLOG-1369's blocked/offline message, and "has attachments but the
 * list did not arrive". Rows keep the strip's markup so files stay clickable
 * into AttachmentPreviewModal instead of becoming a dead list.
 *
 * z-[90] is deliberate and sits BETWEEN the thread modal (z-[80]) and
 * AttachmentPreviewModal (z-[100]), so a preview opened FROM this list stacks
 * above it rather than behind it.
 */
function AttachmentListModal({
  attachments,
  loading,
  message,
  senderName,
  onPreview,
  onClose,
}: {
  attachments: EmailAttachment[];
  loading: boolean;
  message?: string | null;
  senderName: string;
  onPreview: (attachment: EmailAttachment) => void;
  onClose: () => void;
}): React.ReactElement {
  const heading = loading
    ? "Attachments"
    : `${attachments.length} attachment${attachments.length !== 1 ? "s" : ""}`;

  return (
    <ResponsiveModal
      onClose={onClose}
      zIndex="z-[90]"
      panelClassName="max-w-sm"
      testId="thread-attachment-list-backdrop"
    >
      <div className="flex items-center justify-between px-4 py-3 border-b border-gray-100">
        <strong className="text-sm font-semibold text-gray-900">
          {heading} — {senderName}
        </strong>
        <button
          type="button"
          onClick={onClose}
          className="text-gray-400 hover:text-gray-600 text-xl leading-none px-1"
          aria-label="Close"
        >
          ×
        </button>
      </div>

      <div className="p-2 max-h-[300px] overflow-y-auto">
        {loading && (
          <p className="px-2 py-3 text-xs text-gray-500">Loading attachments...</p>
        )}

        {!loading && message && (
          <p className="px-2 py-3 text-xs text-gray-500" data-testid="thread-attachment-message">
            {message}
          </p>
        )}

        {!loading && !message && attachments.length === 0 && (
          <p className="px-2 py-3 text-xs text-gray-500">
            This email has attachments, but they are not downloaded yet.
          </p>
        )}

        {attachments.map((attachment) => (
          <button
            key={attachment.id}
            type="button"
            onClick={() => onPreview(attachment)}
            className="flex items-center gap-2 w-full px-2 py-2 rounded-lg text-xs transition-colors hover:bg-gray-100 text-gray-700"
            title={`Preview ${attachment.filename}`}
            data-testid={`thread-attachment-${attachment.id}`}
          >
            {getFileTypeIcon(attachment.mime_type)}
            <span className="truncate flex-1 text-left">{attachment.filename}</span>
            {attachment.file_size_bytes && (
              <span className="text-gray-500 flex-shrink-0">
                {formatFileSize(attachment.file_size_bytes)}
              </span>
            )}
          </button>
        ))}
      </div>
    </ResponsiveModal>
  );
}

/**
 * Chat bubble for a single email
 * BACKLOG-2862: recipients above the body, attachments behind the header pill.
 */
function EmailBubble({
  email,
  isExpanded,
  onToggle,
  onViewFull,
  attachments,
  loadingAttachments,
  attachmentMessage,
  onPreviewAttachment,
  userEmail,
  nameMap,
}: {
  email: Communication;
  isExpanded: boolean;
  onToggle: () => void;
  onViewFull?: () => void;
  attachments: EmailAttachment[];
  loadingAttachments: boolean;
  attachmentMessage?: string | null;
  onPreviewAttachment: (attachment: EmailAttachment) => void;
  userEmail?: string;
  nameMap?: ReadonlyMap<string, string>;
}): React.ReactElement {
  const emailDate = new Date(email.sent_at || email.received_at || 0);
  const isMe = isSelfSender(email.sender, userEmail);
  const senderName = extractSenderName(email.sender, userEmail, nameMap);
  const avatarInitial = isMe ? "Y" : getEmailAvatarInitial(email.sender);
  const avatarColor = getSenderColor(email.sender);
  const messageText = useMemo(() => getPlainTextBody(email), [email]);
  const [showAttachments, setShowAttachments] = useState(false);

  const hasAttachments = email.has_attachments || attachments.length > 0;
  const attachmentCount = attachments.length || (email.has_attachments ? 1 : 0);

  /**
   * Does a FORMATTED version of this message exist?
   *
   * BACKLOG-2862. The bubble renders plain text — getPlainTextBody strips the
   * markup — while the full view renders the real HTML: EmailViewModal derives
   * `html = email.body_html || email.body` (:166), defaults `viewMode` to
   * "html" when that is present (:185), and renders the HTML branch at :434.
   * So the key here must be that SAME expression: gate on anything else and the
   * control would offer a "formatted" view that falls back to the same plain
   * text the bubble already shows, which is a control that changes nothing.
   */
  const hasFormattedVersion = Boolean(email.body_html || email.body);

  const handleContentClick = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      const target = e.target as HTMLElement;
      const anchor = target.closest("a");

      if (anchor) {
        e.preventDefault();
        e.stopPropagation();
        const href = anchor.getAttribute("href");
        if (href && (href.startsWith("http://") || href.startsWith("https://"))) {
          if (window.api?.shell?.openExternal) {
            window.api.shell.openExternal(href);
          } else {
            window.open(href, "_blank", "noopener,noreferrer");
          }
        }
      }
    },
    []
  );

  const handleOpenAttachments = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    setShowAttachments(true);
  }, []);

  return (
    <div className="flex gap-3">
      {/* Avatar */}
      <div
        className={`w-8 h-8 bg-gradient-to-br ${avatarColor} rounded-full flex items-center justify-center text-white font-semibold text-xs flex-shrink-0 mt-1`}
      >
        {avatarInitial}
      </div>

      {/* Bubble */}
      <div className="flex-1 min-w-0">
        {/* Sender + Time header */}
        <div className="flex items-center gap-2 mb-1">
          <span className="font-semibold text-gray-900 text-sm">
            {senderName}
          </span>
          <span className="text-xs text-gray-400">
            {formatTime(emailDate)}
          </span>
          {/*
            BACKLOG-2862: the pill is a BUTTON, not the inert <span> with a
            `title` it used to be. The count was information the reader could
            see but not act on — the only way to the files was the strip inside
            the bubble, which is now gone.
          */}
          {hasAttachments && (
            <button
              type="button"
              onClick={handleOpenAttachments}
              disabled={loadingAttachments}
              className="inline-flex items-center gap-1 px-1.5 py-0.5 text-xs text-gray-500 bg-gray-100 rounded-full hover:text-gray-900 hover:bg-gray-200 transition-colors"
              title={`${attachmentCount} attachment${attachmentCount !== 1 ? "s" : ""}`}
              data-testid={`attachment-pill-${email.id}`}
            >
              <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.172 7l-6.586 6.586a2 2 0 102.828 2.828l6.414-6.586a4 4 0 00-5.656-5.656l-6.415 6.585a6 6 0 108.486 8.486L20.5 13" />
              </svg>
              {loadingAttachments ? "..." : attachmentCount}
            </button>
          )}
        </div>

        {/* Content bubble */}
        <div
          className="bg-white rounded-2xl rounded-tl-sm px-4 py-3 shadow-sm border border-gray-100 cursor-pointer hover:bg-gray-50 transition-colors"
          onClick={onToggle}
        >
          {/*
            BACKLOG-2862: recipients ABOVE the message, and `To` only.

            The sender is already named outside the bubble, immediately above
            it, so repeating `From` inside says nothing. `From` still appears in
            the expanded "Tap for details" block below — that block is a
            different surface and is out of scope here.
          */}
          {email.recipients && (
            <div
              className="text-xs text-gray-400 pb-2 mb-2 border-b border-gray-100"
              data-testid={`thread-bubble-recipients-${email.id}`}
            >
              <span className="font-medium text-gray-500">To</span>{" "}
              {formatParticipantListLine(email.recipients, nameMap)}
            </div>
          )}

          {/*
            The message text, in full, always shown.

            BACKLOG-2862 REMOVED the `max-h-96 overflow-y-auto` height bound that
            BACKLOG-2851 added here. It made the bubble a scroll region nested
            inside the thread's own scroll region, so one wheel gesture had two
            possible targets and the reader got whichever the pointer happened to
            be over. The founder's complaint was exactly that.

            Nothing bounds this element now. Quote stripping is the whole
            mechanism: a reply chain — the reason bubbles got long — is cut at
            the header block, and the founder deferred the character cap once
            that boundary proved reliable. A long body with NO quoted chain is
            therefore unbounded; see BACKLOG-2862 for the measured worst case and
            the decision to accept it for now.
          */}
          <div
            className="text-sm text-gray-700 whitespace-pre-wrap leading-relaxed"
            data-testid={`thread-bubble-body-${email.id}`}
            onClick={handleContentClick}
          >
            {messageText || <span className="italic text-gray-400">No content</span>}
          </div>

          {/*
            BACKLOG-2862: "View formatted email", gated on a formatted version
            EXISTING. The bubble is plain text with the markup stripped; this
            opens the view that renders the real HTML. When there is no HTML the
            full view falls back to the same plain text the bubble already
            shows, so the control would change nothing visible and must not
            render — that gate is the whole reason the label is honest.
          */}
          {hasFormattedVersion && onViewFull && (
            <div className="mt-2 pt-2 border-t border-gray-100">
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  onViewFull();
                }}
                className="text-xs text-blue-600 hover:text-blue-800 font-medium"
                data-testid={`thread-bubble-formatted-${email.id}`}
              >
                View formatted email
              </button>
            </div>
          )}

          {/* Expanded details */}
          {isExpanded && (
            <div className="mt-3 pt-3 border-t border-gray-100">
              <div className="text-xs text-gray-500 space-y-1">
                <div>
                  <span className="font-medium">From:</span>{" "}
                  {email.sender ? formatParticipantLine(email.sender, nameMap) : "Unknown"}
                </div>
                {email.recipients && (
                  <div>
                    <span className="font-medium">To:</span>{" "}
                    {formatParticipantListLine(email.recipients, nameMap)}
                  </div>
                )}
              </div>

              {onViewFull && (
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    onViewFull();
                  }}
                  className="mt-2 text-xs text-blue-600 hover:text-blue-800 font-medium"
                >
                  Open Full Email →
                </button>
              )}
            </div>
          )}

          {/* Expand indicator */}
          {!isExpanded && !hasAttachments && (
            <div className="mt-2 text-xs text-gray-400 flex items-center gap-1">
              <span>Tap for details</span>
              <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
              </svg>
            </div>
          )}
        </div>
      </div>

      {showAttachments && (
        <AttachmentListModal
          attachments={attachments}
          loading={loadingAttachments}
          message={attachmentMessage}
          senderName={senderName}
          onPreview={(attachment) => {
            setShowAttachments(false);
            onPreviewAttachment(attachment);
          }}
          onClose={() => setShowAttachments(false)}
        />
      )}
    </div>
  );
}

export function EmailThreadViewModal({
  thread,
  onClose,
  onViewEmail,
  userEmail,
  nameMap,
}: EmailThreadViewModalProps): React.ReactElement {
  // Track which emails are expanded (default: none - show just content bubbles)
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());

  // TASK-1782: Attachment state management
  // Map of email ID -> attachments
  const [attachmentsByEmail, setAttachmentsByEmail] = useState<Map<string, EmailAttachment[]>>(new Map());
  const [loadingAttachmentIds, setLoadingAttachmentIds] = useState<Set<string>>(new Set());
  // BACKLOG-1369: Per-email attachment download status messages
  const [attachmentMessagesByEmail, setAttachmentMessagesByEmail] = useState<Map<string, string>>(new Map());
  const [previewAttachment, setPreviewAttachment] = useState<EmailAttachment | null>(null);

  // TASK-1782: Fetch attachments for emails that have them
  useEffect(() => {
    const emailsWithAttachments = thread.emails.filter(email => email.has_attachments && email.id);

    if (emailsWithAttachments.length === 0) return;

    const transactionsApi = window.api?.transactions;
    if (!transactionsApi?.getEmailAttachments) return;

    // Mark all as loading
    setLoadingAttachmentIds(new Set(emailsWithAttachments.map(e => e.id)));

    // Fetch attachments for each email
    emailsWithAttachments.forEach(email => {
      transactionsApi
        .getEmailAttachments(email.id)
        .then((result: { success: boolean; data?: EmailAttachment[]; error?: string; downloadBlocked?: boolean; offline?: boolean; downloadRequired?: boolean; reason?: string }) => {
          if (result.success && result.data) {
            setAttachmentsByEmail(prev => {
              const next = new Map(prev);
              next.set(email.id, result.data!);
              return next;
            });
          }
          // BACKLOG-1369: Handle blocked/offline scenarios
          if (result.downloadBlocked || result.offline) {
            setAttachmentMessagesByEmail(prev => {
              const next = new Map(prev);
              next.set(email.id, result.reason || "Attachments are not available.");
              return next;
            });
          }
        })
        .catch((err: Error) => {
          logger.error(`Failed to fetch attachments for email ${email.id}:`, err);
        })
        .finally(() => {
          setLoadingAttachmentIds(prev => {
            const next = new Set(prev);
            next.delete(email.id);
            return next;
          });
        });
    });
  }, [thread.emails]);

  const toggleEmail = useCallback((emailId: string) => {
    setExpandedIds(prev => {
      const next = new Set(prev);
      if (next.has(emailId)) {
        next.delete(emailId);
      } else {
        next.add(emailId);
      }
      return next;
    });
  }, []);

  // TASK-1782: Handle opening an attachment with system viewer
  const handleOpenAttachment = useCallback(async (storagePath: string) => {
    try {
      const transactionsApi = window.api?.transactions;
      if (transactionsApi?.openAttachment) {
        const result = await transactionsApi.openAttachment(storagePath);
        if (!result.success) {
          logger.error("Failed to open attachment:", result.error);
        }
      }
    } catch (err) {
      logger.error("Error opening attachment:", err);
    }
  }, []);

  return (
    <ResponsiveModal onClose={onClose} zIndex="z-[80]" panelBg="bg-gray-50" panelClassName="max-w-xl sm:max-h-[85vh] sm:overflow-hidden">
        {/* Header */}
        <div className="flex-shrink-0 bg-gradient-to-r from-blue-500 to-indigo-600 px-3 sm:px-6 pt-6 sm:pt-4 pb-3 sm:pb-4 sm:rounded-t-xl shadow-lg">
          {/* Mobile */}
          <div className="sm:hidden flex items-center justify-between">
            <button
              onClick={onClose}
              className="text-white hover:bg-white hover:bg-opacity-20 rounded-lg px-2 py-2 transition-all flex items-center gap-1 font-medium text-sm flex-shrink-0"
              aria-label="Close"
            >
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 19l-7-7m0 0l7-7m-7 7h18" />
              </svg>
              Back
            </button>
            <div className="text-right min-w-0 ml-2">
              <h3 className="text-base font-bold text-white truncate">
                {thread.subject || "(No Subject)"}
              </h3>
              <span className="text-blue-100 text-xs">
                {thread.emailCount} email{thread.emailCount !== 1 ? "s" : ""}
              </span>
            </div>
          </div>
          {/* Desktop */}
          <div className="hidden sm:flex items-start justify-between">
            <div className="flex-1 pr-4 min-w-0">
              <h3 className="text-lg font-bold text-white truncate">
                {thread.subject || "(No Subject)"}
              </h3>
              <p className="text-blue-100 text-sm mt-1">
                {thread.emailCount} email{thread.emailCount !== 1 ? "s" : ""} in conversation
              </p>
            </div>
            <button
              onClick={onClose}
              className="text-white hover:bg-white hover:bg-opacity-20 rounded-full p-1 transition-all"
              aria-label="Close"
            >
              <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
        </div>

        {/* Email conversation - newest first */}
        <div className="flex-1 overflow-y-auto p-4 space-y-4">
          {[...thread.emails].reverse().map((email) => (
            <EmailBubble
              key={email.id}
              email={email}
              isExpanded={expandedIds.has(email.id)}
              onToggle={() => toggleEmail(email.id)}
              onViewFull={onViewEmail ? () => onViewEmail(email) : undefined}
              attachments={attachmentsByEmail.get(email.id) || []}
              loadingAttachments={loadingAttachmentIds.has(email.id)}
              attachmentMessage={attachmentMessagesByEmail.get(email.id)}
              onPreviewAttachment={setPreviewAttachment}
              userEmail={userEmail}
              nameMap={nameMap}
            />
          ))}
        </div>

        {/* Footer */}
        <div className="flex-shrink-0 bg-white border-t px-5 py-3 flex justify-center">
          <button
            onClick={onClose}
            className="px-6 py-2 bg-gray-200 hover:bg-gray-300 rounded-full text-sm font-medium text-gray-700 transition-all"
          >
            Close
          </button>
        </div>

      {/* TASK-1782: Attachment Preview Modal */}
      {previewAttachment && (
        <AttachmentPreviewModal
          attachment={previewAttachment}
          onClose={() => setPreviewAttachment(null)}
          onOpenWithSystem={(storagePath) => {
            handleOpenAttachment(storagePath);
          }}
        />
      )}
    </ResponsiveModal>
  );
}

export default EmailThreadViewModal;
