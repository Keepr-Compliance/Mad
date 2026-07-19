/**
 * Email service module for the broker portal.
 *
 * Wraps Microsoft Graph API (client credentials flow) to send
 * transactional emails. Provides typed send functions and branded
 * HTML email templates.
 *
 * Usage:
 *   import { sendInviteEmail } from '@/lib/email';
 *   const result = await sendInviteEmail({ ... });
 *   if (!result.success) console.error(result.error);
 *
 * TASK-2197: Email Service Infrastructure
 */

// Core send function
export { sendEmail } from './send-email';

// Template builders
export { buildReceiptEmail } from './templates/receipt';
export { buildInviteEmail } from './templates/invite';
export { buildInternalInviteEmail } from './templates/internal-invite';
export { buildTicketConfirmationEmail } from './templates/ticket-confirmation';
export { buildTicketReplyNotification } from './templates/ticket-reply-notification';
export { buildTicketAssignmentNotification } from './templates/ticket-assignment-notification';
export { buildTicketResolvedEmail } from './templates/ticket-resolved';

// Types
export type {
  EmailType,
  SendEmailParams,
  SendEmailResult,
  EmailContent,
  InviteEmailParams,
  InternalInviteEmailParams,
  ReceiptEmailParams,
  TicketConfirmationParams,
  TicketReplyNotificationParams,
  TicketAssignmentNotificationParams,
  TicketResolvedParams,
} from './types';

// Queue (BACKLOG-2009)
export { enqueueEmail, drainEmailQueue } from './queue';
export type { DrainResult } from './queue';

// ---------------------------------------------------------------------------
// Convenience wrappers that compose template + send
// ---------------------------------------------------------------------------

import { sendEmail } from './send-email';
import { buildReceiptEmail } from './templates/receipt';
import { buildInviteEmail } from './templates/invite';
import { buildInternalInviteEmail } from './templates/internal-invite';
import { buildTicketConfirmationEmail } from './templates/ticket-confirmation';
import { buildTicketReplyNotification } from './templates/ticket-reply-notification';
import { buildTicketAssignmentNotification } from './templates/ticket-assignment-notification';
import { buildTicketResolvedEmail } from './templates/ticket-resolved';
import type {
  InviteEmailParams,
  InternalInviteEmailParams,
  ReceiptEmailParams,
  TicketConfirmationParams,
  TicketReplyNotificationParams,
  TicketAssignmentNotificationParams,
  TicketResolvedParams,
  SendEmailResult,
} from './types';

/**
 * Send an invite email to a new user.
 *
 * Composes the invite template and sends it via Graph API.
 */
export async function sendInviteEmail(
  params: InviteEmailParams,
): Promise<SendEmailResult> {
  const { subject, html, text } = buildInviteEmail(params);
  return sendEmail({
    to: params.recipientEmail,
    subject,
    html,
    text,
    emailType: 'invite',
    logMetadata: { organizationName: params.organizationName },
  });
}

/**
 * Send a purchase receipt email to the paying customer (BACKLOG-2009).
 *
 * Composes the receipt template and sends it via Graph API. Inherits the
 * retry/queue behaviour of sendEmail (a transient failure is retried in-request
 * and then enqueued for the /api/cron/email-retry drainer).
 */
export async function sendReceiptEmail(
  params: ReceiptEmailParams,
): Promise<SendEmailResult> {
  const { subject, html, text } = buildReceiptEmail(params);
  return sendEmail({
    to: params.recipientEmail,
    subject,
    html,
    text,
    emailType: 'receipt',
    logMetadata: {
      amountCents: params.amountCents,
      paymentReference: params.paymentReference,
    },
  });
}

/**
 * Send an internal user invite email (admin portal users).
 */
export async function sendInternalInviteEmail(
  params: InternalInviteEmailParams,
): Promise<SendEmailResult> {
  const { subject, html, text } = buildInternalInviteEmail(params);
  return sendEmail({
    to: params.recipientEmail,
    subject,
    html,
    text,
    emailType: 'invite',
    logMetadata: { roleName: params.roleName, internal: true },
  });
}

/**
 * Send a ticket confirmation email to the requester.
 */
export async function sendTicketConfirmationEmail(
  params: TicketConfirmationParams,
): Promise<SendEmailResult> {
  const { subject, html, text } = buildTicketConfirmationEmail(params);
  return sendEmail({
    to: params.recipientEmail,
    subject,
    html,
    text,
    emailType: 'ticket_confirmation',
    logMetadata: { ticketNumber: params.ticketNumber },
  });
}

/**
 * Send a ticket reply notification to the customer.
 *
 * Composes the reply notification template and sends it via Graph API.
 */
export async function sendTicketReplyNotification(
  params: TicketReplyNotificationParams,
): Promise<SendEmailResult> {
  const { subject, html, text } = buildTicketReplyNotification(params);
  return sendEmail({
    to: params.recipientEmail,
    subject,
    html,
    text,
    emailType: 'ticket_reply',
    logMetadata: { ticketNumber: params.ticketNumber },
  });
}

/**
 * Send a ticket assignment notification to an agent.
 *
 * Composes the assignment notification template and sends it via Graph API.
 */
export async function sendTicketAssignmentNotification(
  params: TicketAssignmentNotificationParams,
): Promise<SendEmailResult> {
  const { subject, html, text } = buildTicketAssignmentNotification(params);
  return sendEmail({
    to: params.recipientEmail,
    subject,
    html,
    text,
    emailType: 'ticket_notification',
    logMetadata: { ticketNumber: params.ticketNumber },
  });
}

/**
 * Send a ticket resolved/closed notification to the requester.
 *
 * Composes the resolved notification template and sends it via Graph API.
 */
export async function sendTicketResolvedEmail(
  params: TicketResolvedParams,
): Promise<SendEmailResult> {
  const { subject, html, text } = buildTicketResolvedEmail(params);
  return sendEmail({
    to: params.recipientEmail,
    subject,
    html,
    text,
    emailType: 'ticket_resolved',
    logMetadata: { ticketNumber: params.ticketNumber, newStatus: params.newStatus },
  });
}
