/**
 * Folder Export Service
 * Creates organized export folder structure for transaction audits:
 *
 * Transaction_123_Main_St/
 * +-- Summary_Report.pdf        (transaction overview)
 * +-- emails/
 * |   +-- 001_2024-01-15_RE_Inspection.pdf
 * |   +-- ...
 * +-- texts/
 * |   +-- thread_001_John_Smith_2024-01-15.pdf
 * |   +-- ...
 * +-- attachments/
 *     +-- document.pdf
 *     +-- manifest.json
 *
 * Orchestrator class that delegates HTML generation to helper modules:
 * - emailExportHelpers: Email HTML generation and quoted content stripping
 * - textExportHelpers: Text/SMS thread HTML generation
 * - summaryHelpers: Summary report HTML generation
 * - attachmentHelpers: Attachment querying and file management
 */

import path from "path";
import fs from "fs/promises";
import { app, BrowserWindow } from "electron";
import { JSDOM } from "jsdom";
import createDOMPurify, { type WindowLike } from "dompurify";
import logService from "../logService";
import databaseService from "../databaseService";
import { getUserById } from "../db/userDbService";
import type { Transaction, Communication } from "../../types/models";
import type { TransactionWithDetails } from "../transactionService/types";
import type { FolderExportProgress } from "../../types/ipc";
import { isEmailMessage, isTextMessage } from "../../utils/channelHelpers";
import {
  resolveHandles as resolveAllHandles,
  resolveGroupChatParticipants as sharedResolveGroupChatParticipants,
  extractParticipantHandles,
} from "../contactResolutionService";

// Import extracted helpers
import { generateSummaryHTML } from "./summaryHelpers";
import {
  generateEmailThreadHTML,
  generateEmailHTML,
  isHtmlContent as _isHtmlContent,
  stripQuotedContent as _stripQuotedContent,
  stripSubjectPrefixes as _stripSubjectPrefixes,
} from "./emailExportHelpers";
import {
  getThreadKey,
  getThreadContact,
  isGroupChat,
  generateTextThreadHTML,
} from "./textExportHelpers";
// BACKLOG-2161: emails group by the SAME key the app uses on-screen so the
// exported thread count/grouping matches the app's "N conversations". Texts keep
// getThreadKey (participants-based). This is the single canonical email key.
import { getEmailIndexThreadKey, groupEmailsForIndex } from "./emailIndexHelpers";
import {
  getAttachmentsForMessage,
  getAttachmentsForEmail,
  sanitizeFileName,
  exportEmailAttachmentsToThreadDirs,
  type AttachmentExportResult,
} from "./attachmentHelpers";
import {
  buildCombinedHTML,
  injectIndexLinks,
  emailThreadSectionId,
  textThreadSectionId,
  textIndexRowId,
  EMAIL_INDEX_ANCHOR,
  type CombinedSection,
} from "./combinedExportHelpers";

// DOMPurify instance for sanitizing rich HTML email bodies in the combined PDF
// (BACKLOG-1584). Everything renders in one BrowserWindow, so bodies are
// sanitized before injection. Mirrors the allowlist used by pdfExportService.
const domPurifyWindow = new JSDOM("").window;
const combinedDOMPurify = createDOMPurify(domPurifyWindow as unknown as WindowLike);

function sanitizeEmailBodyHtml(html: string | null | undefined): string {
  if (!html) return "";
  const sanitized = combinedDOMPurify.sanitize(html, {
    ALLOWED_TAGS: [
      "a", "b", "blockquote", "br", "caption", "cite", "code",
      "col", "colgroup", "dd", "div", "dl", "dt", "em", "h1",
      "h2", "h3", "h4", "h5", "h6", "hr", "i", "img", "li",
      "ol", "p", "pre", "small", "span", "strong", "sub", "sup",
      "table", "tbody", "td", "tfoot", "th", "thead", "tr", "u", "ul",
    ],
    ALLOWED_ATTR: [
      "href", "src", "alt", "title", "width", "height", "style",
      "class", "colspan", "rowspan", "align", "valign", "border",
      "cellpadding", "cellspacing", "dir", "lang",
    ],
    ALLOWED_URI_REGEXP: /^(?:(?:https?|mailto|tel):|[^a-z]|[a-z+.-]+(?:[^a-z+.\-:]|$))/i,
    FORBID_TAGS: ["script", "style", "iframe", "object", "embed", "form", "input", "button", "textarea", "meta", "link", "base"],
    WHOLE_DOCUMENT: false,
  });
  // Remove background-color styles that could bleed onto the PDF page.
  return sanitized.replace(/background(-color)?\s*:\s*[^;"}]+[;"]?/gi, "");
}

