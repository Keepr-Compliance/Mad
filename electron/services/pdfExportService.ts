import { BrowserWindow, app } from "electron";
import path from "path";
import fs from "fs/promises";
import { JSDOM } from "jsdom";
import createDOMPurify, { type WindowLike } from "dompurify";
import { Transaction, Communication } from "../types/models";
import { isEmailMessage, isTextMessage } from "../utils/channelHelpers";
import { escapeHtml, formatCurrency, formatDate, formatDateTime, getContactNamesByHandles } from "../utils/exportUtils";
import logService from "./logService";
import { normalizePhone as sharedNormalizePhone, extractParticipantHandles } from "./contactResolutionService";
import { getThreadKey as sharedGetThreadKey } from "./folderExport/textExportHelpers";
// BACKLOG-2805: mirrors src/constants/transactionTypes.ts (electron cannot
// import from src/). Keep the two in step.
import { TRANSACTION_TYPE_LABELS } from "../constants/transactionTypeLabels";

// Create a DOMPurify instance using JSDOM for Node.js / Electron main process
const domPurifyWindow = new JSDOM("").window;
const DOMPurify = createDOMPurify(domPurifyWindow as unknown as WindowLike);

/**
 * PDF Export Service
 * Generates PDF reports for transactions using Electron's built-in PDF export
 * Uses HTML templates for beautiful, customizable reports
 */
class PDFExportService {
  private exportWindow: BrowserWindow | null;

  constructor() {
    this.exportWindow = null;
  }

  /**
   * Generate PDF for a transaction
   * @param transaction - Transaction object with all data
   * @param communications - Related emails
   * @param outputPath - Where to save the PDF
   * @returns Path to generated PDF
   */
  async generateTransactionPDF(
    transaction: Transaction,
    communications: Communication[],
    outputPath: string,
  ): Promise<string> {
    // Write HTML to temp file to avoid data URL length limits
    const tempDir = app.getPath("temp");
    const tempFile = path.join(tempDir, `pdf-export-${Date.now()}-${Math.random().toString(36).slice(2)}.html`);

    try {
      logService.info(
        "[PDF Export] Generating PDF for transaction:",
        "PDFExport",
        { transactionId: transaction.id },
      );

      // Create HTML content
      const html = this._generateHTML(transaction, communications);

      // Write HTML to temp file
      await fs.writeFile(tempFile, html, "utf8");

      // Create hidden, sandboxed window for PDF generation
      // sandbox + contextIsolation protect against user-provided data in transaction details
      this.exportWindow = new BrowserWindow({
        width: 800,
        height: 1200,
        show: false, // Hidden window
        webPreferences: {
          nodeIntegration: false,
          contextIsolation: true,
          sandbox: true,
        },
      });

      // Load HTML from temp file (avoids data URL length limits)
      // Use did-finish-load event instead of fixed setTimeout for reliable rendering
      await new Promise<void>((resolve, reject) => {
        const win = this.exportWindow!;
        win.webContents.on("did-finish-load", () => resolve());
        win.webContents.on("did-fail-load", (_event, errorCode, errorDescription) => {
          reject(new Error(`Failed to load PDF content: ${errorDescription} (code ${errorCode})`));
        });
        win.loadFile(tempFile);
      });

      // Generate PDF
      const pdfData = await this.exportWindow.webContents.printToPDF({
        printBackground: true,
        landscape: false,
        pageSize: "Letter",
      });

      // Save PDF
      await fs.writeFile(outputPath, pdfData);

      // Clean up
      this.exportWindow.close();
      this.exportWindow = null;

      logService.info("[PDF Export] PDF generated successfully:", "PDFExport", { outputPath });
      return outputPath;
    } catch (error) {
      logService.error("[PDF Export] Failed to generate PDF:", "PDFExport", { error });
      if (this.exportWindow) {
        this.exportWindow.close();
        this.exportWindow = null;
      }
      throw error;
    } finally {
      // Clean up temp file
      try {
        await fs.unlink(tempFile);
      } catch {
        // Ignore cleanup errors
      }
    }
  }

