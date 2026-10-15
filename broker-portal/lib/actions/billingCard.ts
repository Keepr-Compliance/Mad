'use server';

/**
 * Payment method and billing contact actions on the personal Billing page —
 * BACKLOG-3848.
 *
 * Same order as the Agent plan actions (lib/actions/agentPlan.ts), before any
 * Stripe call: blockWriteDuringImpersonation() (result checked) -> the billing
 * flag and who the caller is, recomputed on the server (agentContext) -> the
 * capability -> the mode guard. The Stripe customer is always the caller's own
 * stored row in this mode, never an id from the request.
 */

import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { blockWriteDuringImpersonation } from '@/lib/impersonation-guards';
import { getStripe } from '@/lib/stripe';
import { ensureStripeCustomer, getStripeCustomer, isModeAllowedForUser } from '@/lib/billing/customers';
import { agentContext, returnBase, BILLING_PATH, MODE_REFUSED, NOT_AVAILABLE } from '@/lib/billing/personalActionContext';
import { applyCardUpdate, CARD_UPDATE_KIND, type PayOutcome } from '@/lib/billing/cardUpdate';
import { validateContact } from '@/lib/billing/contact';

export type CardActionResult = { error: string } | { ok: true; notice?: string; link?: string };

const NO_CUSTOMER = 'A card is saved at your first purchase in the Keepr app.';
const NOT_CONFIRMED = 'We could not confirm your new card yet. Refresh the page in a minute to see it.';

/** Update card: open the Stripe-hosted page that saves a card (same tab). */
export async function startCardUpdate(): Promise<CardActionResult> {
  const blocked = await blockWriteDuringImpersonation();
  if (blocked) return { error: blocked.error };
  const ctx = await agentContext();
  if ('error' in ctx) return ctx;
  if (!ctx.caps.canUpdateCard) return { error: NOT_AVAILABLE };
  if (!(await isModeAllowedForUser(ctx.service, ctx.userId, ctx.mode))) return { error: MODE_REFUSED };
  const customer = await getStripeCustomer(ctx.service, ctx.userId, ctx.mode);
  if (!customer) return { error: NO_CUSTOMER };

  const base = await returnBase();
  const metadata = { kind: CARD_UPDATE_KIND, user_id: ctx.userId };
  const session = await getStripe().checkout.sessions.create({
    mode: 'setup',
    customer: customer.stripe_customer_id,
    currency: 'usd',
    payment_method_types: ['card'],
    metadata,
    setup_intent_data: { metadata },
    success_url: `${base}${BILLING_PATH}?card=updated&session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${base}${BILLING_PATH}?card=cancelled`,
  });
  if (!session.url) return { error: 'Something went wrong. Please try again.' };
  // Outside any try/catch: redirect() works by throwing.
  redirect(session.url);
}

function payNotice(pay: PayOutcome): Pick<Extract<CardActionResult, { ok: true }>, 'notice' | 'link'> {
  switch (pay.kind) {
    case 'paid':
      return { notice: 'Your card is updated and your payment went through. Unlimited exports come back on in a minute.' };
    case 'declined':
      return { notice: 'Your card is saved, but the payment did not go through. Try another card.' };
    case 'action_required':
      return {
        notice: 'Your card is saved. Your bank wants you to confirm the payment: open the invoice to finish.',
        link: pay.invoiceUrl ?? undefined,
      };
    case 'not_paid':
      if (pay.reason === 'unpaid') return { notice: 'Your card is saved. Please contact support to settle the unpaid bill.' };
      if (pay.reason === 'pending') return { notice: 'Your card is saved. The payment is still processing; refresh the page in a minute.' };
      return { notice: 'Your card is saved.' };
    case 'none':
      return { notice: 'Your card is updated.' };
  }
}

/** Back from the Stripe page: apply the new card now (the webhook does the same; both are safe). */
export async function confirmCardUpdate(sessionId: string): Promise<CardActionResult> {
  const blocked = await blockWriteDuringImpersonation();
  if (blocked) return { error: blocked.error };
  const ctx = await agentContext();
  if ('error' in ctx) return ctx;
  if (!ctx.caps.canUpdateCard) return { error: NOT_AVAILABLE };
  if (typeof sessionId !== 'string' || !/^cs_[A-Za-z0-9_]+$/.test(sessionId)) return { error: NOT_CONFIRMED };
  if (!(await isModeAllowedForUser(ctx.service, ctx.userId, ctx.mode))) return { error: MODE_REFUSED };

  const out = await applyCardUpdate(
    { service: ctx.service, stripe: getStripe(), mode: ctx.mode },
    sessionId,
    { callerUserId: ctx.userId, onPayError: 'report' }
  );
  revalidatePath(BILLING_PATH);
  if (out.kind === 'refused') return { error: NOT_CONFIRMED };
  return { ok: true, ...payNotice(out.pay) };
}

/** Edit the billing contact (name and the email receipts go to). */
export async function updateBillingContact(input: { name?: unknown; email?: unknown }): Promise<CardActionResult> {
  const blocked = await blockWriteDuringImpersonation();
  if (blocked) return { error: blocked.error };
  const ctx = await agentContext();
  if ('error' in ctx) return ctx;
  if (!ctx.caps.canPay) return { error: NOT_AVAILABLE };
  const clean = validateContact(input ?? {});
  if ('error' in clean) return clean;
  // Before ensureStripeCustomer: a test-key deployment must not create a customer for a real user (SR R8).
  if (!(await isModeAllowedForUser(ctx.service, ctx.userId, ctx.mode))) return { error: MODE_REFUSED };

  const stripe = getStripe();
  const customerId = await ensureStripeCustomer(ctx.service, stripe, ctx.userId, ctx.email, ctx.mode);
  await stripe.customers.update(customerId, { name: clean.name ?? '', email: clean.email });
  revalidatePath(BILLING_PATH);
  return { ok: true };
}