export interface FolderExportOptions {
  transactionId: string;
  outputPath?: string;
  includeEmails: boolean;
  includeTexts: boolean;
  includeAttachments: boolean;
  attachmentType?: "all" | "email" | "text" | "none";
  emailExportMode?: "thread" | "individual";
  onProgress?: (progress: FolderExportProgress) => void;
}

// FolderExportProgress is imported from ../../types/ipc
export type { FolderExportProgress } from "../../types/ipc";

interface AttachmentManifestEntry {
  filename: string;
  originalMessage: string;
  date: string;
  size: number;
  sourceEmailIndex?: number;
  messageType?: "email" | "text";
  messagePreview?: string;
  status?: "exported" | "file_not_found" | "copy_failed";
}

interface AttachmentManifest {
  transactionId: string;
  propertyAddress: string;
  exportDate: string;
  attachments: AttachmentManifestEntry[];
  /** TASK-2050: Summary of email attachments exported to thread directories */
  emailAttachments?: {
    totalCount: number;
    exportedCount: number;
    skippedCount: number;
    totalSizeBytes: number;
    items: Array<{
      emailId: string;
      filename: string;
      contentType: string;
      sizeBytes: number;
      exportPath: string;
    }>;
    errors: string[];
  };
}

class FolderExportService {
  /**
   * Export transaction to organized folder structure
   */
  async exportTransactionToFolder(
    transaction: TransactionWithDetails,
    communications: Communication[],
    options: FolderExportOptions
  ): Promise<string> {
    const { includeEmails, includeTexts, includeAttachments, attachmentType = "all", emailExportMode, onProgress } = options;

    try {
      logService.info("[Folder Export] Starting folder export", "FolderExport", {
        transactionId: transaction.id,
        emailCount: communications.filter((c) => isEmailMessage(c)).length,
        textCount: communications.filter((c) => isTextMessage(c)).length,
      });

      // Create base folder
      const basePath = options.outputPath || this.getDefaultExportPath(transaction);
      await fs.mkdir(basePath, { recursive: true });

      // Create subfolders
      const emailsPath = path.join(basePath, "emails");
      const textsPath = path.join(basePath, "texts");
      const attachmentsPath = path.join(basePath, "attachments");

      if (includeEmails) {
        await fs.mkdir(emailsPath, { recursive: true });
      }
      if (includeTexts) {
        await fs.mkdir(textsPath, { recursive: true });
      }
      if (includeAttachments) {
        await fs.mkdir(attachmentsPath, { recursive: true });
      }

      onProgress?.({
        stage: "preparing",
        current: 0,
        total: 100,
        message: "Creating folder structure...",
      });

      // Separate emails and texts
      const emails = communications.filter((c) => isEmailMessage(c));
      const texts = communications.filter((c) => isTextMessage(c));

      // Sort by date (oldest first for indexing)
      emails.sort((a, b) => {
        const dateA = new Date(a.sent_at as string).getTime();
        const dateB = new Date(b.sent_at as string).getTime();
        return dateA - dateB;
      });

      texts.sort((a, b) => {
        const dateA = new Date(a.sent_at as string).getTime();
        const dateB = new Date(b.sent_at as string).getTime();
        return dateA - dateB;
      });

      // TASK-2026: Pre-load contact names for all handles (phones + emails + Apple IDs)
      const allHandles = extractParticipantHandles(texts);
      const phoneNameMap = await resolveAllHandles(allHandles, transaction.user_id);

      // Get user's name and email for "me" display in group chats
      let userName: string | undefined;
      let userEmail: string | undefined;
      try {
        const user = await getUserById(transaction.user_id);
        if (user) {
          userName = user.display_name || user.first_name || user.email?.split("@")[0];
          userEmail = user.email || undefined;
        }
      } catch {
        // Ignore - will fall back to "You"
      }

      // Generate Summary PDF
      onProgress?.({
        stage: "summary",
        current: 0,
        total: 1,
        message: "Generating summary report...",
      });

      // BACKLOG-2161: pass the Email Mode so the summary's email index honors
      // Thread View vs Individual (default "thread" when unset).
      await this.generateSummaryPDF(
        transaction,
        communications,
        basePath,
        phoneNameMap,
        emailExportMode ?? "thread"
      );

      onProgress?.({
        stage: "summary",
        current: 1,
        total: 1,
        message: "Summary report complete",
      });

      // Export emails as PDFs
      if (includeEmails && emails.length > 0) {
        if (emailExportMode === "individual") {
          for (let i = 0; i < emails.length; i++) {
            onProgress?.({
              stage: "emails",
              current: i + 1,
              total: emails.length,
              message: `Exporting email ${i + 1} of ${emails.length}...`,
            });
            await this.exportEmailToPDF(emails[i], i + 1, emailsPath, true);
          }
        } else {
          onProgress?.({
            stage: "emails",
            current: 0,
            total: 1,
            message: "Exporting email threads...",
          });
          await this.exportEmailThreads(emails, emailsPath);
          onProgress?.({
            stage: "emails",
            current: 1,
            total: 1,
            message: "Email threads exported",
          });
        }
      }

      // TASK-2061: Build thread name mapping so attachment folders match PDF names
      // Uses the same grouping and naming logic as exportEmailThreads()
      const threadNameMap = new Map<string, string>();
      if (includeEmails && emails.length > 0) {
        const threads = new Map<string, Communication[]>();
        for (const email of emails) {
          const key = getEmailIndexThreadKey(email);
          const thread = threads.get(key) || [];
          thread.push(email);
          threads.set(key, thread);
        }

        // Sort messages within each thread chronologically (same as exportEmailThreads)
        threads.forEach((msgs, key) => {
          threads.set(
            key,
            msgs.sort((a, b) => {
              const dateA = new Date(a.sent_at as string).getTime();
              const dateB = new Date(b.sent_at as string).getTime();
              return dateA - dateB;
            })
          );
        });

        let threadIndex = 0;
        for (const [key, msgs] of threads) {
          const firstDate = msgs[0].sent_at
            ? new Date(msgs[0].sent_at as string).toISOString().split("T")[0]
            : "unknown";
          const subject = sanitizeFileName(msgs[0].subject || "no_subject");
          const paddedIndex = String(threadIndex + 1).padStart(3, "0");
          const folderName = `thread_${paddedIndex}_${firstDate}_${subject}`;
          threadNameMap.set(key, folderName);
          threadIndex++;
        }
      }

      // TASK-2050: Export email attachments into per-thread subdirectories
      // TASK-2061: Pass threadNameMap so folders match PDF names
      let emailAttachmentResult: AttachmentExportResult | undefined;
      if (includeEmails && emails.length > 0) {
        emailAttachmentResult = await exportEmailAttachmentsToThreadDirs(
          emails,
          emailsPath,
          threadNameMap,
        );
        if (emailAttachmentResult.exported > 0 || emailAttachmentResult.skipped > 0) {
          logService.info("[Folder Export] Email attachments phase complete", "FolderExport", {
            exported: emailAttachmentResult.exported,
            skipped: emailAttachmentResult.skipped,
            totalSizeMB: (emailAttachmentResult.totalSizeBytes / 1024 / 1024).toFixed(1),
          });
        }
      }

      // Export text conversations
      if (includeTexts && texts.length > 0) {
        onProgress?.({
          stage: "texts",
          current: 0,
          total: 1,
          message: "Exporting text conversations...",
        });

        await this.exportTextConversations(texts, textsPath, phoneNameMap, userName, userEmail);

        onProgress?.({
          stage: "texts",
          current: 1,
          total: 1,
          message: "Text conversations exported",
        });
      }

      // Export attachments with manifest
      if (includeAttachments && attachmentType !== "none") {
        onProgress?.({
          stage: "attachments",
          current: 0,
          total: 1,
          message: "Collecting attachments...",
        });

        // Filter communications based on attachmentType
        let attachmentComms: typeof emails;
        if (attachmentType === "email") {
          attachmentComms = [...emails];
        } else if (attachmentType === "text") {
          attachmentComms = [...texts];
        } else {
          // "all" — include both
          attachmentComms = [...emails, ...texts];
        }
        await this.exportAttachments(transaction, attachmentComms, attachmentsPath, attachmentType === "text" ? undefined : emailAttachmentResult);

        onProgress?.({
          stage: "attachments",
          current: 1,
          total: 1,
          message: "Attachments exported",
        });
      }

      onProgress?.({
        stage: "complete",
        current: 100,
        total: 100,
        message: "Export complete!",
      });

      logService.info("[Folder Export] Export complete", "FolderExport", { basePath });
      return basePath;
    } catch (error) {
      logService.error("[Folder Export] Export failed", "FolderExport", { error });
      throw error;
    }
  }

