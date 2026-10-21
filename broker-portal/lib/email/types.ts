/**
 * TypeScript types for email service payloads and results.
 *
 * TASK-2197: Email Service Infrastructure
 */

// ---------------------------------------------------------------------------
// Core send types
// ---------------------------------------------------------------------------

/**
 * Email types written to email_delivery_log.email_type.
 *
 * BACKLOG-4001: the table's check constraint must allow exactly these values
 * (supabase/migrations/20261020120000_backlog_4001_email_log_type_status_checks.sql).
 * Adding a type here needs a migration; __tests__/migrations/email-log-checks-4001.test.ts
 * fails until both lists match.
 */
export const EMAIL_TYPES = [
  'invite',
  'ticket_notification',
  'ticket_confirmation',
  'ticket_reply',
  'ticket_resolved',
  'receipt',
  'other',
] as const;

/** Email type for delivery logging */
export type EmailType = (typeof EMAIL_TYPES)[number];

/**
 * Statuses written to email_delivery_log.status (send-email.ts logEmailDelivery).
 * The check constraint also allows the legacy 'attempted', which nothing writes.
 */
export const EMAIL_LOG_STATUSES = ['sent', 'failed', 'skipped', 'queued'] as const;

export type EmailLogStatus = (typeof EMAIL_LOG_STATUSES)[number];

export interface SendEmailParams {
  /** Recipient email address or array of addresses */
  to: string | string[];
  /** Email subject line */
  subject: string;
  /** HTML body content */
  html: string;
  /** Plain-text fallback body */
  text: string;
  /** Sender address (defaults to EMAIL_SENDER_ADDRESS env var) */
  from?: string;
  /** Reply-to address */
  replyTo?: string;
  /** Email type for delivery logging (defaults to 'other') */
  emailType?: EmailType;
  /** Additional metadata for delivery logging */
  logMetadata?: Record<string, unknown>;
}

export interface SendEmailResult {
  /** Whether the email was sent successfully */
  success: boolean;
  /** Error message if sending failed */
  error?: string;
  /**
   * BACKLOG-2009: delivery outcome for visibility.
   *   'sent'    — delivered (possibly after in-request retries).
   *   'queued'  — a transient failure exhausted in-request retries and the send
   *               was persisted to email_delivery_queue for the retry cron.
   *   'skipped' — email service not configured; not sent, not queued.
   *   'failed'  — permanent failure (not retryable, not queued).
   */
  outcome?: 'sent' | 'queued' | 'skipped' | 'failed';
}

// ---------------------------------------------------------------------------
// Queue types (BACKLOG-2009)
// ---------------------------------------------------------------------------

/**
 * Parameters persisted to email_delivery_queue when a transient send failure
 * exhausts in-request retries. Mirrors the resolved send payload so the drain
 * cron can re-send without re-composing.
 */
export interface EnqueueEmailParams {
  emailType: EmailType;
  recipientEmail: string;
  subject: string;
  html: string;
  text: string;
  from?: string | null;
  replyTo?: string | null;
  logMetadata?: Record<string, unknown>;
}

/** A row read from email_delivery_queue by the drain cron. */
export interface EmailQueueRow {
  id: string;
  email_type: EmailType;
  recipient_email: string;
  subject: string;
  html: string;
  body_text: string;
  from_address: string | null;
  reply_to: string | null;
  log_metadata: Record<string, unknown>;
  status: 'enqueued' | 'sent' | 'failed';
  attempts: number;
  max_attempts: number;
  next_attempt_at: string;
  last_error: string | null;
}

// ---------------------------------------------------------------------------
// Template output
// ---------------------------------------------------------------------------

export interface EmailContent {
  /** Email subject line */
  subject: string;
  /** HTML body (with inline CSS, table-based layout) */
  html: string;
  /** Plain-text fallback */
  text: string;
}

// ---------------------------------------------------------------------------
// Template params
// ---------------------------------------------------------------------------

