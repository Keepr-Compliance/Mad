/**
 * Text/SMS Export Helpers
 * Pure utility functions for text message HTML generation.
 * Extracted from folderExportService.ts for maintainability.
 */

import fsSync from "fs";
import type { Communication } from "../../types/models";
import { isEmailMessage } from "../../utils/channelHelpers";
import { escapeHtml } from "../../utils/exportUtils";
import {
  normalizePhone as sharedNormalizePhone,
} from "../contactResolutionService";
import {
  partitionReactions,
  aggregateReactions,
  isReactionRow,
  REACTION_EMOJI,
} from "../../utils/reactionUtils";
import logService from "../logService";

/**
 * BACKLOG-2280: render a minimal, evidentiary reactions line for a message's
 * tapbacks (e.g. "Reactions: ❤️ You · 👍 Jane Smith"). Collapses add/remove per
 * (actor, kind) and resolves actor names via the export phone→name map. Returns
 * "" when there are no active reactions so nothing is emitted.
 */
function renderReactionsLine(
  reactions: Communication[],
  phoneNameMap: Record<string, string>,
): string {
  if (!reactions || reactions.length === 0) return "";

  const nameByActorKey = new Map<string, string>();
  const events = reactions.map((r) => {
    const actorKey = r.direction === "outbound" ? "me" : (r.sender || "unknown");
    let name = "You";
    if (r.direction !== "outbound") {
      const handle = r.sender || "";
      const normalized = handle ? sharedNormalizePhone(handle) : "";
      name =
        (normalized && phoneNameMap[normalized]) ||
        phoneNameMap[handle] ||
        phoneNameMap[handle.toLowerCase()] ||
        handle ||
        "Someone";
    }
    nameByActorKey.set(actorKey, name);
    return {
      actor: actorKey,
      sentAt: (r.sent_at || r.received_at || "") as string,
      associatedType: r.associated_message_type,
    };
  });

  const aggregated = aggregateReactions(events);
  if (aggregated.length === 0) return "";

  const parts = aggregated.map((agg) => {
    const names = agg.actors.map((a) => nameByActorKey.get(a) || a);
    return `${REACTION_EMOJI[agg.kind]} ${escapeHtml(names.join(", "))}`;
  });

  return `<div class="reactions" style="margin-top: 4px; font-size: 12px; color: #718096;">Reactions: ${parts.join(" · ")}</div>`;
}

/**
 * Get thread key for grouping messages (uses thread_id if available).
 * For emails without thread_id, falls back to normalized subject + sorted participants.
 * For texts without thread_id, falls back to phone-number-based participant matching.
 */
export function getThreadKey(msg: Communication): string {
  // Use thread_id if available
  if (msg.thread_id) return msg.thread_id;

  // Email-specific fallback: use normalized subject + sorted sender/recipients
  if (isEmailMessage(msg)) {
    const subject = msg.subject
      ? msg.subject.replace(/^(?:(?:Re|Fwd|FW)\s*:\s*)+/i, "").trim().toLowerCase()
      : "";
    const participants = [msg.sender, msg.recipients]
      .filter(Boolean)
      .map(s => (s || "").toLowerCase().trim())
      .sort()
      .join("-");
    if (subject || participants) {
      return `email-thread-${subject}-${participants}`;
    }
  }

  // Text message fallback: compute from participants using phone normalization
  try {
    if (msg.participants) {
      const parsed =
        typeof msg.participants === "string"
          ? JSON.parse(msg.participants)
          : msg.participants;

      const allParticipants = new Set<string>();
      if (parsed.from) allParticipants.add(sharedNormalizePhone(parsed.from));
      if (parsed.to) {
        const toList = Array.isArray(parsed.to) ? parsed.to : [parsed.to];
        toList.forEach((p: string) =>
          allParticipants.add(sharedNormalizePhone(p))
        );
      }

      if (allParticipants.size > 0) {
        return (
          "participants-" + Array.from(allParticipants).sort().join("-")
        );
      }
    }
  } catch {
    // Fall through
  }

  // Last resort: use message id
  return "msg-" + msg.id;
}

/**
 * Extract phone/contact name from thread
 */