  /**
   * Generate summary PDF for the transaction.
   * @param emailExportMode BACKLOG-2161 — "thread" lists the email index by
   *   conversation thread (matches the app's "N conversations"); "individual"
   *   lists each email. Defaults to "thread".
   */
  private async generateSummaryPDF(
    transaction: TransactionWithDetails,
    communications: Communication[],
    basePath: string,
    phoneNameMap?: Record<string, string>,
    emailExportMode: "thread" | "individual" = "thread"
  ): Promise<void> {
    const html = generateSummaryHTML(transaction, communications, phoneNameMap, emailExportMode);
    const pdfBuffer = await this.htmlToPdf(html);
    await fs.writeFile(path.join(basePath, "Summary_Report.pdf"), pdfBuffer);
  }

  /**
   * Export a single email to PDF
   */
  private async exportEmailToPDF(
    email: Communication,
    index: number,
    outputPath: string,
    stripQuotes: boolean = false
  ): Promise<void> {
    const attachments = email.id ? getAttachmentsForEmail(email.id) : [];
    const html = generateEmailHTML(email, attachments, stripQuotes);
    const pdfBuffer = await this.htmlToPdf(html);

    const date = new Date(email.sent_at as string);
    const dateStr = date.toISOString().split("T")[0];
    const subject = sanitizeFileName(email.subject || "no_subject");
    const paddedIndex = String(index).padStart(3, "0");

    const fileName = `email_${paddedIndex}_${dateStr}_${subject}.pdf`;
    await fs.writeFile(path.join(outputPath, fileName), pdfBuffer);
  }