export interface InviteEmailParams {
  /** Recipient email address */
  recipientEmail: string;
  /** Name of the organization the user is being invited to */
  organizationName: string;
  /** Name of the person sending the invite */
  inviterName: string;
  /** Role the invited user will have (e.g., "Admin", "Member") */
  role: string;
  /** Full URL for the invite acceptance link */
  inviteLink: string;
  /** Number of days until the invite expires */
  expiresInDays: number;
  /** Whether this is a resend of an existing invite (changes subject/heading) */
  isResend?: boolean;
  /** BACKLOG-3851 PR-2f: the invitation carries no license. */
  withoutLicense?: boolean;
  /** BACKLOG-4007 PR-4: the brokerage's billing-only login (Billing and Support only, no seat). */
  billingOnly?: boolean;
  /** BACKLOG-3851 PR-2f: first name typed on the invite; greets "Hi <first>,". */
  recipientFirstName?: string;
}

export interface DownloadInviteEmailParams {
  /**
   * Recipient email address. The invitee downloads Keepr and signs in with
   * THIS email — a 14-day trial is provisioned automatically on first sign-in
   * (create_trial_license), so no per-invitee token/link is needed.
   *
   * BACKLOG-1914: replaces the dead individual (no-org) invite link with a
   * branded "Get Keepr" download email. The old individual_invitations token
   * link was never resolvable on the acceptance side (0/8 organic accepts).
   */
  recipientEmail: string;
  /**
   * Canonical download / landing page URL. Defaults to
   * https://keeprcompliance.com when omitted.
   */
  downloadUrl?: string;
}

export interface ReceiptEmailParams {
  /** Recipient email address (the paying customer). */
  recipientEmail: string;
  /** Amount charged, in cents (USD). */
  amountCents: number;
  /**
   * Human label for what was purchased (e.g. "Transaction audit unlock").
   * Defaults to a generic unlock label when omitted.
   */
  description?: string;
  /** Stripe payment intent id, shown for the customer's records. */
  paymentReference: string;
  /** ISO date the charge occurred (defaults to now at build time). */
  purchasedAt?: string;
}

export interface TicketReplyNotificationParams {
  /** Email address of the customer to notify */
  recipientEmail: string;
  /** Support ticket subject line */
  ticketSubject: string;
  /** Support ticket display number (e.g., "TKT-0042") */
  ticketNumber: string;
  /** Name of the agent who replied, or "Support Team" */
  agentName: string;
  /** First 200 characters of the reply content */
  replyPreview: string;
  /** Full URL to view the ticket */
  ticketLink: string;
}

export interface InternalInviteEmailParams {
  /** Email address of the internal user being invited */
  recipientEmail: string;
  /** Display name of the role (e.g., "Support Agent") */
  roleName: string;
  /** Login URL for the admin portal */
  loginUrl: string;
}

export interface TicketConfirmationParams {
  /** Email address of the ticket requester */
  recipientEmail: string;
  /** Support ticket subject line */
  ticketSubject: string;
  /** Support ticket display number (e.g., "TKT-0042") */
  ticketNumber: string;
  /** Full URL for the requester to view their ticket */
  ticketLink: string;
}

export interface TicketAssignmentNotificationParams {
  /** Email address of the agent being assigned */
  recipientEmail: string;
  /** Support ticket subject line */
  ticketSubject: string;
  /** Support ticket display number (e.g., "TKT-0042") */
  ticketNumber: string;
  /** Name of the customer who submitted the ticket */
  customerName: string;
  /** Ticket priority level */
  priority: string;
  /** Full URL to the ticket in the admin portal */
  ticketLink: string;
}

export interface TicketResolvedParams {
  /** Email address of the ticket requester */
  recipientEmail: string;
  /** Support ticket subject line */
  ticketSubject: string;
  /** Support ticket display number (e.g., "TKT-0042") */
  ticketNumber: string;
  /** Resolution summary or latest internal note */
  resolutionSummary?: string;
  /** Full URL for the requester to view/reopen their ticket */
  ticketLink: string;
  /** The new status: 'resolved' or 'closed' */
  newStatus: 'resolved' | 'closed';
}

