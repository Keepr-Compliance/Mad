/**
 * Purchase-receipt dispatch from the fulfillment path (BACKLOG-2009).
 *
 * Resolves the paying customer's email (via the service-role auth admin API) and
 * sends a receipt through sendReceiptEmail — which inherits sendEmail's retry +
 * durable-queue behaviour. This is NON-BLOCKING for fulfillment: any failure is
 * logged and swallowed so a receipt problem never rolls back a paid unlock.
 *
 * Called from the Stripe webhook (payment_intent.succeeded) and the reconcile
 * cron, ONLY on a NEW fulfillment (result.unlocked && !result.alreadyFulfilled),
 * so replays/short-circuits never re-send.
 */

import * as Sentry from '@sentry/nextjs';
import type { createServiceClient } from '@/lib/supabase/service';
import { sendReceiptEmail } from '@/lib/email';

type ServiceClient = ReturnType<typeof createServiceClient>;

export interface ReceiptDispatchArgs {
  userId: string;
  amountCents: number;
  stripePaymentIntentId: string;
  /** Optional label; defaults to a generic unlock description in the template. */
  description?: string;
}

/**
 * Best-effort receipt send. Never throws. Returns true only when the receipt was
 * accepted (sent or queued for retry); false when it could not be dispatched
 * (e.g. the user's email could not be resolved).
 */
export async function dispatchReceiptEmail(
  service: ServiceClient,
  args: ReceiptDispatchArgs,
): Promise<boolean> {
  try {
    const { data, error } = await service.auth.admin.getUserById(args.userId);
    const email = data?.user?.email;
    if (error || !email) {
      console.error(
        `[payments/receipt] could not resolve email for user ${args.userId}:`,
        error?.message ?? 'no email on record',
      );
      Sentry.captureMessage('Receipt email skipped: no recipient email', {
        level: 'warning',
        extra: { userId: args.userId, stripePaymentIntentId: args.stripePaymentIntentId },
      });
      return false;
    }

    const result = await sendReceiptEmail({
      recipientEmail: email,
      amountCents: args.amountCents,
      description: args.description,
      paymentReference: args.stripePaymentIntentId,
    });

    // 'sent' or 'queued' both count as accepted; 'skipped'/'failed' do not.
    return result.outcome === 'sent' || result.outcome === 'queued';
  } catch (err) {
    // Never let a receipt failure break fulfillment.
    console.error('[payments/receipt] dispatch threw:', (err as Error).message);
    Sentry.captureException(err, { tags: { email_stage: 'receipt_dispatch' } });
    return false;
  }
}