  /**
   * Export emails grouped by thread -- one PDF per conversation thread.
   */
  private async exportEmailThreads(
    emails: Communication[],
    outputPath: string
  ): Promise<void> {
    // Group emails by thread (BACKLOG-2161: same on-screen key as the index)
    const threads = new Map<string, Communication[]>();
    for (const email of emails) {
      const key = getEmailIndexThreadKey(email);
      const thread = threads.get(key) || [];
      thread.push(email);
      threads.set(key, thread);
    }

    // Sort messages within each thread chronologically
    threads.forEach((msgs, key) => {
      threads.set(
        key,
        msgs.sort((a, b) => {
          const dateA = new Date(a.sent_at as string).getTime();
          const dateB = new Date(b.sent_at as string).getTime();
          return dateA - dateB;
        })
      );
    });

    // Export each thread as a single PDF
    let threadIndex = 0;
    for (const [, msgs] of threads) {
      const html = generateEmailThreadHTML(msgs, getAttachmentsForEmail);
      const pdfBuffer = await this.htmlToPdf(html);

      const firstDate = msgs[0].sent_at
        ? new Date(msgs[0].sent_at as string).toISOString().split("T")[0]
        : "unknown";
      const subject = sanitizeFileName(msgs[0].subject || "no_subject");
      const paddedIndex = String(threadIndex + 1).padStart(3, "0");
      const fileName = `thread_${paddedIndex}_${firstDate}_${subject}.pdf`;

      await fs.writeFile(path.join(outputPath, fileName), pdfBuffer);
      threadIndex++;
    }
  }

  /**
   * Export text conversations as individual PDF files (one per thread)
   */
  private async exportTextConversations(
    texts: Communication[],
    outputPath: string,
    phoneNameMap?: Record<string, string>,
    userName?: string,
    userEmail?: string
  ): Promise<void> {
    const nameMap = phoneNameMap || {};

    // Group texts by thread
    const textThreads = new Map<string, Communication[]>();
    for (const msg of texts) {
      const key = getThreadKey(msg);
      const thread = textThreads.get(key) || [];
      thread.push(msg);
      textThreads.set(key, thread);
    }

    // Sort messages within each thread chronologically
    textThreads.forEach((msgs, key) => {
      textThreads.set(
        key,
        msgs.sort((a, b) => {
          const dateA = new Date(a.sent_at || a.received_at || 0).getTime();
          const dateB = new Date(b.sent_at || b.received_at || 0).getTime();
          return dateA - dateB;
        })
      );
    });

    // Export each thread as PDF
    let threadIndex = 0;
    for (const [, msgs] of textThreads) {
      const contact = getThreadContact(msgs, nameMap);
      const groupChat = isGroupChat(msgs);
      // TASK-2027: Delegate to shared service, adapt ResolvedParticipant to {phone, name} format
      const participants = groupChat
        ? (await sharedResolveGroupChatParticipants(msgs, nameMap, userName, userEmail))
            .map(p => ({ phone: p.handle, name: p.name }))
        : undefined;
      const html = generateTextThreadHTML(
        msgs,
        contact,
        nameMap,
        groupChat,
        threadIndex,
        participants,
        getAttachmentsForMessage
      );
      const pdfBuffer = await this.htmlToPdf(html);

      // Get date from first message
      const firstMsgDate = msgs[0].sent_at || msgs[0].received_at;
      const firstDate = firstMsgDate
        ? new Date(firstMsgDate as string).toISOString().split("T")[0]
        : "unknown";
      // Use better display name for unknown contacts
      let displayName: string;
      if (!contact.name && contact.phone.toLowerCase() === "unknown") {
        displayName = groupChat ? "Group_Chat" : "Unknown_Contact";
      } else {
        displayName = contact.name || contact.phone;
      }
      const contactName = sanitizeFileName(displayName);
      const fileName = `text_${String(threadIndex + 1).padStart(3, "0")}_${contactName}_${firstDate}.pdf`;

      await fs.writeFile(path.join(outputPath, fileName), pdfBuffer);
      threadIndex++;
    }
  }