  /**
   * Generate HTML for PDF
   * @private
   */
  private _generateHTML(
    transaction: Transaction,
    communications: Communication[],
  ): string {
    return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <style>
    * {
      margin: 0;
      padding: 0;
      box-sizing: border-box;
    }

    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
      padding: 40px;
      color: #1a202c;
      background: white;
    }

    .header {
      border-bottom: 4px solid #667eea;
      padding-bottom: 20px;
      margin-bottom: 30px;
    }

    .header h1 {
      font-size: 28px;
      color: #1a202c;
      margin-bottom: 8px;
    }

    .header .address {
      font-size: 18px;
      color: #2d3748;
      margin-bottom: 4px;
    }

    .header .subtitle {
      font-size: 14px;
      color: #718096;
    }

    .details-grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 20px;
      margin-bottom: 30px;
    }

    .detail-card {
      border: 1px solid #e2e8f0;
      border-radius: 8px;
      padding: 16px;
      background: #f7fafc;
    }

    .detail-card .label {
      font-size: 12px;
      color: #718096;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      margin-bottom: 6px;
    }

    .detail-card .value {
      font-size: 18px;
      color: #1a202c;
      font-weight: 600;
    }

    .section {
      margin-bottom: 30px;
    }

    .section h3 {
      font-size: 18px;
      color: #2d3748;
      margin-bottom: 16px;
      padding-bottom: 8px;
      border-bottom: 2px solid #e2e8f0;
    }

    .communications {
      margin-top: 16px;
    }

    .communication {
      border: 1px solid #e2e8f0;
      border-radius: 6px;
      padding: 16px;
      margin-bottom: 12px;
      background: white;
      page-break-inside: avoid;
    }

    .communication .meta {
      display: flex;
      justify-content: space-between;
      margin-bottom: 8px;
      font-size: 12px;
      color: #718096;
    }

    .communication .subject {
      font-size: 14px;
      font-weight: 600;
      color: #2d3748;
      margin-bottom: 8px;
    }

    .communication .from {
      font-size: 13px;
      color: #4a5568;
      margin-bottom: 4px;
    }

    .footer {
      margin-top: 40px;
      padding-top: 20px;
      border-top: 1px solid #e2e8f0;
      font-size: 11px;
      color: #a0aec0;
      text-align: center;
    }

    .badge {
      display: inline-block;
      padding: 4px 12px;
      border-radius: 12px;
      font-size: 12px;
      font-weight: 600;
    }

    .badge-purchase {
      background: #c6f6d5;
      color: #276749;
    }

    .badge-sale {
      background: #bee3f8;
      color: #2c5282;
    }

    .view-full-link {
      color: #667eea;
      text-decoration: none;
      font-size: 12px;
      font-weight: 500;
    }

    .view-full-link:hover {
      text-decoration: underline;
    }

    .appendix {
      margin-top: 60px;
      page-break-before: always;
    }

    .appendix h2 {
      font-size: 24px;
      color: #1a202c;
      margin-bottom: 24px;
      padding-bottom: 12px;
      border-bottom: 4px solid #667eea;
    }

    .appendix-item {
      border: 1px solid #e2e8f0;
      border-radius: 8px;
      padding: 20px;
      margin-bottom: 24px;
      background: white;
      page-break-inside: avoid;
      page-break-before: always;
    }

    .appendix-item .header-row {
      display: flex;
      justify-content: space-between;
      align-items: flex-start;
      margin-bottom: 12px;
      padding-bottom: 12px;
      border-bottom: 1px solid #e2e8f0;
    }

    .appendix-item .msg-id {
      font-size: 11px;
      color: #a0aec0;
      background: #f7fafc;
      padding: 2px 8px;
      border-radius: 4px;
    }

    .appendix-item .subject-line {
      font-size: 16px;
      font-weight: 600;
      color: #2d3748;
      margin-bottom: 8px;
    }

    .appendix-item .meta-info {
      font-size: 13px;
      color: #4a5568;
      margin-bottom: 4px;
    }

    .appendix-item .message-body {
      margin-top: 16px;
      padding: 16px;
      background: #f7fafc;
      border-radius: 6px;
      font-size: 13px;
      line-height: 1.6;
      color: #2d3748;
      word-wrap: break-word;
      overflow-wrap: break-word;
    }

    /* Plain text message body (for SMS/texts) */
    .appendix-item .message-body-plain {
      white-space: pre-wrap;
    }

    /* Rich HTML email body styles */
    .appendix-item .message-body-html {
      /* White background for HTML emails so their own styling shows properly */
      background: white;
      border: 1px solid #e2e8f0;
    }

    .appendix-item .message-body-html img {
      max-width: 100%;
      height: auto;
    }

    .appendix-item .message-body-html table {
      max-width: 100%;
      border-collapse: collapse;
    }

    .appendix-item .message-body-html a {
      color: #667eea;
      text-decoration: underline;
    }

    .appendix-item .message-body-html blockquote {
      margin: 8px 0;
      padding-left: 12px;
      border-left: 3px solid #e2e8f0;
      color: #718096;
    }

    .appendix-item .message-body-html ul,
    .appendix-item .message-body-html ol {
      padding-left: 24px;
      margin: 8px 0;
    }

    .appendix-item .message-body-html p {
      margin: 8px 0;
    }

    .appendix-item .message-body-html h1,
    .appendix-item .message-body-html h2,
    .appendix-item .message-body-html h3,
    .appendix-item .message-body-html h4 {
      margin: 12px 0 8px 0;
      color: #2d3748;
    }

    .back-to-top {
      color: #667eea;
      text-decoration: none;
      font-size: 12px;
      display: inline-block;
      margin-top: 16px;
      padding-top: 12px;
      border-top: 1px solid #e2e8f0;
      width: 100%;
    }

    @media print {
      body {
        padding: 20px;
      }
    }

    /* Page numbers */
    @page {
      @bottom-center {
        content: "Page " counter(page) " of " counter(pages);
        font-size: 10px;
        color: #718096;
      }
    }
  </style>
