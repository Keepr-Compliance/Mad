/**
 * Summary Report HTML Generation
 * Pure utility function for generating the transaction summary HTML.
 * Extracted from folderExportService.ts for maintainability.
 */

import type { Communication } from "../../types/models";
import type { TransactionWithDetails } from "../transactionService/types";
import type { TransactionContactResult } from "../db/transactionContactDbService";
import { isEmailMessage, isTextMessage } from "../../utils/channelHelpers";
import { escapeHtml, formatDate } from "../../utils/exportUtils";
import { countTextThreads, generateTextIndex, getMessageTypeCounts } from "./textExportHelpers";
import { groupEmailsForIndex, type EmailIndexThread } from "./emailIndexHelpers";
import { extractParticipantHandles } from "../contactResolutionService";
import { getContactNamesByHandles } from "../../utils/exportUtils";

/**
 * Generate HTML for summary report.
 *
 * BACKLOG-2161: `emailExportMode` controls how the Email Threads Index is
 * rendered so it honors the app's Email Mode toggle:
 *   - "thread" (default): one index row per conversation THREAD; the header
 *     count equals the app's on-screen "N conversations".
 *   - "individual": one index row per email (legacy behavior, unchanged).
 */
export function generateSummaryHTML(
  transaction: TransactionWithDetails,
  communications: Communication[],
  phoneNameMap?: Record<string, string>,
  emailExportMode: "thread" | "individual" = "thread"
): string {
  const emails = communications.filter((c) => isEmailMessage(c));
  const texts = communications.filter((c) => isTextMessage(c));

  // Calculate message type breakdown (TASK-1802)
  const messageTypeCounts = getMessageTypeCounts(texts);

  // Sort emails for the individual-mode list (oldest first).
  const sortedEmails = [...emails].sort((a, b) => {
    const dateA = new Date(a.sent_at as string).getTime();
    const dateB = new Date(b.sent_at as string).getTime();
    return dateA - dateB;
  });

  // BACKLOG-2161: In Thread View, group emails into conversation threads using
  // the SAME key the app uses on-screen, so the index count matches "N
  // conversations". Rendered as one row per thread; individual mode is unchanged.
  const emailIndexThreads = groupEmailsForIndex(emails);
  const emailIndexHtml =
    emailExportMode === "individual"
      ? renderIndividualEmailIndex(sortedEmails)
      : renderThreadEmailIndex(emailIndexThreads);
  const emailIndexCount =
    emailExportMode === "individual" ? emails.length : emailIndexThreads.length;

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
    .header h1 { font-size: 28px; color: #1a202c; margin-bottom: 8px; }
    .header .subtitle { font-size: 14px; color: #718096; }
    .property-info {
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      color: white;
      padding: 24px;
      border-radius: 8px;
      margin-bottom: 30px;
    }
    .property-info h2 { font-size: 20px; margin-bottom: 12px; }
    .property-info .address { font-size: 16px; opacity: 0.95; }
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
    .detail-card .value { font-size: 18px; color: #1a202c; font-weight: 600; }
    .section { margin-bottom: 30px; }
    .section h3 {
      font-size: 18px;
      color: #2d3748;
      margin-bottom: 16px;
      padding-bottom: 8px;
      border-bottom: 2px solid #e2e8f0;
    }
    .email-list { margin-top: 16px; }
    .email-item {
      padding: 12px;
      border-bottom: 1px solid #e2e8f0;
      font-size: 13px;
    }
    .email-item:last-child { border-bottom: none; }
    .email-item .header-row {
      display: flex;
      justify-content: space-between;
      align-items: flex-start;
    }
    .email-item .index { color: #718096; width: 40px; }
    .email-item .subject { flex: 1; font-weight: 500; color: #2d3748; }
    .email-item .date { color: #718096; width: 120px; text-align: right; }
    .email-item .from { color: #4a5568; font-size: 12px; margin-top: 4px; margin-left: 40px; }
    .text-item {
      padding: 12px;
      border-bottom: 1px solid #e2e8f0;
      font-size: 13px;
    }
    .text-item:last-child { border-bottom: none; }
    .text-item .header-row {
      display: flex;
      justify-content: space-between;
      align-items: flex-start;
    }
    .text-item .index { color: #718096; width: 40px; }
    .text-item .contact { flex: 1; font-weight: 500; color: #2d3748; }
    .text-item .date { color: #718096; width: 120px; text-align: right; }
    .text-item .preview { color: #4a5568; font-size: 12px; margin-top: 4px; margin-left: 40px; }
    .contact-list { margin-top: 12px; }
    .contact-item {
      padding: 12px 16px;
      border: 1px solid #e2e8f0;
      border-radius: 6px;
      margin-bottom: 8px;
      background: #f7fafc;
    }
    .contact-item:last-child { margin-bottom: 0; }
    .contact-item .contact-name {
      font-size: 15px;
      font-weight: 600;
      color: #1a202c;
    }
    .contact-item .contact-role {
      font-size: 12px;
      color: #667eea;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      margin-left: 8px;
    }
    .contact-item .contact-details {
      font-size: 13px;
      color: #4a5568;
      margin-top: 4px;
    }
    .contact-item .contact-details span { margin-right: 16px; }
    .no-contacts {
      color: #a0aec0;
      font-style: italic;
      font-size: 14px;
      padding: 12px 0;
    }
    .note {
      background: #edf2f7;
      padding: 12px;
      border-radius: 6px;
      font-size: 12px;
      color: #4a5568;
      margin-top: 16px;
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
    <h1>Transaction Audit Summary</h1>
    <div class="subtitle">Audit Period: ${formatDate(transaction.started_at) || "Not set"} - ${formatDate(transaction.closed_at) || "Not set"}</div>
    <div class="subtitle">Generated on ${formatDate(new Date())}</div>
  </div>

  <div class="property-info">
    <h2>Property Information</h2>
    <div class="address">${transaction.property_address || "N/A"}</div>
  </div>

  <div class="details-grid">
    <div class="detail-card">
      <div class="label">Transaction Type</div>
      <div class="value">${transaction.transaction_type === "purchase" ? "Purchase" : transaction.transaction_type === "sale" ? "Sale" : "N/A"}</div>
    </div>
    <div class="detail-card">
      <div class="label">Closing Date</div>
      <div class="value">${formatDate(transaction.closed_at)}</div>
    </div>
    <div class="detail-card">
      <div class="label">Total Emails</div>
      <div class="value">${emails.length}</div>
    </div>
    <div class="detail-card">
      <div class="label">Total Text Messages</div>
      <div class="value">${texts.length}</div>
    </div>
  </div>

  ${generateContactsSection(transaction.contact_assignments)}

  ${(messageTypeCounts.voiceMessages > 0 || messageTypeCounts.locationMessages > 0 || messageTypeCounts.attachmentOnlyMessages > 0) ? `
  <div class="section">
    <h3>Message Type Breakdown</h3>
    <div class="details-grid" style="grid-template-columns: repeat(4, 1fr);">
      <div class="detail-card">
        <div class="label">Text Messages</div>
        <div class="value">${messageTypeCounts.textMessages}</div>
      </div>
      <div class="detail-card">
        <div class="label">Voice Messages</div>
        <div class="value">${messageTypeCounts.voiceMessages}</div>
      </div>
      <div class="detail-card">
        <div class="label">Location Shares</div>
        <div class="value">${messageTypeCounts.locationMessages}</div>
      </div>
      <div class="detail-card">
        <div class="label">Media Only</div>
        <div class="value">${messageTypeCounts.attachmentOnlyMessages}</div>
      </div>
    </div>
  </div>
  ` : ""}

  ${emails.length > 0 ? `
  <div class="section">
    <h3>Email Threads Index (${emailIndexCount})</h3>
    <div class="email-list">
      ${emailIndexHtml}
    </div>
    <div class="note">
      Full email content is available in the /emails folder as individual PDF files.
    </div>
  </div>
  ` : ""}

  ${texts.length > 0 ? `
  <div class="section">
    <h3>Text Threads Index (${countTextThreads(texts)})</h3>
    <div class="email-list">
      ${generateTextIndex(texts, phoneNameMap, getContactNamesByHandles, extractParticipantHandles)}
    </div>
    <div class="note">
      Full text conversations are available in the /texts folder as individual PDF files.
    </div>
  </div>
  ` : ""}

  <div class="footer">
    <p>This report was automatically generated by Keepr</p>
    <p>Transaction ID: ${transaction.id}</p>
  </div>
</body>
</html>
    `;
}

/**
 * BACKLOG-2161: Render the email index as ONE row per email (Individual mode).
 * Preserves the pre-BACKLOG-2161 layout exactly. Rows are ordered oldest-first.
 */
function renderIndividualEmailIndex(sortedEmails: Communication[]): string {
  return sortedEmails
    .map((email, index) => {
      return `
        <div class="email-item">
          <div class="header-row">
            <span class="index">${String(index + 1).padStart(3, "0")}</span>
            <span class="subject">${escapeHtml(email.subject || "(No Subject)")}</span>
          </div>
          <div class="from">${escapeHtml(email.sender || "Unknown")}</div>
        </div>
      `;
    })
    .join("");
}

/**
 * BACKLOG-2161: Render the email index as ONE row per conversation THREAD
 * (Thread View mode). Threads are grouped with the same key the app uses
 * on-screen (see emailIndexHelpers.groupEmailsForIndex), so the row count
 * equals the app's "N conversations". Threads are ordered oldest-first to match
 * the combined-PDF section ordering (emailRowTargets line up 1:1 with rows).
 */
function renderThreadEmailIndex(threads: EmailIndexThread[]): string {
  return threads
    .map((thread, index) => {
      const count = thread.emails.length;
      const countLabel = count > 1 ? ` (${count} emails)` : "";
      return `
        <div class="email-item">
          <div class="header-row">
            <span class="index">${String(index + 1).padStart(3, "0")}</span>
            <span class="subject">${escapeHtml(thread.subject || "(No Subject)")}${countLabel}</span>
          </div>
          <div class="from">${escapeHtml(thread.sender || "Unknown")}</div>
        </div>
      `;
    })
    .join("");
}

/**
 * Generate the Contacts section HTML for the summary report.
 */
function generateContactsSection(contacts?: TransactionContactResult[]): string {
  if (!contacts || contacts.length === 0) {
    return `
  <div class="section">
    <h3>Contacts</h3>
    <div class="no-contacts">No contacts assigned</div>
  </div>`;
  }

  const contactItems = contacts
    .map((c) => {
      const name = escapeHtml(c.contact_name || "Unknown");
      const rawRole = c.specific_role || c.role || "";
      // Format role: "REAL_ESTATE_ATTORNEY" -> "Real Estate Attorney"
      const role = rawRole
        .split("_")
        .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
        .join(" ");
      const roleHtml = role ? `<span class="contact-role">${escapeHtml(role)}</span>` : "";

      const details: string[] = [];
      if (c.contact_email) {
        details.push(`<span>${escapeHtml(c.contact_email)}</span>`);
      }
      if (c.contact_phone) {
        details.push(`<span>${escapeHtml(c.contact_phone)}</span>`);
      }

      const detailsHtml = details.length > 0
        ? `<div class="contact-details">${details.join("")}</div>`
        : "";

      return `
      <div class="contact-item">
        <div><span class="contact-name">${name}</span>${roleHtml}</div>
        ${detailsHtml}
      </div>`;
    })
    .join("");

  return `
  <div class="section">
    <h3>Contacts (${contacts.length})</h3>
    <div class="contact-list">
      ${contactItems}
    </div>
  </div>`;
}