  /**
   * Export attachments and create manifest
   * TASK-2050: Updated to include email attachment metadata in manifest
   */
  async exportAttachments(
    transaction: Transaction,
    communications: Communication[],
    outputPath: string,
    emailAttachmentResult?: AttachmentExportResult
  ): Promise<void> {
    const manifest: AttachmentManifest = {
      transactionId: transaction.id,
      propertyAddress: transaction.property_address,
      exportDate: new Date().toISOString(),
      attachments: [],
    };

    const emailComms = communications.filter((comm) => isEmailMessage(comm));
    const textComms = communications.filter((comm) => isTextMessage(comm));

    const messageIds = textComms
      .filter((comm) => comm.message_id || comm.id)
      .map((comm) => comm.message_id || comm.id) as string[];

    const emailIds = emailComms
      .filter((comm) => comm.id)
      .map((comm) => comm.id) as string[];

    const externalIds = textComms
      .filter((comm) => (comm as any).external_id)
      .map((comm) => (comm as any).external_id) as string[];

    const commsWithAttachments = communications.filter((c) => c.has_attachments);
    logService.info(
      `[Folder Export] exportAttachments called`,
      "FolderExport",
      {
        totalCommunications: communications.length,
        withHasAttachments: commsWithAttachments.length,
        messageIds: messageIds.length,
        emailIds: emailIds.length,
        externalIds: externalIds.length,
      }
    );

    if (messageIds.length === 0 && emailIds.length === 0) {
      await fs.writeFile(
        path.join(outputPath, "manifest.json"),
        JSON.stringify(manifest, null, 2),
        "utf8"
      );
      return;
    }

    // Query attachments table for all linked messages and emails
    const attachmentRows = databaseService.getAttachmentsForExportBulk(messageIds, externalIds, emailIds);

    if (attachmentRows.length > 0) {
      logService.info(
        `[Folder Export] Found ${attachmentRows.length} total attachments for export`,
        "FolderExport"
      );
    }

    // Build maps for quick lookup
    const messageIdToCommIndex = new Map<string, number>();
    const messageIdToComm = new Map<string, Communication>();
    const externalIdToCommIndex = new Map<string, number>();
    const externalIdToComm = new Map<string, Communication>();
    communications.forEach((comm, index) => {
      if (comm.message_id) {
        messageIdToCommIndex.set(comm.message_id, index + 1);
        messageIdToComm.set(comm.message_id, comm);
      }
      if (comm.id) {
        messageIdToCommIndex.set(comm.id, index + 1);
        messageIdToComm.set(comm.id, comm);
      }
      const extId = (comm as any).external_id;
      if (extId) {
        externalIdToCommIndex.set(extId, index + 1);
        externalIdToComm.set(extId, comm);
      }
    });

    const getMessageType = (comm: Communication): "email" | "text" => {
      const type = comm.communication_type;
      if (type === "sms" || type === "imessage" || type === "text") {
        return "text";
      }
      return "email";
    };

    const getMessagePreview = (comm: Communication): string => {
      const body = comm.body_text || comm.body_plain || "";
      return body.slice(0, 100);
    };

    const getOriginalMessage = (comm: Communication): string => {
      const type = getMessageType(comm);
      if (type === "email") {
        return comm.subject || "(No Subject)";
      }
      const preview = getMessagePreview(comm);
      const participant = comm.sender || "Unknown";
      return preview ? `${participant}: ${preview.slice(0, 50)}...` : participant;
    };

    const usedFilenames = new Set<string>();

    for (const att of attachmentRows) {
      let comm: Communication | undefined;
      let commIndex: number | undefined;

      if (att.message_id) {
        comm = messageIdToComm.get(att.message_id);
        commIndex = messageIdToCommIndex.get(att.message_id);
      }

      if (!comm && att.email_id) {
        comm = messageIdToComm.get(att.email_id);
        commIndex = messageIdToCommIndex.get(att.email_id);
      }

      if (!comm && (att as any).external_message_id) {
        comm = externalIdToComm.get((att as any).external_message_id);
        commIndex = externalIdToCommIndex.get((att as any).external_message_id);
      }

      const originalFilename = att.filename || `attachment_${manifest.attachments.length + 1}`;

      let exportFilename = sanitizeFileName(originalFilename);
      let counter = 1;
      const baseName = exportFilename.replace(/\.[^.]+$/, "");
      const extension = exportFilename.includes(".") ? exportFilename.slice(exportFilename.lastIndexOf(".")) : "";

      while (usedFilenames.has(exportFilename)) {
        exportFilename = `${baseName}_${counter}${extension}`;
        counter++;
      }
      usedFilenames.add(exportFilename);

      const destPath = path.join(outputPath, exportFilename);

      const messageType = comm ? getMessageType(comm) : "email";
      const messagePreview = comm ? getMessagePreview(comm) : undefined;

      if (!att.storage_path) {
        logService.warn("[Folder Export] Attachment has no storage path", "FolderExport", {
          attachmentId: att.id,
          filename: att.filename,
        });
        manifest.attachments.push({
          filename: originalFilename,
          originalMessage: comm ? getOriginalMessage(comm) : "(No Subject)",
          date: (comm?.sent_at as string) || new Date().toISOString(),
          size: att.file_size_bytes || 0,
          sourceEmailIndex: commIndex,
          messageType,
          messagePreview,
          status: "file_not_found",
        });
        continue;
      }

      try {
        if (await this.fileExists(att.storage_path)) {
          await fs.copyFile(att.storage_path, destPath);
          manifest.attachments.push({
            filename: exportFilename,
            originalMessage: comm ? getOriginalMessage(comm) : "(No Subject)",
            date: (comm?.sent_at as string) || new Date().toISOString(),
            size: att.file_size_bytes || 0,
            sourceEmailIndex: commIndex,
            messageType,
            messagePreview,
            status: "exported",
          });
          logService.debug("[Folder Export] Exported attachment", "FolderExport", {
            filename: exportFilename,
            sourcePath: att.storage_path,
          });
        } else {
          logService.warn("[Folder Export] Attachment file not found", "FolderExport", {
            attachmentId: att.id,
            storagePath: att.storage_path,
          });
          manifest.attachments.push({
            filename: originalFilename,
            originalMessage: comm ? getOriginalMessage(comm) : "(No Subject)",
            date: (comm?.sent_at as string) || new Date().toISOString(),
            size: att.file_size_bytes || 0,
            sourceEmailIndex: commIndex,
            messageType,
            messagePreview,
            status: "file_not_found",
          });
        }
      } catch (copyError) {
        logService.warn("[Folder Export] Failed to copy attachment", "FolderExport", {
          filename: att.filename,
          error: copyError,
        });
        manifest.attachments.push({
          filename: originalFilename,
          originalMessage: comm ? getOriginalMessage(comm) : "(No Subject)",
          date: (comm?.sent_at as string) || new Date().toISOString(),
          size: att.file_size_bytes || 0,
          sourceEmailIndex: commIndex,
          messageType,
          messagePreview,
          status: "copy_failed",
        });
      }
    }

    // TASK-2050: Include email attachment metadata in manifest
    if (emailAttachmentResult) {
      manifest.emailAttachments = {
        totalCount: emailAttachmentResult.exported + emailAttachmentResult.skipped,
        exportedCount: emailAttachmentResult.exported,
        skippedCount: emailAttachmentResult.skipped,
        totalSizeBytes: emailAttachmentResult.totalSizeBytes,
        items: emailAttachmentResult.items
          .filter((item) => item.status === "exported")
          .map((item) => ({
            emailId: item.emailId,
            filename: item.filename,
            contentType: item.contentType,
            sizeBytes: item.sizeBytes,
            exportPath: item.exportPath,
          })),
        errors: emailAttachmentResult.errors,
      };
    }

    // Write manifest
    await fs.writeFile(
      path.join(outputPath, "manifest.json"),
      JSON.stringify(manifest, null, 2),
      "utf8"
    );

    logService.info("[Folder Export] Attachments export complete", "FolderExport", {
      total: attachmentRows.length,
      exported: manifest.attachments.filter((a) => a.status === "exported").length,
      notFound: manifest.attachments.filter((a) => a.status === "file_not_found").length,
      failed: manifest.attachments.filter((a) => a.status === "copy_failed").length,
      emailAttachmentsExported: emailAttachmentResult?.exported ?? 0,
    });
  }