// ---------------------------------------------------------------------------
// Seat-limit email (BACKLOG-3851 PR-2c)
// ---------------------------------------------------------------------------

export interface SeatLimitReachedParams {
  /** Recipient (an IT admin, admin or broker of the brokerage) */
  recipientEmail: string;
  /** Name or email of the person who was not added / re-activated */
  personLabel: string;
  brokerageName: string;
  /** Seats in use */
  used: number;
  /** The brokerage's seat count; null when unknown */
  maxSeats: number | null;
  kind: 'add' | 'reactivate';
}

// ---------------------------------------------------------------------------
// Brokerage billing emails (BACKLOG-3853 PR-2)
// ---------------------------------------------------------------------------

export interface AccountSuspendedParams {
  /** The brokerage's billing contact */
  recipientEmail: string;
  brokerageName: string;
  /** Why the account manager suspended the account */
  reason: 'non_payment' | 'other';
  /**
   * BACKLOG-3853 PR-2B: how a non-payment suspension is paid. Ignored for 'other'
   * (no button: paying does not lift an Other suspension, founder 1e164f56 Q1).
   */
  payment: AccountSuspendedPayment;
  /** Kept in the delivery log so a second run can see this email was sent */
  outboxKey: string;
  organizationId: string;
}

/**
 * - invoice: the "Pay overdue invoice" button opens `url` (Stripe's hosted invoice
 *   page of the oldest overdue invoice); `overdueCount` open invoices are past due.
 * - stripe_email: the invoice lookup could not be made (last try, or the Stripe
 *   customer is gone); no button, pay from Stripe's invoice email.
 * - none: no open invoice / no Stripe customer on record; contact the account manager.
 */
export type AccountSuspendedPayment =
  | { kind: 'invoice'; url: string; overdueCount: number }
  | { kind: 'stripe_email' }
  | { kind: 'none' };

export type AccountManagerAlertReason =
  | 'overdue'
  | 'payment_failed'
  | 'refund'
  | 'dispute'
  // BACKLOG-4007 PR-3: onboarding (billing setup) alerts.
  | 'setup_not_completed'
  | 'setup_no_recipient'
  | 'price_question'
  // BACKLOG-4007 People v2: the billing contact was deprovisioned and the brokerage has no active admin.
  | 'billing_contact_removed'
  // BACKLOG-4019: auto-renew turned off by the brokerage; the subscription ended while not canceling.
  | 'auto_renew_off'
  | 'subscription_ended_unexpectedly';

export interface AccountManagerAlertParams {
  /** The account manager's sign-in email */
  recipientEmail: string;
  brokerageName: string;
  reason: AccountManagerAlertReason;
  /** Stripe object the alert is about (an invoice, charge or dispute id) */
  stripeObjectId: string | null;
  /** BACKLOG-4007 PR-3: one extra line (e.g. who asked a price question). */
  detail?: string | null;
  outboxKey: string;
  organizationId: string;
}

/** BACKLOG-4007 PR-3: "finish your setup" reminder (outbox kind notify_setup_reminder). */
/** BACKLOG-4007 People v2: "You are now the billing contact" (founder R9 refinement). */
export interface BillingContactReassignedParams {
  recipientEmail: string;
  brokerageName: string;
  /** Org Settings, where People lives. */
  url: string;
  outboxKey: string;
  organizationId: string;
}

export interface SetupReminderParams {
  recipientEmail: string;
  brokerageName: string;
  /** finish = has an account (opens the setup guide); accept = invitation not accepted yet. */
  variant: 'finish' | 'accept';
  url: string;
  outboxKey: string;
  organizationId: string;
  day: number;
}

/** BACKLOG-4027: the identity provider tried to demote or deactivate the brokerage's last active admin. */
export interface LastAdminKeptParams {
  /** Recipient: Keepr support, or the brokerage's IT contact */
  recipientEmail: string;
  /** Name or email of the admin who was kept */
  personLabel: string;
  brokerageName: string;
  kind: 'deactivate' | 'demote';
  source: 'scim' | 'directory_sync';
}
