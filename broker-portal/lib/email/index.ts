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
export { buildDownloadInviteEmail } from './templates/download-invite';
export { buildInternalInviteEmail } from './templates/internal-invite';
export { buildTicketConfirmationEmail } from './templates/ticket-confirmation';
export { buildTicketReplyNotification } from './templates/ticket-reply-notification';
export { buildTicketAssignmentNotification } from './templates/ticket-assignment-notification';
export { buildTicketResolvedEmail } from './templates/ticket-resolved';
export { buildSeatLimitReachedEmail } from './templates/seat-limit-reached';
export { buildAccountSuspendedEmail } from './templates/account-suspended';
export { buildAccountManagerAlertEmail } from './templates/account-manager-alert';

// Types
export type {
  EmailType,
  SendEmailParams,
  SendEmailResult,
  EmailContent,
  InviteEmailParams,
  DownloadInviteEmailParams,
  InternalInviteEmailParams,
  ReceiptEmailParams,
  TicketConfirmationParams,
  TicketReplyNotificationParams,
  TicketAssignmentNotificationParams,
  TicketResolvedParams,
  SeatLimitReachedParams,
  AccountSuspendedParams,
  AccountManagerAlertParams,
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
import { buildDownloadInviteEmail } from './templates/download-invite';
import { buildInternalInviteEmail } from './templates/internal-invite';
import { buildTicketConfirmationEmail } from './templates/ticket-confirmation';
import { buildTicketReplyNotification } from './templates/ticket-reply-notification';
import { buildTicketAssignmentNotification } from './templates/ticket-assignment-notification';
import { buildSeatLimitReachedEmail } from './templates/seat-limit-reached';
import { buildTicketResolvedEmail } from './templates/ticket-resolved';
import { buildAccountSuspendedEmail } from './templates/account-suspended';
import { buildAccountManagerAlertEmail } from './templates/account-manager-alert';
import type {
  InviteEmailParams,
  DownloadInviteEmailParams,
  InternalInviteEmailParams,
  ReceiptEmailParams,
  TicketConfirmationParams,
  TicketReplyNotificationParams,
  TicketAssignmentNotificationParams,
  TicketResolvedParams,
  SeatLimitReachedParams,
  AccountSuspendedParams,
  AccountManagerAlertParams,
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
 * Send a branded download-invite email to an individual (no-org) invitee
 * (BACKLOG-1914).
 *
 * Composes the download-invite template ("Get Keepr" CTA → canonical download
 * page) and sends it via the same Graph + retry/queue path as every other
 * transactional email. Logged as an 'invite' email type.
 */
export async function sendDownloadInviteEmail(
  params: DownloadInviteEmailParams,
): Promise<SendEmailResult> {
  const { subject, html, text } = buildDownloadInviteEmail(params);
  return sendEmail({
    to: params.recipientEmail,
    subject,
    html,
    text,
    emailType: 'invite',
    logMetadata: { individual: true, download: true },
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

/**
 * Send the seat-limit email to one recipient (BACKLOG-3851 PR-2c).
 */
export async function sendSeatLimitReachedEmail(
  params: SeatLimitReachedParams,
): Promise<SendEmailResult> {
  const { subject, html, text } = buildSeatLimitReachedEmail(params);
  return sendEmail({
    to: params.recipientEmail,
    subject,
    html,
    text,
    emailType: 'other',
    logMetadata: { kind: 'seat_limit_reached', seatKind: params.kind },
  });
}

/**
 * "Account suspended" email to a brokerage's billing contact (BACKLOG-3853 PR-2).
 * Logged as email_type 'other' (the delivery log's type check allows no new value);
 * metadata.kind + outboxKey let the outbox handler see a send it already made.
 */
export async function sendAccountSuspendedEmail(
  params: AccountSuspendedParams,
): Promise<SendEmailResult> {
  const { subject, html, text } = buildAccountSuspendedEmail(params);
  return sendEmail({
    to: params.recipientEmail,
    subject,
    html,
    text,
    emailType: 'other',
    logMetadata: {
      kind: 'account_suspended',
      outboxKey: params.outboxKey,
      organizationId: params.organizationId,
      reason: params.reason,
    },
  });
}

/**
 * Billing alert to a brokerage's Keepr account manager (BACKLOG-3853 PR-2).
 */
export async function sendAccountManagerAlertEmail(
  params: AccountManagerAlertParams,
): Promise<SendEmailResult> {
  const { subject, html, text } = buildAccountManagerAlertEmail(params);
  return sendEmail({
    to: params.recipientEmail,
    subject,
    html,
    text,
    emailType: 'other',
    logMetadata: {
      kind: 'brokerage_account_manager_alert',
      outboxKey: params.outboxKey,
      organizationId: params.organizationId,
      reason: params.reason,
    },
  });
}