  /**
   * Convert HTML to PDF using Electron's built-in capability
   */
  private async htmlToPdf(html: string): Promise<Buffer> {
    const tempDir = app.getPath("temp");
    const tempFile = path.join(tempDir, `export-${Date.now()}-${Math.random().toString(36).slice(2)}.html`);
    await fs.writeFile(tempFile, html, "utf8");

    let exportWindow: BrowserWindow | null = null;
    try {
      exportWindow = new BrowserWindow({
        width: 800,
        height: 1200,
        show: false,
        webPreferences: {
          nodeIntegration: false,
          contextIsolation: true,
        },
      });

      await exportWindow.loadFile(tempFile);
      await new Promise((resolve) => setTimeout(resolve, 500));

      const pdfData = await exportWindow.webContents.printToPDF({
        printBackground: true,
        landscape: false,
        pageSize: "Letter",
      });

      return pdfData;
    } finally {
      if (exportWindow && !exportWindow.isDestroyed()) {
        exportWindow.close();
      }
      try {
        await fs.unlink(tempFile);
      } catch {
        // Ignore cleanup errors
      }
    }
  }

  /**
   * Convert a single combined HTML document to PDF (BACKLOG-1584).
   *
   * Uses a sandboxed window and waits for `did-finish-load` (instead of the
   * fixed setTimeout used by htmlToPdf) so rendering — including file:// images
   * in text threads — completes reliably before printToPDF. sandbox:true hardens
   * against user-provided email/text content rendered in the window.
   * @private
   */
  private async combinedHtmlToPdf(html: string): Promise<Buffer> {
    const tempDir = app.getPath("temp");
    const tempFile = path.join(tempDir, `pdf-combine-${Date.now()}-${Math.random().toString(36).slice(2)}.html`);
    await fs.writeFile(tempFile, html, "utf8");

    let exportWindow: BrowserWindow | null = null;
    try {
      exportWindow = new BrowserWindow({
        width: 800,
        height: 1200,
        show: false,
        webPreferences: {
          nodeIntegration: false,
          contextIsolation: true,
          sandbox: true,
        },
      });

      await new Promise<void>((resolve, reject) => {
        const win = exportWindow!;
        win.webContents.on("did-finish-load", () => resolve());
        win.webContents.on("did-fail-load", (_event, errorCode, errorDescription) => {
          reject(new Error(`Failed to load combined PDF content: ${errorDescription} (code ${errorCode})`));
        });
        win.loadFile(tempFile);
      });

      const pdfData = await exportWindow.webContents.printToPDF({
        printBackground: true,
        landscape: false,
        pageSize: "Letter",
      });

      return pdfData;
    } finally {
      if (exportWindow && !exportWindow.isDestroyed()) {
        exportWindow.close();
      }
      try {
        await fs.unlink(tempFile);
      } catch {
        // Ignore cleanup errors
      }
    }
  }