</head>
<body>
  <!-- Header -->
  <div class="header">
    <h1>Transaction Audit Report</h1>
    <div class="address">${transaction.property_address || "N/A"}</div>
    <div class="subtitle">Generated on ${formatDateTime(new Date().toISOString())}</div>
  </div>

  <!-- Transaction Details -->
  <div class="details-grid">
    <div class="detail-card">
      <div class="label">Transaction Type</div>
      <div class="value">
        ${transaction.transaction_type ? `<span class="badge badge-${transaction.transaction_type}">${transaction.transaction_type === "purchase" ? TRANSACTION_TYPE_LABELS.purchase : TRANSACTION_TYPE_LABELS.sale}</span>` : "N/A"}
      </div>
    </div>

    <div class="detail-card">
      <div class="label">Sale Price</div>
      <div class="value">${formatCurrency(transaction.sale_price)}</div>
    </div>

    <div class="detail-card">
      <div class="label">Closing Date</div>
      <div class="value">${formatDate(transaction.closed_at)}</div>
    </div>

    <div class="detail-card">
      <div class="label">Listing Price</div>
      <div class="value">${formatCurrency(transaction.listing_price)}</div>
    </div>

    <div class="detail-card">
      <div class="label">Earnest Money</div>
      <div class="value">${formatCurrency(transaction.earnest_money_amount)}</div>
    </div>

    <div class="detail-card">
      <div class="label">Total Communications</div>
      <div class="value">${transaction.total_communications_count || communications.length}</div>
    </div>
  </div>

  <!-- Communications -->
  ${this._generateCommunicationsHTML(communications, formatDateTime)}

  <!-- Footer -->
  <div class="footer">
    <p>This report was automatically generated by Keepr</p>
    <p>Transaction ID: ${transaction.id}</p>
  </div>