export function getThreadContact(
  msgs: Communication[],
  phoneNameMap: Record<string, string>
): { phone: string; name: string | null } {
  for (const msg of msgs) {
    try {
      if (msg.participants) {
        const parsed =
          typeof msg.participants === "string"
            ? JSON.parse(msg.participants)
            : msg.participants;

        let phone: string | null = null;
        if (msg.direction === "inbound" && parsed.from) {
          phone = parsed.from;
        } else if (msg.direction === "outbound" && parsed.to?.length > 0) {
          phone = Array.isArray(parsed.to) ? parsed.to[0] : parsed.to;
        }

        if (phone) {
          const normalized = sharedNormalizePhone(phone);
          const name =
            phoneNameMap[normalized] || phoneNameMap[phone] || null;
          return { phone, name };
        }
      }
    } catch {
      // Continue
    }

    // Fallback to sender
    if (msg.sender) {
      const normalized = sharedNormalizePhone(msg.sender);
      const name =
        phoneNameMap[normalized] || phoneNameMap[msg.sender] || null;
      return { phone: msg.sender, name };
    }
  }
  return { phone: "Unknown", name: null };
}

/**
 * Check if a thread is a group chat (has multiple unique participants)
 * Uses chat_members (authoritative) when available, falls back to from/to parsing
 */
export function isGroupChat(msgs: Communication[]): boolean {
  // First check for chat_members (authoritative source)
  for (const msg of msgs) {
    try {
      if (msg.participants) {
        const parsed =
          typeof msg.participants === "string"
            ? JSON.parse(msg.participants)
            : msg.participants;

        // chat_members is the authoritative list from Apple's chat_handle_join
        if (parsed.chat_members && Array.isArray(parsed.chat_members)) {
          // chat_members doesn't include "me", so 2+ members means group chat (3+ total with user)
          return parsed.chat_members.length >= 2;
        }
      }
    } catch {
      // Continue
    }
  }

  // Fallback: extract from from/to (less reliable)
  const participants = new Set<string>();
  for (const msg of msgs) {
    try {
      if (msg.participants) {
        const parsed =
          typeof msg.participants === "string"
            ? JSON.parse(msg.participants)
            : msg.participants;

        if (parsed.from) {
          const normalized = sharedNormalizePhone(parsed.from);
          // Skip "unknown" ghost participants
          if (normalized && parsed.from.toLowerCase() !== "unknown") {
            participants.add(normalized);
          }
        }
        if (parsed.to) {
          const toList = Array.isArray(parsed.to) ? parsed.to : [parsed.to];
          toList.forEach((p: string) => {
            const normalized = sharedNormalizePhone(p);
            // Skip "unknown" ghost participants
            if (normalized && p.toLowerCase() !== "unknown") {
              participants.add(normalized);
            }
          });
        }
      }
    } catch {
      // Continue
    }
  }

  // Group chat if more than 2 participants
  return participants.size > 2;
}

/**
 * Count unique text threads for the summary index
 */
export function countTextThreads(texts: Communication[]): number {
  const threads = new Set<string>();
  for (const msg of texts) {
    // BACKLOG-2280: reactions are attached to their parent, not standalone
    // conversations — exclude them so the thread count stays honest.
    if (isReactionRow(msg)) continue;
    threads.add(getThreadKey(msg));
  }
  return threads.size;
}

/**
 * Get message type counts for summary statistics (TASK-1802)
 */
export function getMessageTypeCounts(texts: Communication[]): {
  textMessages: number;
  voiceMessages: number;
  locationMessages: number;
  attachmentOnlyMessages: number;
  systemMessages: number;
} {
  // BACKLOG-2280: exclude tapback/reaction rows (message_type NULL) so they are
  // not miscounted as text messages in the summary statistics.
  const real = texts.filter(m => !isReactionRow(m));
  return {
    textMessages: real.filter(m => m.message_type === "text" || !m.message_type).length,
    voiceMessages: real.filter(m => m.message_type === "voice_message").length,
    locationMessages: real.filter(m => m.message_type === "location").length,
    attachmentOnlyMessages: real.filter(m => m.message_type === "attachment_only").length,
    systemMessages: real.filter(m => m.message_type === "system").length,
  };
}

/**
 * Generate HTML for text conversations index in summary
 */