  /**
   * Get default export path for a transaction
   */
  getDefaultExportPath(transaction: Transaction): string {
    const downloadsPath = app.getPath("downloads");
    const folderName = sanitizeFileName(
      `Transaction_${transaction.property_address}_${Date.now()}`
    );
    return path.join(downloadsPath, folderName);
  }

  /**
   * Check if a file exists at the given path
   */
  private async fileExists(filePath: string): Promise<boolean> {
    try {
      await fs.access(filePath);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Export transaction to a single combined PDF (BACKLOG-1584).
   *
   * Emits ONE HTML document — an index page (summary look) whose email/text rows
   * hyperlink to full sections, plus the full email-thread and text-thread
   * sections (same renderers/grouping as the per-file exports) each with an id
   * anchor and a back-link — and renders it once via Chromium `printToPDF`, which
   * preserves the internal `<a href="#...">` links. (The previous per-section PDF
   * + pdf-lib merge dropped all internal links.)
   *
   * @param emailExportMode retained for signature compatibility; the combined
   *   document always renders emails grouped by thread (the format that supports
   *   per-thread anchors).
   */
  async exportTransactionToCombinedPDF(
    transaction: TransactionWithDetails,
    communications: Communication[],
    outputPath: string,
    summaryOnly: boolean = false,
    _emailExportMode: "thread" | "individual" = "thread"
  ): Promise<string> {
    try {
      logService.info("[Folder Export] Starting combined PDF export", "FolderExport", {
        transactionId: transaction.id,
        outputPath,
        summaryOnly,
      });

      const html = await this.renderCombinedHTML(transaction, communications, summaryOnly);
      const pdfBuffer = await this.combinedHtmlToPdf(html);
      await fs.writeFile(outputPath, pdfBuffer);

      logService.info("[Folder Export] Combined PDF export complete", "FolderExport", {
        outputPath,
      });

      return outputPath;
    } catch (error) {
      logService.error("[Folder Export] Combined PDF export failed", "FolderExport", { error });
      throw error;
    }
  }

  /**
   * Build the single combined HTML document for the combined-PDF export.
   *
   * Grouping/sorting mirrors exportEmailThreads()/exportTextConversations() and
   * the summary index (generateSummaryHTML / generateTextIndex) so the index
   * rows line up 1:1 with the full sections they link to.
   * @private
   */
  private async renderCombinedHTML(
    transaction: TransactionWithDetails,
    communications: Communication[],
    summaryOnly: boolean
  ): Promise<string> {
    const emails = communications.filter((c) => isEmailMessage(c));
    const texts = communications.filter((c) => isTextMessage(c));

    const allHandles = extractParticipantHandles(texts);
    const phoneNameMap = await resolveAllHandles(allHandles, transaction.user_id);

    let userName: string | undefined;
    let userEmail: string | undefined;
    try {
      const user = await getUserById(transaction.user_id);
      if (user) {
        userName = user.display_name || user.first_name || user.email?.split("@")[0];
        userEmail = user.email || undefined;
      }
    } catch {
      // Ignore - will fall back to "You"
    }

    // Index page (reuses current summary look). Contacts/counts unchanged.
    // BACKLOG-2161: the combined document's email sections are per-THREAD (the
    // only format that supports per-thread anchors), so its index MUST be
    // thread-grouped too. Force "thread" regardless of the caller's Email Mode —
    // the summary email index then renders one row per thread, matching the
    // per-thread sections and emailRowTargets 1:1.
    const summaryHtml = generateSummaryHTML(transaction, communications, phoneNameMap, "thread");

    const sections: CombinedSection[] = [];
    // Per-INDEX-ROW section targets. The summary renders the EMAIL index per
    // THREAD, ordered oldest-first (groupEmailsForIndex), so emailRowTargets[i]
    // is the section id of the i-th rendered thread row (same order).
    const emailRowTargets: string[] = [];
    const textRowTargets: string[] = [];

    if (!summaryOnly) {
      // --- Email threads (grouped like exportEmailThreads) ---
      if (emails.length > 0) {
        // BACKLOG-2161: the summary email index now renders ONE row per THREAD in
        // Thread View (default), ordered oldest-first by thread start. Group and
        // order sections with the SAME canonical helper (groupEmailsForIndex) so
        // that the i-th index row, the i-th section, and emailRowTargets[i] are
        // the same thread — injectIndexLinks maps row N -> emailRowTargets[N]
        // positionally, so all three MUST share one order.
        const indexThreads = groupEmailsForIndex(emails);
        indexThreads.forEach((thread, threadIdx) => {
          const sectionId = emailThreadSectionId(threadIdx);
          sections.push({
            id: sectionId,
            html: generateEmailThreadHTML(
              thread.emails,
              getAttachmentsForEmail,
              sanitizeEmailBodyHtml
            ),
            backHref: `#${EMAIL_INDEX_ANCHOR}`,
            backLabel: "Back to Email Threads Index",
          });
          // One target per rendered index row (per thread), in render order.
          emailRowTargets.push(sectionId);
        });
      }

      // --- Text threads (grouped like exportTextConversations) ---
      if (texts.length > 0) {
        const textThreads = new Map<string, Communication[]>();
        for (const msg of texts) {
          const key = getThreadKey(msg);
          const thread = textThreads.get(key) || [];
          thread.push(msg);
          textThreads.set(key, thread);
        }
        // Sort messages within each thread chronologically.
        textThreads.forEach((msgs, key) => {
          textThreads.set(
            key,
            msgs.sort((a, b) => {
              const dateA = new Date(a.sent_at || a.received_at || 0).getTime();
              const dateB = new Date(b.sent_at || b.received_at || 0).getTime();
              return dateA - dateB;
            })
          );
        });

        // The summary text index (generateTextIndex) orders threads by their last
        // message, oldest-first. Match that order so index rows line up with the
        // full sections and their per-row ids.
        const orderedThreads = Array.from(textThreads.values()).sort((a, b) => {
          const lastA = a[a.length - 1];
          const lastB = b[b.length - 1];
          const dateA = new Date(lastA.sent_at || lastA.received_at || 0).getTime();
          const dateB = new Date(lastB.sent_at || lastB.received_at || 0).getTime();
          return dateA - dateB;
        });

        let textIdx = 0;
        for (const msgs of orderedThreads) {
          const contact = getThreadContact(msgs, phoneNameMap);
          const groupChat = isGroupChat(msgs);
          const participants = groupChat
            ? (await sharedResolveGroupChatParticipants(msgs, phoneNameMap, userName, userEmail))
                .map((p) => ({ phone: p.handle, name: p.name }))
            : undefined;
          const sectionId = textThreadSectionId(textIdx);
          sections.push({
            id: sectionId,
            html: generateTextThreadHTML(
              msgs,
              contact,
              phoneNameMap,
              groupChat,
              textIdx,
              participants,
              getAttachmentsForMessage
            ),
            // Text back-link → that thread's EXACT index row.
            backHref: `#${textIndexRowId(textIdx)}`,
            backLabel: "Back to Text Threads Index",
          });
          textRowTargets.push(sectionId);
          textIdx++;
        }
      }
    } else {
      logService.info("[Folder Export] Summary-only mode: index page only", "FolderExport");
    }

    const indexHtml = injectIndexLinks(summaryHtml, emailRowTargets, textRowTargets, summaryOnly);
    return buildCombinedHTML(indexHtml, sections);
  }
}

export default new FolderExportService();
