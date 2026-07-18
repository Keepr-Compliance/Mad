/**
 * Durable retry queue for transactional email (BACKLOG-2009).
 *
 * `enqueueEmail` persists a send that exhausted in-request retries on a transient
 * failure. `drainEmailQueue` is the worker (driven by /api/cron/email-retry) that
 * picks up due rows, re-sends via Graph, applies exponential backoff per attempt,
 * and dead-letters at max_attempts.
 *
 * All access is under the service-role key (email_delivery_queue RLS = service_role
 * only for writes). Neither function throws to its caller — a queue failure must
 * never break the request that triggered the original send.
 */

import * as Sentry from '@sentry/nextjs';
import { createServiceClient } from '@/lib/supabase/service';
import { sendViaGraph, EmailNotConfiguredError } from './send-email';
import { backoffDelayMs, isTransientError } from './retry';
import type { EnqueueEmailParams, EmailQueueRow } from './types';

const DRAIN_BATCH_LIMIT = 50;

/**
 * Persist a failed transient send to email_delivery_queue.
 *
 * @returns true if the row was enqueued, false if the insert failed (caller then
 *          records the send as a hard failure instead of 'queued').
 */
export async function enqueueEmail(params: EnqueueEmailParams): Promise<boolean> {
  try {
    const supabase = createServiceClient();
    const { error } = await supabase.from('email_delivery_queue').insert({
      email_type: params.emailType,
      recipient_email: params.recipientEmail,
      subject: params.subject,
      html: params.html,
      body_text: params.text,
      from_address: params.from ?? null,
      reply_to: params.replyTo ?? null,
      log_metadata: params.logMetadata ?? {},
      status: 'enqueued',
      attempts: 0,
      // first retry after ~1 min (backoffDelayMs(0) with base 60s below in drain).
      next_attempt_at: new Date(Date.now() + 60_000).toISOString(),
    });
    if (error) {
      console.error('[Email] Failed to enqueue email for retry:', error.message);
      Sentry.captureMessage('Failed to enqueue email for retry', {
        level: 'error',
        extra: { emailType: params.emailType, error: error.message },
      });
      return false;
    }
    return true;
  } catch (err) {
    console.error('[Email] enqueueEmail threw:', (err as Error).message);
    Sentry.captureException(err, { tags: { email_stage: 'enqueue' } });
    return false;
  }
}

export interface DrainResult {
  scanned: number;
  sent: number;
  retryScheduled: number;
  deadLettered: number;
}

/**
 * Drain due rows from email_delivery_queue. For each row:
 *   - re-send via Graph.
 *   - success        -> status 'sent'.
 *   - transient fail  -> bump attempts; if attempts >= max_attempts dead-letter
 *                        (status 'failed'), else reschedule next_attempt_at with
 *                        exponential backoff (base 60s).
 *   - permanent fail / not-configured -> dead-letter immediately (a retry cannot help).
 *
 * Never throws — surfaces a summary the cron route returns as JSON.
 */
export async function drainEmailQueue(now: Date = new Date()): Promise<DrainResult> {
  const supabase = createServiceClient();
  const result: DrainResult = { scanned: 0, sent: 0, retryScheduled: 0, deadLettered: 0 };

  const { data: rows, error } = await supabase
    .from('email_delivery_queue')
    .select(
      'id, email_type, recipient_email, subject, html, body_text, from_address, reply_to, log_metadata, status, attempts, max_attempts, next_attempt_at, last_error',
    )
    .eq('status', 'enqueued')
    .lte('next_attempt_at', now.toISOString())
    .order('next_attempt_at', { ascending: true })
    .limit(DRAIN_BATCH_LIMIT);

  if (error) {
    console.error('[cron/email-retry] queue query failed:', error.message);
    Sentry.captureMessage('email-retry drain query failed', {
      level: 'error',
      extra: { error: error.message },
    });
    return result;
  }

  for (const row of (rows ?? []) as EmailQueueRow[]) {
    result.scanned++;
    try {
      await sendViaGraph({
        to: row.recipient_email,
        subject: row.subject,
        html: row.html,
        text: row.body_text,
        from: row.from_address ?? undefined,
        replyTo: row.reply_to ?? undefined,
        emailType: row.email_type,
        logMetadata: row.log_metadata,
      });

      await supabase
        .from('email_delivery_queue')
        .update({ status: 'sent', updated_at: new Date().toISOString() })
        .eq('id', row.id);
      result.sent++;
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown email error';
      const permanent = err instanceof EmailNotConfiguredError || !isTransientError(err);
      const nextAttempts = row.attempts + 1;

      if (permanent || nextAttempts >= row.max_attempts) {
        await supabase
          .from('email_delivery_queue')
          .update({
            status: 'failed',
            attempts: nextAttempts,
            last_error: message,
            updated_at: new Date().toISOString(),
          })
          .eq('id', row.id);
        result.deadLettered++;
        Sentry.captureMessage('Transactional email dead-lettered after retries', {
          level: 'error',
          extra: {
            emailType: row.email_type,
            recipient: row.recipient_email,
            attempts: nextAttempts,
            permanent,
            error: message,
          },
        });
      } else {
        // Exponential backoff: base 60s -> 60s, 120s, 240s ...
        const delay = backoffDelayMs(nextAttempts - 1, { baseMs: 60_000 });
        await supabase
          .from('email_delivery_queue')
          .update({
            attempts: nextAttempts,
            last_error: message,
            next_attempt_at: new Date(now.getTime() + delay).toISOString(),
            updated_at: new Date().toISOString(),
          })
          .eq('id', row.id);
        result.retryScheduled++;
      }
    }
  }

  return result;
}