export function generateTextIndex(
  texts: Communication[],
  phoneNameMap?: Record<string, string>,
  getContactNamesByPhonesFallback?: (handles: string[]) => Record<string, string>,
  extractHandles?: (texts: Communication[]) => string[]
): string {
  // Use provided phoneNameMap or fall back to sync lookup
  const nameMap = phoneNameMap ||
    (getContactNamesByPhonesFallback && extractHandles
      ? getContactNamesByPhonesFallback(extractHandles(texts))
      : {});

  // Group by thread. BACKLOG-2280: exclude reactions from the index — they are
  // attached to their parent line inside each thread, not indexed as messages, so
  // the per-thread "(N msgs)" count stays honest.
  const textThreads = new Map<string, Communication[]>();
  for (const msg of texts) {
    if (isReactionRow(msg)) continue;
    const key = getThreadKey(msg);
    const thread = textThreads.get(key) || [];
    thread.push(msg);
    textThreads.set(key, thread);
  }

  // Sort threads by most recent message
  const sortedThreads = Array.from(textThreads.entries())
    .map(([_, msgs]) => {
      msgs.sort((a, b) => {
        const dateA = new Date(a.sent_at || a.received_at || 0).getTime();
        const dateB = new Date(b.sent_at || b.received_at || 0).getTime();
        return dateA - dateB;
      });
      return msgs;
    })
    .sort((a, b) => {
      const lastA = a[a.length - 1];
      const lastB = b[b.length - 1];
      const dateA = new Date(lastA.sent_at || lastA.received_at || 0).getTime();
      const dateB = new Date(lastB.sent_at || lastB.received_at || 0).getTime();
      return dateA - dateB; // Oldest first for indexing
    });

  return sortedThreads
    .map((msgs, index) => {
      const contact = getThreadContact(msgs, nameMap);
      const groupChat = isGroupChat(msgs);
      // Use better display name for unknown contacts
      let displayName: string;
      if (!contact.name && contact.phone.toLowerCase() === "unknown") {
        displayName = groupChat ? "Group Chat" : "Unknown Contact";
      } else {
        displayName = contact.name || contact.phone;
      }

      return `
          <div class="text-item">
            <div class="header-row">
              <span class="index">${String(index + 1).padStart(3, "0")}</span>
              <span class="contact">${escapeHtml(displayName)} (${msgs.length} msg${msgs.length === 1 ? "" : "s"})</span>
            </div>
          </div>
        `;
    })
    .join("");
}

/**
 * Generate HTML for a single text conversation thread (styled like PDF export)
 */
