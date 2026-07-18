/**
 * Generic email send function using Microsoft Graph API.
 *
 * Uses POST /users/{senderAddress}/sendMail to send emails via the
 * organisation's M365 mailbox. Never throws -- always returns a
 * structured result object.
 *
 * TASK-2197: Email Service Infrastructure
 * BACKLOG-1567: Email Delivery Observability (logging + Sentry)
 * BACKLOG-2009: Retry w/ backoff + durable queue on transient failure.
 */

import * as Sentry from '@sentry/nextjs';
import { getGraphClient } from './graph-client';
import { createServiceClient } from '@/lib/supabase/service';
import type { SendEmailParams, SendEmailResult, EmailType } from './types';
import { IN_REQUEST_BACKOFF_MS, isTransientError, sleep } from './retry';
import { enqueueEmail } from './queue';

// ---------------------------------------------------------------------------
// Delivery logging (fire-and-forget)
// ---------------------------------------------------------------------------

/**
 * Log an email delivery attempt to the email_delivery_log table.
 * Uses the service role client to bypass RLS.
 * Never throws -- failures are logged to console + Sentry.
 */
async function logEmailDelivery(opts: {
  emailType: EmailType;
  recipientEmail: string;
  status: 'sent' | 'failed' | 'skipped' | 'queued';
  errorMessage?: string | null;
  metadata?: Record<string, unknown>;
}): Promise<void> {
  try {
    const supabase = createServiceClient();
    await supabase.from('email_delivery_log').insert({
      email_type: opts.emailType,
      recipient_email: opts.recipientEmail,
      status: opts.status,
      error_message: opts.errorMessage || null,
      metadata: opts.metadata || {},
    });
  } catch (logError) {
    console.error('[Email] Failed to log email delivery:', logError);
    // Never block email delivery due to logging failure
  }
}

// ---------------------------------------------------------------------------
// Low-level Graph send (THROWS on Graph error so callers can classify)
// ---------------------------------------------------------------------------

/** Raised when the email service is not configured (missing creds / sender). */
export class EmailNotConfiguredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EmailNotConfiguredError';
  }
}

/**
 * Send a single message via Microsoft Graph. Throws:
 *   - EmailNotConfiguredError when creds / sender address are missing.
 *   - the raw Graph/network error otherwise (preserving statusCode for
 *     transient/permanent classification).
 *
 * Exposed for the retry cron, which drives its own retry/backoff loop.
 */
export async function sendViaGraph(params: SendEmailParams): Promise<void> {
  const client = getGraphClient();
  if (!client) {
    throw new EmailNotConfiguredError(
      'Email service not configured (missing Azure credentials)',
    );
  }

  const senderAddress = params.from || process.env.EMAIL_SENDER_ADDRESS;
  if (!senderAddress) {
    throw new EmailNotConfiguredError(
      'Email service not configured (missing EMAIL_SENDER_ADDRESS)',
    );
  }

  const toRecipients = (
    Array.isArray(params.to) ? params.to : [params.to]
  ).map((address) => ({
    emailAddress: { address },
  }));

  const message: Record<string, unknown> = {
    subject: params.subject,
    body: {
      contentType: 'HTML',
      content: params.html,
    },
    toRecipients,
    internetMessageHeaders: [
      {
        name: 'X-List-Unsubscribe',
        value: '<mailto:unsubscribe@keeprcompliance.com>',
      },
    ],
  };

  if (params.replyTo) {
    message.replyTo = [{ emailAddress: { address: params.replyTo } }];
  }

  await client.api(`/users/${senderAddress}/sendMail`).post({ message });
}

// ---------------------------------------------------------------------------
// Core send function (in-request retry + enqueue-on-transient-failure)
// ---------------------------------------------------------------------------

/**
 * Send an email via Microsoft Graph API.
 *
 * @returns A result object indicating success or failure. Never throws.
 *
 * Behaviour (BACKLOG-2009):
 *   1. Retries in-request up to IN_REQUEST_BACKOFF_MS.length + 1 attempts on a
 *      TRANSIENT failure (429/5xx/network), with a small exponential backoff.
 *   2. If a transient failure still remains, the send is persisted to
 *      email_delivery_queue (result.outcome === 'queued') for the retry cron.
 *   3. PERMANENT failures (4xx auth/validation) are logged 'failed' and NOT
 *      queued. Missing config is logged 'skipped'.
 *
 * On success Graph returns 202 Accepted with no body, so `messageId` is N/A.
 */
export async function sendEmail(params: SendEmailParams): Promise<SendEmailResult> {
  const emailType: EmailType = params.emailType || 'other';
  const recipientEmail = Array.isArray(params.to) ? params.to[0] : params.to;
  const logMeta = {
    subject: params.subject,
    ...(params.logMetadata || {}),
  };

  // Sentry breadcrumb for every attempt
  Sentry.addBreadcrumb({
    category: 'email',
    message: `Sending ${emailType} email to ${recipientEmail}`,
    level: 'info',
    data: { emailType, subject: params.subject },
  });

  const maxAttempts = IN_REQUEST_BACKOFF_MS.length + 1;
  let lastError: unknown;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      await sendViaGraph(params);

      await logEmailDelivery({
        emailType,
        recipientEmail,
        status: 'sent',
        metadata: attempt > 0 ? { ...logMeta, retriedInRequest: attempt } : logMeta,
      });

      return { success: true, outcome: 'sent' };
    } catch (err: unknown) {
      lastError = err;

      // Missing config -> not sent, not retried, not queued.
      if (err instanceof EmailNotConfiguredError) {
        await logEmailDelivery({
          emailType,
          recipientEmail,
          status: 'skipped',
          errorMessage: err.message,
          metadata: logMeta,
        });
        return { success: false, error: err.message, outcome: 'skipped' };
      }

      // Permanent (4xx auth/validation) -> stop, do not retry / queue.
      if (!isTransientError(err)) break;

      // Transient -> back off and retry in-request, unless this was the last try.
      if (attempt < maxAttempts - 1) {
        await sleep(IN_REQUEST_BACKOFF_MS[attempt]);
      }
    }
  }

  // Reached here => failure. Resolve the message + transient-ness.
  const errorMessage =
    lastError instanceof Error ? lastError.message : 'Unknown email error';
  console.error('[Email] Graph API error sending email:', errorMessage);

  Sentry.captureException(lastError, {
    tags: { email_type: emailType },
    extra: { recipientEmail, subject: params.subject },
  });

  // Transient failure that survived in-request retries -> enqueue for the cron.
  if (isTransientError(lastError)) {
    const enqueued = await enqueueEmail({
      emailType,
      recipientEmail,
      subject: params.subject,
      html: params.html,
      text: params.text,
      from: params.from ?? null,
      replyTo: params.replyTo ?? null,
      logMetadata: logMeta,
    });

    if (enqueued) {
      await logEmailDelivery({
        emailType,
        recipientEmail,
        status: 'queued',
        errorMessage,
        metadata: logMeta,
      });
      return { success: false, error: errorMessage, outcome: 'queued' };
    }
    // enqueue itself failed -> fall through and record as failed.
  }

  await logEmailDelivery({
    emailType,
    recipientEmail,
    status: 'failed',
    errorMessage,
    metadata: logMeta,
  });

  return { success: false, error: errorMessage, outcome: 'failed' };
}
