/**
 * Which brokerage invoices are overdue — BACKLOG-3853.
 *
 * One rule, shared by the brokerage webhook (./brokerage.ts: the overdue alert and
 * tryAutoReinstate, which keeps a non-payment suspension while ANY open invoice is
 * past due) and the "account suspended" email (./brokerageNotify.ts: the Pay
 * button opens the oldest overdue invoice). So the button always points at an
 * invoice the reinstate rule is waiting on.
 *
 * "Now" is the customer's test clock time when it has one (Stripe TEST), else the
 * wall clock. Pure parts take `now` explicitly.
 */

import type Stripe from 'stripe';
import { stripeId } from './sync';

type StripeReader = { stripe: Stripe };

/** Seconds "now" for due-date comparisons: the customer's test clock time when it has one. */
export async function stripeNow(ctx: StripeReader, customerId: string): Promise<number> {
  const customer = await ctx.stripe.customers.retrieve(customerId);
  const clockId = stripeId((customer as unknown as { test_clock?: string | { id: string } | null }).test_clock ?? null);
  if (clockId) {
    const clock = await ctx.stripe.testHelpers.testClocks.retrieve(clockId);
    return clock.frozen_time;
  }
  return Math.floor(Date.now() / 1000);
}

/** The customer's open invoices (one page of 100; a brokerage has one subscription). */
export async function listOpenInvoices(ctx: StripeReader, customerId: string): Promise<Stripe.Invoice[]> {
  const list = await ctx.stripe.invoices.list({ customer: customerId, status: 'open', limit: 100 });
  return list.data;
}

/** Of these invoices, the ones whose due date has passed at `now`, oldest due first. */
export function overdueOf(invoices: readonly Stripe.Invoice[], now: number): Stripe.Invoice[] {
  return invoices
    .filter((i) => typeof i.due_date === 'number' && i.due_date < now)
    .sort((a, b) => (a.due_date ?? 0) - (b.due_date ?? 0));
}

/** The oldest of these invoices by due date (then by created). Stripe lists newest first. */
export function oldestOf(invoices: readonly Stripe.Invoice[]): Stripe.Invoice | null {
  const sorted = [...invoices].sort(
    (a, b) => (a.due_date ?? Number.MAX_SAFE_INTEGER) - (b.due_date ?? Number.MAX_SAFE_INTEGER) || a.created - b.created
  );
  return sorted[0] ?? null;
}