export function generateTextThreadHTML(
  msgs: Communication[],
  contact: { phone: string; name: string | null },
  phoneNameMap: Record<string, string>,
  groupChat: boolean,
  threadIndex: number,
  participants?: Array<{ phone: string; name: string | null }>,
  getAttachmentsForMessage?: (messageId: string, externalId?: string) => {
    id: string;
    filename: string;
    mime_type: string | null;
    storage_path: string | null;
    file_size_bytes: number | null;
  }[]
): string {
  // BACKLOG-2280: split tapback rows out of the thread so they are attached to
  // their parent message line (as an evidentiary "Reactions:" line) rather than
  // rendered as their own empty message, and so the header count below is honest.
  const { messages: realMsgs, reactionsByParentGuid } = partitionReactions(msgs);

  const messagesHtml = realMsgs
    .map((msg) => {
      const parentReactions =
        (msg.external_id && reactionsByParentGuid.get(msg.external_id)) || [];
      return generateTextMessageHTML(
        msg,
        contact,
        phoneNameMap,
        groupChat,
        getAttachmentsForMessage,
        parentReactions,
      );
    })
    .join("");

  return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      padding: 40px;
      color: #1a202c;
      background: white;
    }
    .header {
      border-bottom: 4px solid #667eea;
      padding-bottom: 20px;
      margin-bottom: 30px;
    }
    .header h1 { font-size: 20px; color: #1a202c; margin-bottom: 8px; }
    .header .meta { font-size: 13px; color: #718096; }
    .message {
      margin-bottom: 16px;
      padding: 12px;
      border-radius: 12px;
      max-width: 80%;
      background: #f1f1f1;
    }
    .message.outbound {
      margin-left: auto;
      background: #007aff;
      color: white;
    }
    .message.outbound .sender { color: rgba(255,255,255,0.9); }
    .message.outbound .time { color: rgba(255,255,255,0.7); }
    .message.outbound .phone { color: rgba(255,255,255,0.7); }
    .message .sender { font-weight: 600; color: #2d3748; }
    .message .time { font-size: 11px; color: #718096; margin-left: 8px; }
    .message .phone { font-size: 11px; color: #718096; display: block; margin-bottom: 4px; }
    .message .body { margin-top: 4px; line-height: 1.5; }
    .attachment-image {
      margin-top: 8px;
    }
    .attachment-image img {
      max-width: 200px;
      max-height: 200px;
      border-radius: 8px;
      border: 1px solid #e2e8f0;
    }
    .attachment-ref {
      margin-top: 8px;
      padding: 8px 12px;
      background: #f7fafc;
      border: 1px solid #e2e8f0;
      border-radius: 6px;
      font-size: 12px;
      color: #4a5568;
    }
    .special-indicator {
      font-size: 11px;
      font-style: italic;
      color: #718096;
      margin-bottom: 4px;
      padding: 4px 8px;
      background: #f0f4f8;
      border-radius: 4px;
      display: inline-block;
    }
    .special-indicator.voice-message {
      background: #e6f3ff;
      color: #2563eb;
    }
    .special-indicator.location-message {
      background: #e6fff0;
      color: #059669;
    }
    .special-indicator.attachment-only {
      background: #fff7e6;
      color: #d97706;
    }
    .audio-file-ref {
      font-size: 10px;
      color: #718096;
      font-style: italic;
      margin-top: 2px;
    }
    .message.system-message {
      max-width: 100%;
      background: transparent;
      text-align: center;
      margin: 12px 0;
      padding: 8px;
    }
    .system-content {
      font-size: 12px;
      color: #718096;
      font-style: italic;
    }
    .message.outbound .special-indicator {
      background: rgba(255,255,255,0.2);
      color: rgba(255,255,255,0.95);
    }
    .message.outbound .audio-file-ref {
      color: rgba(255,255,255,0.8);
    }
    .badge {
      display: inline-block;
      padding: 2px 8px;
      background: #e2e8f0;
      border-radius: 4px;
      font-size: 11px;
      color: #718096;
      margin-left: 8px;
    }
    .footer {
      margin-top: 40px;
      padding-top: 20px;
      border-top: 1px solid #e2e8f0;
      font-size: 11px;
      color: #a0aec0;
      text-align: center;
    }
    @media print { body { padding: 20px; } }
  </style>
</head>
<body>
  <div class="header">
    <h1>${(() => {
      const threadId = String(threadIndex + 1).padStart(3, "0");
      // Group chats always show "Group Chat #XXX"
      if (groupChat) {
        return `Group Chat <span class="badge">#${threadId}</span>`;
      }
      if (!contact.name && contact.phone.toLowerCase() === "unknown") {
        return `Unknown Contact <span class="badge">#${threadId}</span>`;
      }
      return `Conversation with ${escapeHtml(contact.name || contact.phone)} <span class="badge">#${threadId}</span>`;
    })()}</h1>
    <div class="meta">${!groupChat && contact.name ? escapeHtml(contact.phone) + " | " : ""}${realMsgs.length} message${realMsgs.length === 1 ? "" : "s"}</div>
    ${groupChat && participants && participants.length > 0 ? `
    <div class="participants" style="margin-top: 12px; padding: 12px; background: #f7fafc; border-radius: 8px; font-size: 13px;">
      <div style="font-weight: 600; margin-bottom: 8px; color: #4a5568;">Participants (${participants.length}):</div>
      <div style="display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap: 8px;">
        ${participants.map(p => `
          <div style="padding: 4px 0;">
            <span style="color: #2d3748;">${escapeHtml(p.name || p.phone || "Unknown")}</span>
            ${p.phone && p.name ? `<span style="color: #718096; font-size: 12px; display: block;">${escapeHtml(p.phone)}</span>` : ""}
          </div>
        `).join("")}
      </div>
    </div>
    ` : ""}
  </div>

  ${messagesHtml}

  <div class="footer">
    <p>Exported from Keepr</p>
  </div>
</body>
</html>
    `;
}

/**
 * Generate HTML for a single text message within a thread
 * Includes inline images for attachments and handles special message types (TASK-1802)
 */
export function generateTextMessageHTML(
  msg: Communication,
  contact: { phone: string; name: string | null },
  phoneNameMap: Record<string, string>,
  groupChat: boolean,
  getAttachmentsForMessage?: (messageId: string, externalId?: string) => {
    id: string;
    filename: string;
    mime_type: string | null;
    storage_path: string | null;
    file_size_bytes: number | null;
  }[],
  /** BACKLOG-2280: tapbacks targeting this message, rendered as an evidentiary line. */
  reactions: Communication[] = [],
): string {
  const isOutbound = msg.direction === "outbound";
  let senderName = "You";
  let senderPhone: string | null = null;

  if (!isOutbound) {
    if (groupChat && msg.sender) {
      // TASK-2026: Try multiple lookup strategies for sender resolution
      const normalized = sharedNormalizePhone(msg.sender);
      const resolvedName =
        phoneNameMap[normalized] ||
        phoneNameMap[msg.sender] ||
        phoneNameMap[msg.sender.toLowerCase()] ||
        null;
      senderName = resolvedName || msg.sender;
      // Show phone only in group chats to identify sender
      if (resolvedName) senderPhone = msg.sender;
    } else {
      // For 1:1 chats, use thread contact info
      senderName = contact.name || contact.phone;
    }
  }

  const msgDate = msg.sent_at || msg.received_at;
  const time = msgDate
    ? new Date(msgDate as string).toLocaleString("en-US", {
        month: "short",
        day: "numeric",
        year: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      })
    : "";

  // Get attachments for this message
  const messageId = msg.message_id || msg.id;
  const externalId = (msg as any).external_id;
  const attachments = messageId && getAttachmentsForMessage
    ? getAttachmentsForMessage(messageId, externalId)
    : [];

  // Debug: Log attachment lookup for messages that should have attachments
  if (msg.has_attachments) {
    logService.info(
      `[Folder Export] Message has_attachments=true, found ${attachments.length} attachments`,
      "FolderExport",
      { messageId, externalId, attachmentCount: attachments.length }
    );
  }

  // Handle special message types (TASK-1802)
  const messageType = msg.message_type || "text";
  let specialIndicatorHtml = "";
  let bodyContent = "";

  switch (messageType) {
    case "voice_message": {
      // Voice message: show indicator and transcript
      const transcript = msg.body_text || msg.body_plain || "";
      specialIndicatorHtml = `<div class="special-indicator voice-message">[Voice Message${transcript ? " - Transcript:" : ""}]</div>`;
      if (transcript) {
        bodyContent = escapeHtml(transcript);
      } else {
        bodyContent = "<em>[No transcript available]</em>";
      }
      // Reference audio file if available
      const audioAttachment = attachments.find(att =>
        att.mime_type?.startsWith("audio/") ||
        att.filename.toLowerCase().endsWith(".caf") ||
        att.filename.toLowerCase().endsWith(".m4a")
      );
      if (audioAttachment) {
        specialIndicatorHtml += `<div class="audio-file-ref">[Audio file: ${escapeHtml(audioAttachment.filename)}]</div>`;
      }
      break;
    }

    case "location": {
      // Location message: show indicator and location text
      const locationText = msg.body_text || msg.body_plain || "";
      specialIndicatorHtml = `<div class="special-indicator location-message">[Location Shared]</div>`;
      bodyContent = locationText ? escapeHtml(locationText) : "<em>Location information</em>";
      break;
    }

    case "attachment_only": {
      // Attachment-only: show indicator, attachments will be rendered below
      const attachmentDesc = attachments.length > 0
        ? attachments.map(a => a.filename).join(", ")
        : "attachment";
      specialIndicatorHtml = `<div class="special-indicator attachment-only">[Media Attachment: ${escapeHtml(attachmentDesc)}]</div>`;
      // No body content for attachment-only messages
      break;
    }

    case "system": {
      // System message: distinctive styling
      const systemText = msg.body_text || msg.body_plain || "System message";
      return `
    <div class="message system-message">
      <div class="system-content">-- ${escapeHtml(systemText)} --</div>
      <span class="time">${time}</span>
    </div>
    `;
    }

    case "text":
    default: {
      // Regular text message
      const bodyText = msg.body_text || msg.body_plain || "";
      const hasBody = bodyText.trim().length > 0;
      bodyContent = hasBody
        ? escapeHtml(bodyText)
        : (attachments.length > 0 ? "" : ""); // Empty if no text and no attachments
      break;
    }
  }

  // Generate attachment HTML (skip for attachment_only as it's already indicated)
  let attachmentHtml = "";
  if (messageType !== "attachment_only") {
    for (const att of attachments) {
      // Skip audio attachments for voice messages (already referenced above)
      if (messageType === "voice_message" &&
          (att.mime_type?.startsWith("audio/") ||
           att.filename.toLowerCase().endsWith(".caf") ||
           att.filename.toLowerCase().endsWith(".m4a"))) {
        continue;
      }

      if (att.mime_type?.startsWith("image/") && att.storage_path) {
        // Use file:// URL to reference image directly (more efficient than base64)
        try {
          if (fsSync.existsSync(att.storage_path)) {
            // Use file:// URL - works because we load HTML from temp file
            const fileUrl = `file://${att.storage_path}`;
            attachmentHtml += `<div class="attachment-image"><img src="${fileUrl}" alt="${escapeHtml(att.filename)}" /></div>`;
          } else {
            // Image file not found - show placeholder
            attachmentHtml += `<div class="attachment-ref">[Image: ${escapeHtml(att.filename)} - file not found]</div>`;
          }
        } catch (error) {
          // Failed to read image - show placeholder
          logService.warn("[Folder Export] Failed to embed image in PDF", "FolderExport", {
            filename: att.filename,
            error,
          });
          attachmentHtml += `<div class="attachment-ref">[Image: ${escapeHtml(att.filename)}]</div>`;
        }
      } else {
        // Non-image attachment - show reference with specific type
        const attachmentType = getAttachmentTypeLabel(att.mime_type, att.filename);
        attachmentHtml += `<div class="attachment-ref">[${attachmentType}: ${escapeHtml(att.filename)}]</div>`;
      }
    }
  } else {
    // For attachment_only, still show inline images
    for (const att of attachments) {
      if (att.mime_type?.startsWith("image/") && att.storage_path) {
        try {
          if (fsSync.existsSync(att.storage_path)) {
            const fileUrl = `file://${att.storage_path}`;
            attachmentHtml += `<div class="attachment-image"><img src="${fileUrl}" alt="${escapeHtml(att.filename)}" /></div>`;
          }
        } catch {
          // Ignore errors for inline images
        }
      }
    }
  }

  // BACKLOG-2280: evidentiary reactions line (empty string when none).
  const reactionsHtml = renderReactionsLine(reactions, phoneNameMap);

  return `
    <div class="message${isOutbound ? " outbound" : ""}">
      <span class="sender">${escapeHtml(senderName)}</span>
      <span class="time">${time}</span>
      ${senderPhone && groupChat ? `<span class="phone">${escapeHtml(senderPhone)}</span>` : ""}
      ${specialIndicatorHtml}
      ${bodyContent ? `<div class="body">${bodyContent}</div>` : ""}
      ${attachmentHtml}
      ${reactionsHtml}
    </div>
    `;
}