</body>
</html>
    `;
  }

  /**
   * Generate communications HTML with hyperlinks to full content appendix
   * Groups text messages by thread/conversation like the UI does
   * @private
   */
  private _generateCommunicationsHTML(
    communications: Communication[],
    formatDateTime: (dateString: string | Date) => string
  ): string {
    // Split communications by type (with subject-based fallback for untyped records)
    const emails = communications.filter(c =>
      isEmailMessage(c) ||
      (!c.channel && !c.communication_type && c.subject && c.subject.length > 0)
    );
    const texts = communications.filter(c =>
      isTextMessage(c) ||
      (!c.channel && !c.communication_type && (!c.subject || c.subject.length === 0))
    );

    // TASK-2288: Extract ALL participant handles (from, to, chat_members, sender)
    // for complete contact name resolution. Previously only extracted sender phones,
    // causing "Unknown Contact" for outbound message recipients and email handles.
    const allHandles = extractParticipantHandles(texts);
    const phoneNameMap = getContactNamesByHandles(allHandles);

    // Sanitize HTML for PDF display using DOMPurify (BACKLOG-1081)
    // Replaces previous regex-based sanitization which was fundamentally unreliable
    const sanitizeHtml = (html: string | null | undefined): string => {
      if (!html) return '';

      // Use DOMPurify with an allowlist of safe formatting tags
      // This strips scripts, event handlers, iframes, forms, and all dangerous content
      const sanitized = DOMPurify.sanitize(html, {
        // Allow safe formatting tags for email display
        ALLOWED_TAGS: [
          'a', 'b', 'blockquote', 'br', 'caption', 'cite', 'code',
          'col', 'colgroup', 'dd', 'div', 'dl', 'dt', 'em', 'h1',
          'h2', 'h3', 'h4', 'h5', 'h6', 'hr', 'i', 'img', 'li',
          'ol', 'p', 'pre', 'small', 'span', 'strong', 'sub', 'sup',
          'table', 'tbody', 'td', 'tfoot', 'th', 'thead', 'tr', 'u', 'ul',
        ],
        // Allow safe attributes for display/formatting
        ALLOWED_ATTR: [
          'href', 'src', 'alt', 'title', 'width', 'height', 'style',
          'class', 'colspan', 'rowspan', 'align', 'valign', 'border',
          'cellpadding', 'cellspacing', 'dir', 'lang',
        ],
        // Block dangerous URI schemes
        ALLOWED_URI_REGEXP: /^(?:(?:https?|mailto|tel):|[^a-z]|[a-z+.-]+(?:[^a-z+.\-:]|$))/i,
        // Remove entire tag (not just attributes) for dangerous elements
        FORBID_TAGS: ['script', 'style', 'iframe', 'object', 'embed', 'form', 'input', 'button', 'textarea', 'meta', 'link', 'base'],
        // Strip document-level wrappers (html, head, body) automatically
        WHOLE_DOCUMENT: false,
      });

      // Remove background-color styles that could affect the PDF page
      return sanitized.replace(/background(-color)?\s*:\s*[^;"}]+[;"]?/gi, '');
    };

    // Helper to truncate preview text
    // Returns plain text (NOT escaped) — caller must escape when inserting into HTML
    // to avoid double-escaping (e.g., &amp; becoming &amp;amp;)
    const truncatePreview = (text: string | null | undefined, maxLen = 80): string => {
      if (!text) return '(No content)';
      const cleaned = text.replace(/\n/g, ' ').replace(/\s+/g, ' ').trim();
      if (cleaned.length <= maxLen) return cleaned;
      return cleaned.substring(0, maxLen) + '...';
    };

    // TASK-2027: Use shared normalizePhone that handles email handles correctly
    const normalizePhone = sharedNormalizePhone;

    // BACKLOG-1084: Use shared getThreadKey for consistent thread deduplication
    // (prefers thread_id, falls back to subject+participants for emails,
    //  phone-based participants for texts, message id as last resort)
    const getThreadKey = sharedGetThreadKey;

    // Helper to extract phone/contact name from thread
    const getThreadContact = (msgs: Communication[]): { phone: string; name: string | null } => {
      for (const msg of msgs) {
        try {
          if (msg.participants) {
            const parsed = typeof msg.participants === 'string'
              ? JSON.parse(msg.participants)
              : msg.participants;

            let phone: string | null = null;
            if (msg.direction === 'inbound' && parsed.from) {
              phone = parsed.from;
            } else if (msg.direction === 'outbound' && parsed.to?.length > 0) {
              phone = Array.isArray(parsed.to) ? parsed.to[0] : parsed.to;
            }

            if (phone) {
              const normalized = normalizePhone(phone);
              const name = phoneNameMap[normalized] || phoneNameMap[phone] || null;
              return { phone, name };
            }
          }
        } catch {
          // Continue
        }

        // Fallback to sender
        if (msg.sender) {
          const normalized = normalizePhone(msg.sender);
          const name = phoneNameMap[normalized] || phoneNameMap[msg.sender] || null;
          return { phone: msg.sender, name };
        }
      }
      return { phone: 'Unknown', name: null };
    };

    // Group text messages by thread
    const textThreads = new Map<string, Communication[]>();
    texts.forEach(msg => {
      const key = getThreadKey(msg);
      const thread = textThreads.get(key) || [];
      thread.push(msg);
      textThreads.set(key, thread);
    });

    // Sort messages within each thread chronologically
    textThreads.forEach((msgs, key) => {
      textThreads.set(key, msgs.sort((a, b) => {
        const dateA = new Date(a.sent_at || a.received_at || 0).getTime();
        const dateB = new Date(b.sent_at || b.received_at || 0).getTime();
        return dateA - dateB;
      }));
    });

    // Convert to array and sort threads by most recent message
    const sortedThreads = Array.from(textThreads.entries()).sort((a, b) => {
      const lastA = a[1][a[1].length - 1];
      const lastB = b[1][b[1].length - 1];
      const dateA = new Date(lastA.sent_at || lastA.received_at || 0).getTime();
      const dateB = new Date(lastB.sent_at || lastB.received_at || 0).getTime();
      return dateB - dateA; // Most recent first
    });

    // Sort emails by date (most recent first)
    const sortedEmails = [...emails].sort((a, b) =>
      new Date(b.sent_at as string).getTime() - new Date(a.sent_at as string).getTime()
    );

    // Check if there's any content for appendix
    // Note: HTML content is in 'body' field, not 'body_html'
    const emailsWithContent = sortedEmails.filter(c => c.body_text || c.body_plain || (c as { body?: string }).body);
    const threadsWithContent = sortedThreads.filter(([_, msgs]) =>
      msgs.some(m => m.body_text || m.body_plain)
    );
    const hasAppendix = emailsWithContent.length > 0 || threadsWithContent.length > 0;

    let html = '';

    // Email Threads Section
    if (sortedEmails.length > 0) {
      html += '<div class="section">';
      html += '<a name="email-threads"></a>';
      html += '<h3>Email Threads (' + sortedEmails.length + ')</h3>';
      html += '<div class="communications">';

      sortedEmails.forEach((comm, idx) => {
        const hasContent = comm.body_text || comm.body_plain || (comm as { body?: string }).body;
        const anchorId = 'email-' + idx;
        html += '<div class="communication">';
        html += '<div class="subject">' + (escapeHtml(comm.subject || '') || '(No Subject)') + '</div>';
        html += '<div class="from">From: ' + (escapeHtml(comm.sender || '') || 'Unknown') + '</div>';
        html += '<div class="meta">';
        html += '<span>' + formatDateTime(comm.sent_at as string) + '</span>';
        if (hasContent) {
          html += '<a href="#' + anchorId + '" class="view-full-link">View Full &rarr;</a>';
        }
        html += '</div></div>';
      });

      html += '</div></div>';
    }

    // Text Threads Section (grouped by conversation)
    if (sortedThreads.length > 0) {
      html += '<div class="section">';
      html += '<a name="text-conversations"></a>';
      html += '<h3>Text Conversations (' + sortedThreads.length + ')</h3>';
      html += '<div class="communications">';

      sortedThreads.forEach(([_threadId, msgs], idx) => {
        const contact = getThreadContact(msgs);
        const lastMsg = msgs[msgs.length - 1];
        const preview = truncatePreview(lastMsg.body_text || lastMsg.body_plain);
        const hasContent = msgs.some(m => m.body_text || m.body_plain);
        const anchorId = 'thread-' + idx;
        const isGroupChat = this._isGroupChat(msgs);

        html += '<div class="communication">';
        // Contact name in bold (or phone if no name)
        html += '<div class="subject">' + escapeHtml(contact.name || contact.phone);
        if (isGroupChat) {
          html += ' <span style="font-size: 11px; color: #718096; font-weight: normal;">(Group Chat)</span>';
        }
        html += '</div>';
        // Phone number on separate line (only if we have a name)
        if (contact.name) {
          html += '<div style="font-size: 12px; color: #718096;">' + escapeHtml(contact.phone) + '</div>';
        }
        html += '<div style="font-size: 13px; color: #4a5568; margin: 8px 0;">' + escapeHtml(preview) + '</div>';
        html += '<div class="meta">';
        html += '<span>' + msgs.length + ' message' + (msgs.length === 1 ? '' : 's');
        html += ' &middot; ' + formatDateTime(lastMsg.sent_at as string) + '</span>';
        if (hasContent) {
          html += '<a href="#' + anchorId + '" class="view-full-link">View Full &rarr;</a>';
        }
        html += '</div></div>';
      });

      html += '</div></div>';
    }

    // If no communications at all
    if (sortedEmails.length === 0 && sortedThreads.length === 0) {
      html += '<div class="section">';
      html += '<h3>Related Communications (0)</h3>';
      html += '<div class="communications">';
      html += '<p style="color: #718096; font-style: italic;">No communications linked to this transaction.</p>';
      html += '</div></div>';
    }

    // Appendix: Full Messages
    if (hasAppendix) {
      html += '<div class="appendix">';
      html += '<a name="appendix"></a>';
      html += '<h2>Full Message Content</h2>';

      // Navigation links at top of appendix
      html += '<div style="margin-bottom: 24px; padding: 12px; background: #f7fafc; border-radius: 8px; font-size: 13px;">';
      html += '<span style="color: #4a5568; font-weight: 500;">Quick Navigation:</span> ';
      if (emailsWithContent.length > 0) {
        html += '<a href="#email-threads" style="color: #667eea; text-decoration: none; margin-left: 12px;">&larr; Back to Email Threads</a>';
      }
      if (threadsWithContent.length > 0) {
        if (emailsWithContent.length > 0) html += ' <span style="color: #cbd5e0; margin: 0 8px;">|</span> ';
        html += '<a href="#text-conversations" style="color: #667eea; text-decoration: none;">&larr; Back to Text Conversations</a>';
      }
      html += '</div>';

      // Email appendix items
      emailsWithContent.forEach((comm, idx) => {
        // Prefer HTML body for rich formatting, fall back to plain text
        // Note: The query returns HTML content in 'body' field (not 'body_html')
        const htmlBody = (comm as { body?: string }).body;
        // Check for actual HTML tags (not just angle brackets from URLs like <https://...>)
        // Look for common HTML tags that indicate rich content
        const hasHtmlBody = htmlBody && htmlBody.trim().length > 0 &&
          (/<(html|body|div|p|table|tr|td|span|a\s|img|br|hr|h[1-6]|ul|ol|li|strong|em|b|i)\b/i.test(htmlBody));
        let bodyContent: string;
        let bodyClass: string;

        if (hasHtmlBody) {
          // Use sanitized HTML for rich formatting
          bodyContent = sanitizeHtml(htmlBody);
          bodyClass = 'message-body message-body-html';
        } else {
          // Fall back to plain text
          const plainText = comm.body_text || comm.body_plain || '';
          bodyContent = escapeHtml(plainText);
          bodyClass = 'message-body message-body-plain';
        }

        html += '<div class="appendix-item">';
        html += '<a name="email-' + idx + '"></a>';
        html += '<div class="header-row">';
        html += '<div>';
        html += '<div class="subject-line">' + (escapeHtml(comm.subject || '') || '(No Subject)') + '</div>';
        html += '<div class="meta-info">From: ' + (escapeHtml(comm.sender || '') || 'Unknown') + '</div>';
        html += '<div class="meta-info">' + formatDateTime(comm.sent_at as string) + '</div>';
        html += '</div>';
        html += '<span class="msg-id">Email #' + (idx + 1) + '</span>';
        html += '</div>';
        html += '<div class="' + bodyClass + '">' + bodyContent + '</div>';
        html += '<a href="#email-threads" class="back-to-top">&larr; Back to Email Threads</a>';
        html += '</div>';
      });

      // Text thread appendix items (show all messages in thread)
      threadsWithContent.forEach(([_threadId, msgs], threadIdx) => {
        const contact = getThreadContact(msgs);
        const isGroupChat = this._isGroupChat(msgs);

        html += '<div class="appendix-item">';
        html += '<a name="thread-' + threadIdx + '"></a>';
        html += '<div class="header-row">';
        html += '<div>';
        // Group chats show "Group Chat", 1:1 shows "Conversation with [name]"
        if (isGroupChat) {
          html += '<div class="subject-line">Group Chat</div>';
        } else {
          html += '<div class="subject-line">Conversation with ' + escapeHtml(contact.name || contact.phone) + '</div>';
          // Show phone on separate line if we have a contact name (1:1 only)
          if (contact.name) {
            html += '<div class="meta-info">' + escapeHtml(contact.phone) + '</div>';
          }
        }
        html += '<div class="meta-info">' + msgs.length + ' message' + (msgs.length === 1 ? '' : 's') + '</div>';
        html += '</div>';
        html += '<span class="msg-id">Thread #' + (threadIdx + 1) + '</span>';
        html += '</div>';

        // Show each message in the thread (text messages use plain text formatting)
        html += '<div class="message-body message-body-plain">';
        msgs.forEach((msg, msgIdx) => {
          const isOutbound = msg.direction === 'outbound';
          let senderName = 'You';
          let senderPhone: string | null = null;

          if (!isOutbound) {
            // For group chats, try to show individual sender
            if (isGroupChat && msg.sender) {
              const senderNormalized = normalizePhone(msg.sender);
              const resolvedName = phoneNameMap[senderNormalized] || phoneNameMap[msg.sender];
              senderName = resolvedName || msg.sender;
              // Show phone if we resolved to a name (group chats only)
              if (resolvedName) {
                senderPhone = msg.sender;
              }
            } else {
              // Use thread contact info
              senderName = contact.name || contact.phone;
              // For 1:1 chats, don't show phone under each message (it's redundant)
              // Phone is already shown in thread header
            }
          }
          const body = msg.body_text || msg.body_plain || '';
          const time = formatDateTime(msg.sent_at as string);

          if (msgIdx > 0) html += '<hr style="border: none; border-top: 1px solid #e2e8f0; margin: 12px 0;">';
          // Name in bold with timestamp
          html += '<div style="margin-bottom: 4px;">';
          html += '<strong>' + escapeHtml(senderName) + '</strong>';
          html += ' <span style="color: #718096; font-size: 11px;">' + time + '</span>';
          html += '</div>';
          // Phone number below name (only for group chats to identify sender)
          if (senderPhone && isGroupChat) {
            html += '<div style="font-size: 11px; color: #718096; margin-bottom: 8px;">' + escapeHtml(senderPhone) + '</div>';
          }
          html += '<div>' + escapeHtml(body) + '</div>';
        });
        html += '</div>';

        html += '<a href="#text-conversations" class="back-to-top">&larr; Back to Text Conversations</a>';
        html += '</div>';
      });

      html += '</div>';
    }

    return html;
  }

  /**
   * Check if a thread is a group chat (has multiple unique participants)
   * @private
   */
  private _isGroupChat(msgs: Communication[]): boolean {
    const participants = new Set<string>();

    for (const msg of msgs) {
      try {
        if (msg.participants) {
          const parsed = typeof msg.participants === 'string'
            ? JSON.parse(msg.participants)
            : msg.participants;

          // TASK-2027: Use shared normalizePhone to handle email handles correctly
          if (parsed.from) participants.add(sharedNormalizePhone(parsed.from));
          if (parsed.to) {
            const toList = Array.isArray(parsed.to) ? parsed.to : [parsed.to];
            toList.forEach((p: string) => participants.add(sharedNormalizePhone(p)));
          }
        }
      } catch {
        // Continue
      }
    }

    // More than 2 unique participants means group chat
    return participants.size > 2;
  }

  /**
   * Get default export path for a transaction
   */
  getDefaultExportPath(transaction: Transaction): string {
    const downloadsPath = app.getPath("downloads");
    const fileName = `Transaction_${transaction.property_address?.replace(/[^a-z0-9]/gi, "_")}_${Date.now()}.pdf`;
    return path.join(downloadsPath, fileName);
  }
}

export default new PDFExportService();
