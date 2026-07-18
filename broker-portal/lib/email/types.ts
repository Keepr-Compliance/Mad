/**
 * TypeScript types for email service payloads and results.
 *
 * TASK-2197: Email Service Infrastructure
 */

// ---------------------------------------------------------------------------
// Core send types
// ---------------------------------------------------------------------------

/** Email type for delivery logging */
export type EmailType = 'invite' | 'ticket_notification' | 'ticket_confirmation' | 'ticket_reply' | 'ticket_resolved' | 'receipt' | 'other';

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