/**
 * Get a human-readable label for an attachment type
 */
export function getAttachmentTypeLabel(mimeType: string | null, filename: string): string {
  // Check mime type first
  if (mimeType) {
    if (mimeType.startsWith("video/")) return "Video";
    if (mimeType.startsWith("audio/")) return "Audio";
    if (mimeType.startsWith("image/")) return "Image";
    if (mimeType === "application/pdf") return "PDF";
    if (mimeType.includes("word") || mimeType.includes("document")) return "Document";
    if (mimeType.includes("excel") || mimeType.includes("spreadsheet")) return "Spreadsheet";
    if (mimeType.includes("powerpoint") || mimeType.includes("presentation")) return "Presentation";
  }

  // Fall back to extension
  const ext = filename.toLowerCase().split(".").pop() || "";
  const extensionLabels: Record<string, string> = {
    mp4: "Video",
    mov: "Video",
    m4v: "Video",
    avi: "Video",
    mkv: "Video",
    webm: "Video",
    mp3: "Audio",
    m4a: "Audio",
    aac: "Audio",
    wav: "Audio",
    caf: "Voice Message",
    pdf: "PDF",
    doc: "Document",
    docx: "Document",
    xls: "Spreadsheet",
    xlsx: "Spreadsheet",
    ppt: "Presentation",
    pptx: "Presentation",
    txt: "Text File",
    rtf: "Document",
  };

  return extensionLabels[ext] || "Attachment";
}
