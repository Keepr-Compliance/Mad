/**
 * Purchase-receipt dispatch from the fulfillment path (BACKLOG-2009).
 *
 * Resolves the recipient and sends a receipt through sendReceiptEmail — which inherits sendEmail's retry +
 * durable-queue behaviour. This is NON-BLOCKING for fulfillment: any failure is
 * logged and swallowed so a receipt problem never rolls back a paid unlock.
 *
 * Called from the Stripe webhook (payment_intent.succeeded) and the reconcile
 * cron, ONLY on a NEW fulfillment (result.unlocked && !result.alreadyFulfilled),
 * so replays/short-circuits never re-send.
 *
 * BACKLOG-3848 (founder Q2): the receipt goes to the billing contact — the
 * Stripe Customer's email in this mode — else the sign-in email. The address
 * comes from billingContactEmail(), the same function the Billing page's
 * "Receipts sent to" label reads.
 */

import * as Sentry from '@sentry/nextjs';
import type Stripe from 'stripe';
import type { createServiceClient } from '@/lib/supabase/service';
import { sendReceiptEmail } from '@/lib/email';
import { billingContactEmail } from '@/lib/billing/contact';

type ServiceClient = ReturnType<typeof createServiceClient>;

export interface ReceiptDispatchArgs {
  userId: string;
  amountCents: number;
  stripePaymentIntentId: string;
  /** Optional label; defaults to a generic unlock description in the template. */
  description?: string;
  /** BACKLOG-3848: the paying Stripe customer; its email is the billing contact. */
  stripe?: Stripe;
  customerId?: string | null;
}

/** The paying customer, or null (none given, or the read failed: the sign-in email is used). */
async function payingCustomer(args: ReceiptDispatchArgs): Promise<Stripe.Customer | Stripe.DeletedCustomer | null> {
  if (!args.stripe || !args.customerId) return null;
  try {
    return await args.stripe.customers.retrieve(args.customerId);
  } catch (err) {
    console.error('[payments/receipt] customer read failed; using the sign-in email:', (err as Error).message);
    return null;
  }
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
    const customer = await payingCustomer(args);
    let signIn: string | null = null;
    let error: { message: string } | null = null;
    if (!billingContactEmail(customer, null)) {
      const res = await service.auth.admin.getUserById(args.userId);
      signIn = res.data?.user?.email ?? null;
      error = res.error;
    }
    const email = billingContactEmail(customer, signIn);
    if (!email) {
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
