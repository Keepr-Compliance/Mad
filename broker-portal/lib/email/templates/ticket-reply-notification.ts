/**
 * Ticket reply notification email template.
 *
 * Sent to the customer when a support agent replies to their ticket.
 * Includes ticket subject, number, agent name, the full reply, and CTA link.
 *
 * TASK-2197: Email Service Infrastructure
 * BACKLOG-3702: full reply (no truncation), line breaks kept, and a notice that
 * replies to the email itself are not read.
 */

import { baseLayout } from './base-layout';
import type { EmailContent, TicketReplyNotificationParams } from '../types';

/** Shown next to the "View Full Conversation" button (BACKLOG-3702). */
export const NO_REPLY_NOTICE =
  "Replies to this email aren't read. To respond, click View Full Conversation.";

/**
 * Build the ticket reply notification email (subject, HTML, plain text).
 *
 * Pure function -- no side effects, no async.
 */
export function buildTicketReplyNotification(
  params: TicketReplyNotificationParams,
): EmailContent {
  const {
    ticketSubject,
    ticketNumber,
    agentName,
    replyPreview,
    ticketLink,
  } = params;

  const subject = `Re: [${ticketNumber}] ${ticketSubject}`;

  // The whole reply. `replyPreview` keeps its historical name (API contract).
  const replyText = replyPreview.replace(/\r\n?/g, '\n');
  // Escape FIRST, then turn newlines into <br> so user-typed markup stays inert.
  const replyHtml = escapeHtml(replyText).replace(/\n/g, '<br>');

  const html = baseLayout({
    preheader: `${agentName} replied to your support request`,
    body: `
      <h1 style="margin:0 0 8px 0; font-size:20px; font-weight:700; color:#111827; line-height:1.3;">
        New Reply on Your Support Ticket
      </h1>
      <p style="margin:0 0 24px 0; font-size:14px; color:#6b7280; line-height:1.5;">
        ${escapeHtml(ticketNumber)} &mdash; ${escapeHtml(ticketSubject)}
      </p>
      <table width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 24px 0;">
        <tr>
          <td style="padding:16px; background-color:#f9fafb; border-left:4px solid #4f46e5; border-radius:0 4px 4px 0;">
            <p style="margin:0 0 8px 0; font-size:13px; font-weight:600; color:#4f46e5;">
              ${escapeHtml(agentName)}
            </p>
            <p style="margin:0; font-size:14px; color:#374151; line-height:1.6;">
              ${replyHtml}
            </p>
          </td>
        </tr>
      </table>
      <table cellpadding="0" cellspacing="0" border="0" style="margin:0 0 16px 0;">
        <tr>
          <td align="center" style="border-radius:6px; background-color:#4f46e5;">
            <a href="${escapeAttr(ticketLink)}"
               target="_blank"
               style="display:inline-block; padding:12px 28px; font-size:14px; font-weight:600; color:#ffffff; text-decoration:none; border-radius:6px; background-color:#4f46e5;">
              View Full Conversation
            </a>
          </td>
        </tr>
      </table>
      <p style="margin:0 0 16px 0; font-size:13px; color:#6b7280; line-height:1.5;">
        ${NO_REPLY_NOTICE}
      </p>
      <p style="margin:0; font-size:13px; color:#9ca3af; line-height:1.5;">
        You are receiving this because you submitted a support request.
      </p>
    `,
  });

  const text = [
    `New reply on your support ticket: [${ticketNumber}] ${ticketSubject}`,
    '',
    `${agentName} wrote:`,
    replyText,
    '',
    `View the full conversation: ${ticketLink}`,
    NO_REPLY_NOTICE,
    '',
    'You are receiving this because you submitted a support request.',
  ].join('\n');

  return { subject, html, text };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function escapeAttr(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
