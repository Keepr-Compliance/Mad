/**
 * Email Export Helpers
 * Pure utility functions for email HTML generation and content processing.
 * Extracted from folderExportService.ts for maintainability.
 */

import type { Communication } from "../../types/models";
import { escapeHtml } from "../../utils/exportUtils";

/**
 * Format a date/time for display in exported emails.
 */
export function formatEmailDateTime(dateString: string | Date): string {
  if (!dateString) return "N/A";
  const date = typeof dateString === "string" ? new Date(dateString) : dateString;
  return date.toLocaleString("en-US", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/**
 * Detect whether a string is HTML content (more robust than simple `<` check).
 */
export function isHtmlContent(body: string | null | undefined): boolean {
  if (!body) return false;
  return /<(?:html|div|p|br|table|span|head|body|style|meta|img|a|ul|ol|li|h[1-6])\b/i.test(body);
}

/**
 * Strip "Re:", "Fwd:", "FW:" prefixes from email subjects for cleaner thread headers.
 */
export function stripSubjectPrefixes(subject: string): string {
  return subject.replace(/^(?:(?:Re|Fwd|FW)\s*:\s*)+/i, "").trim();
}

/**
 * Strip quoted content from HTML email bodies.
 * Handles Outlook (Graph API), Gmail, Proton Mail, and generic email reply patterns.
 *
 * TECH DEBT: The caller injects raw HTML body content into PDF templates without
 * sanitization. This is a known XSS risk -- malicious email HTML could contain
 * <script>, <iframe>, or event handlers. Since PDFs are rendered in a temporary
 * BrowserWindow, this could execute code in Electron's context. A proper HTML
 * sanitizer (e.g. sanitize-html) should be applied before injection.
 * See backlog for tracking.
 */
export function stripHtmlQuotedContent(html: string): string {
  let result = html;

  // --- Outlook / Microsoft Graph patterns ---
  // Outlook mobile separator line + <hr> + divRplyFwdMsg (entire quoted block)
  result = result.replace(/<div[^>]*id=["']ms-outlook-mobile-body-separator-line["'][^>]*>[\s\S]*$/gi, "");
  // Outlook reply divider: <hr tabindex="-1" ...> followed by <div id="divRplyFwdMsg">
  result = result.replace(/<hr[^>]*tabindex=["']-1["'][^>]*>[\s\S]*$/gi, "");
  // Outlook reply divider: <div id="divRplyFwdMsg"> or <div id="x_divRplyFwdMsg">
  result = result.replace(/<div[^>]*id=["'](?:x_)?divRplyFwdMsg["'][^>]*>[\s\S]*$/gi, "");
  // Outlook separator: <hr> with display:inline-block (Outlook-specific pattern)
  result = result.replace(/<hr[^>]*style=["'][^"']*display:\s*inline-block[^"']*border-top[^"']*["'][^>]*>[\s\S]*$/gi, "");
  result = result.replace(/<hr[^>]*style=["'][^"']*border-top[^"']*display:\s*inline-block[^"']*["'][^>]*>[\s\S]*$/gi, "");
  // Outlook "From:" block: uses border:none + border-top (Outlook's specific separator pattern)
  result = result.replace(/<div[^>]*style=["'][^"']*border:\s*none[^"']*border-top[^"']*["'][^>]*>[\s\S]*$/gi, "");

  // --- Proton Mail patterns ---
  // Proton Mail wraps quotes in <div class="protonmail_quote">...<blockquote class="protonmail_quote">
  result = result.replace(/<div[^>]*class=["'][^"']*protonmail_quote[^"']*["'][^>]*>[\s\S]*$/gi, "");

  // --- Gmail patterns ---
  // Gmail quoted blocks: <div class="gmail_quote">...</div> (greedy to end -- quote is always last)
  result = result.replace(/<div[^>]*class=["'][^"']*gmail_quote[^"']*["'][^>]*>[\s\S]*$/gi, "");
  // Gmail blockquotes: <blockquote class="gmail_quote">
  result = result.replace(/<blockquote[^>]*class=["'][^"']*gmail_quote[^"']*["'][^>]*>[\s\S]*?<\/blockquote>/gi, "");

  // --- Generic patterns ---
  // Generic <blockquote> with type="cite" (used by many clients for quoted replies)
  result = result.replace(/<blockquote[^>]*type=["']cite["'][^>]*>[\s\S]*?<\/blockquote>/gi, "");
  // "-----Original Message-----" text (Outlook plain-style within HTML)
  result = result.replace(/<div[^>]*>-{3,}\s*Original Message\s*-{3,}[\s\S]*$/gi, "");
  result = result.replace(/-{3,}\s*Original Message\s*-{3,}[\s\S]*$/gi, "");
  // "On [date] ... wrote:" lines (Gmail/Apple Mail reply headers)
  result = result.replace(/<div[^>]*>On\s.{10,80}\s+wrote:\s*<\/div>/gi, "");
  result = result.replace(/<p[^>]*>On\s.{10,80}\s+wrote:\s*<\/p>/gi, "");

  return result.trim();
}

/**
 * Strip quoted content from plain text email bodies.
 * Removes lines starting with ">", "On ... wrote:" headers, and "Original Message" dividers.
 */
export function stripPlainTextQuotedContent(text: string): string {
  const lines = text.split("\n");
  const result: string[] = [];
  for (const line of lines) {
    // Stop at "On ... wrote:" line
    if (/^On\s.{10,80}\s+wrote:\s*$/i.test(line.trim())) break;
    // Stop at "-----Original Message-----"
    if (/^-{3,}\s*Original Message\s*-{3,}/i.test(line.trim())) break;
    // Skip quoted lines (starting with >)
    if (/^\s*>/.test(line)) continue;
    result.push(line);
  }
  return result.join("\n").trim();
}

/**
 * Strip quoted content from an email body (routes to HTML or plain text handler).
 */
export function stripQuotedContent(body: string, isHtml: boolean): string {
  return isHtml
    ? stripHtmlQuotedContent(body)
    : stripPlainTextQuotedContent(body);
}

/**
 * Generate HTML for an email thread -- all messages in one document with separators.
 * Quotes are stripped from each message since the full thread provides context.
 *
 * @param sanitizeHtml Optional HTML sanitizer (BACKLOG-1584). When provided, HTML
 *   email bodies are routed through it before injection. Used by the combined-PDF
 *   path, where all content renders in a single BrowserWindow, to close the raw-HTML
 *   XSS gap noted in stripHtmlQuotedContent. When omitted, behavior is unchanged
 *   (per-file /emails export renders each thread in its own isolated window).
 */
export function generateEmailThreadHTML(
  emails: Communication[],
  getAttachmentsForEmail: (emailId: string) => { filename: string; file_size_bytes: number | null }[],
  sanitizeHtml?: (html: string) => string
): string {
  const messagesHtml = emails.map((email, idx) => {
    const rawBody = email.body || email.body_plain || "(No content)";
    const isHtmlBody = isHtmlContent(email.body);
    let bodyContent = rawBody !== "(No content)"
      ? stripQuotedContent(rawBody, isHtmlBody)
      : rawBody;
    // BACKLOG-1584: sanitize rich HTML bodies when a sanitizer is supplied.
    if (isHtmlBody && sanitizeHtml && bodyContent !== "(No content)") {
      bodyContent = sanitizeHtml(bodyContent);
    }

    const attachments = email.id ? getAttachmentsForEmail(email.id) : [];

    return `
      ${idx > 0 ? '<hr class="thread-separator">' : ""}
      <div class="thread-message">
        <div class="thread-msg-header">
          <div class="thread-msg-subject">${escapeHtml(email.subject || "(No Subject)")}</div>
          <div class="thread-msg-meta">
            <span class="label">From:</span> ${escapeHtml(email.sender || "Unknown")}
          </div>
          <div class="thread-msg-meta">
            <span class="label">To:</span> ${escapeHtml(email.recipients || "Unknown")}
          </div>
          ${email.cc ? `<div class="thread-msg-meta"><span class="label">CC:</span> ${escapeHtml(email.cc)}</div>` : ""}
          <div class="thread-msg-meta">
            <span class="label">Date:</span> ${formatEmailDateTime(email.sent_at as string)}
          </div>
        </div>
        <div class="thread-msg-body ${!isHtmlBody ? "email-body-text" : ""}">
          ${isHtmlBody ? bodyContent : escapeHtml(bodyContent)}
        </div>
        ${attachments.length > 0 ? `
        <div class="thread-msg-attachments">
          <span class="att-label">Attachments:</span> ${attachments.map(a => escapeHtml(a.filename)).join(", ")}
        </div>` : ""}
      </div>`;
  }).join("");

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
    .thread-header {
      border-bottom: 4px solid #667eea;
      padding-bottom: 20px;
      margin-bottom: 30px;
    }
    .thread-header h1 { font-size: 20px; color: #1a202c; margin-bottom: 4px; }
    .thread-header .meta { font-size: 13px; color: #718096; }
    .thread-separator {
      border: none;
      border-top: 2px solid #e2e8f0;
      margin: 24px 0;
    }
    .thread-message { margin-bottom: 16px; }
    .thread-msg-header { margin-bottom: 12px; }
    .thread-msg-subject { font-size: 16px; font-weight: 600; color: #2d3748; margin-bottom: 6px; }
    .thread-msg-meta { font-size: 13px; color: #4a5568; margin-bottom: 2px; }
    .thread-msg-meta .label { font-weight: 600; color: #718096; display: inline-block; width: 50px; }
    .thread-msg-body { padding: 12px 0; line-height: 1.6; font-size: 14px; }
    .email-body-text { white-space: pre-wrap; }
    .thread-msg-attachments {
      font-size: 12px;
      color: #718096;
      padding-top: 8px;
      border-top: 1px solid #f0f0f0;
    }
    .thread-msg-attachments .att-label { font-weight: 600; }
    @media print { body { padding: 20px; } }
  </style>
</head>
<body>
  <div class="thread-header">
    <h1>${escapeHtml(stripSubjectPrefixes(emails[0].subject || "(No Subject)"))}</h1>
    <div class="meta">${emails.length} message${emails.length !== 1 ? "s" : ""} in thread</div>
  </div>
  ${messagesHtml}
</body>
</html>
    `;
}

/**
 * Generate HTML for a single email
 * TASK-1780: Updated to list attachment filenames instead of generic message
 */
export function generateEmailHTML(
  email: Communication,
  attachments: { filename: string; file_size_bytes: number | null }[] = [],
  stripQuotes: boolean = false
): string {
  // TASK-1780: Format file size for display
  const formatFileSize = (bytes: number | null): string => {
    if (bytes === null || bytes === 0) return "";
    if (bytes < 1024) return ` (${bytes} B)`;
    if (bytes < 1024 * 1024) return ` (${(bytes / 1024).toFixed(1)} KB)`;
    return ` (${(bytes / (1024 * 1024)).toFixed(1)} MB)`;
  };

  // Use HTML body if available, otherwise use plain text
  const rawBody = email.body || email.body_plain || "(No content)";
  const isHtmlBody = isHtmlContent(email.body);
  const bodyContent = stripQuotes && rawBody !== "(No content)"
    ? stripQuotedContent(rawBody, isHtmlBody)
    : rawBody;

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
    .email-header {
      border-bottom: 2px solid #e2e8f0;
      padding-bottom: 20px;
      margin-bottom: 20px;
    }
    .email-subject {
      font-size: 20px;
      font-weight: 600;
      color: #1a202c;
      margin-bottom: 16px;
    }
    .email-meta {
      font-size: 14px;
      color: #4a5568;
    }
    .email-meta div { margin-bottom: 6px; }
    .email-meta .label {
      font-weight: 600;
      color: #718096;
      display: inline-block;
      width: 60px;
    }
    .email-body {
      padding: 20px 0;
      line-height: 1.6;
      font-size: 14px;
    }
    .email-body-text { white-space: pre-wrap; }
    .attachments {
      margin-top: 20px;
      padding-top: 20px;
      border-top: 1px solid #e2e8f0;
    }
    .attachments h4 {
      font-size: 14px;
      color: #718096;
      margin-bottom: 8px;
    }
    .attachments ul {
      list-style: none;
      padding: 0;
      margin: 0;
    }
    .attachments li {
      font-size: 13px;
      color: #4a5568;
      padding: 4px 0;
      border-bottom: 1px solid #f0f0f0;
    }
    .attachments li:last-child {
      border-bottom: none;
    }
    .attachments .file-size {
      color: #a0aec0;
      font-size: 12px;
    }
    .attachments .note {
      font-size: 12px;
      color: #a0aec0;
      margin-top: 8px;
    }
    @media print { body { padding: 20px; } }
  </style>
</head>
<body>
  <div class="email-header">
    <div class="email-subject">${escapeHtml(email.subject || "(No Subject)")}</div>
    <div class="email-meta">
      <div><span class="label">From:</span> ${escapeHtml(email.sender || "Unknown")}</div>
      <div><span class="label">To:</span> ${escapeHtml(email.recipients || "Unknown")}</div>
      ${email.cc ? `<div><span class="label">CC:</span> ${escapeHtml(email.cc)}</div>` : ""}
      <div><span class="label">Date:</span> ${formatEmailDateTime(email.sent_at as string)}</div>
    </div>
  </div>

  <div class="email-body ${!isHtmlBody ? "email-body-text" : ""}">
    ${isHtmlBody ? bodyContent : escapeHtml(bodyContent)}
  </div>

  ${
    email.has_attachments || attachments.length > 0
      ? `
  <div class="attachments">
    <h4>Attachments (${attachments.length || email.attachment_count || 0})</h4>
    ${
      attachments.length > 0
        ? `<ul>${attachments.map(att => `<li>${escapeHtml(att.filename)}<span class="file-size">${formatFileSize(att.file_size_bytes)}</span></li>`).join("")}</ul>
    <div class="note">Files available in the /attachments folder</div>`
        : `<div class="note">Attachments are available in the /attachments folder</div>`
    }
  </div>
  `
      : ""
  }
</body>
</html>
    `;
}
