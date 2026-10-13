/**
 * Agent plan receipt — BACKLOG-3848 (founder Q2: Keepr sends the receipt, to
 * the billing contact, one sender).
 *
 * Producer: handleInvoicePaid (lib/billing/sync.ts) enqueues ONE billing_outbox
 * row per paid Agent invoice with amount_paid > 0, whatever the grant decides (a
 * paid invoice that does not grant is still a charge that owes a receipt). An
 * invoice settled from the customer's credit balance (total > 0, amount_paid 0,
 * no charge) gets no receipt: Stripe sends none where nothing was charged, and
 * Keepr matches it (SR ruling a). The grant keeps its own total > 0 gate. The row
 * is keyed `agent_receipt:<mode>:<invoice id>` (UNIQUE dedupe_key), so a
 * redelivered invoice.paid never queues a second receipt. It runs about ten
 * minutes later.
 *
 * Handler (kind `agent_receipt`), SR R9:
 *   - re-fetches the invoice with its charge; not paid -> nothing to send;
 *   - charge.receipt_number set -> Stripe has already emailed a receipt
 *     ("Successful payments" is still ON in the Stripe dashboard until billing
 *     go-live): skip and alert, so the customer never gets two;
 *   - a receipt for this invoice already in email_delivery_log (sent or queued)
 *     -> skip (a run that sent and then lost its lease does not send twice);
 *   - recipient: billingContactEmail(customer, sign-in email) — the same
 *     function the Billing page's "Invoices sent to" label reads.
 * The receipt_number check is a backstop, not the guard: in TEST Stripe sends
 * no receipt emails, so it cannot be observed there. The guard is the go-live
 * step that turns Stripe's own email off.
 */

import type Stripe from 'stripe';
import type { createServiceClient } from '@/lib/supabase/service';
import { sendReceiptEmail } from '@/lib/email';
import type { StripeMode } from './mode';
import { billingAlert } from './alert';
import { billingContactEmail } from './contact';
import { enqueueOutbox } from './outboxEnqueue';
import { NonRetryableOutboxError, type OutboxHandler } from './outboxKinds';

type ServiceClient = ReturnType<typeof createServiceClient>;

export const AGENT_RECEIPT_KIND = 'agent_receipt';
/** Delay before the receipt is sent (SR R9: ~10 min). */
export const AGENT_RECEIPT_DELAY_MS = 10 * 60_000;

export function agentReceiptDedupeKey(mode: StripeMode, invoiceId: string): string {
  return `agent_receipt:${mode}:${invoiceId}`;
}

export async function enqueueAgentReceipt(
  service: ServiceClient,
  args: { mode: StripeMode; userId: string; invoice: Pick<Stripe.Invoice, 'id' | 'status' | 'amount_paid'>; now?: Date }
): Promise<'enqueued' | 'exists' | 'skipped'> {
  if (args.invoice.status !== 'paid' || !(args.invoice.amount_paid > 0)) return 'skipped';
  const now = args.now ?? new Date();
  return enqueueOutbox(service, {
    mode: args.mode,
    kind: AGENT_RECEIPT_KIND,
    userId: args.userId,
    dedupeKey: agentReceiptDedupeKey(args.mode, args.invoice.id),
    payload: { invoice_id: args.invoice.id },
    runAfter: new Date(now.getTime() + AGENT_RECEIPT_DELAY_MS),
  });
}

const shortDay = (sec: number) =>
  new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' }).format(new Date(sec * 1000));

function describe(inv: Stripe.Invoice): string {
  const line = inv.lines?.data?.find((l) => l.type === 'subscription') ?? null;
  if (line?.period?.start && line.period.end) {
    return `Keepr Agent plan, ${shortDay(line.period.start)} – ${shortDay(line.period.end)}`;
  }
  return 'Keepr Agent plan';
}

function pastDeadline(deadline: Date): void {
  if (Date.now() >= deadline.getTime()) throw new Error('outbox deadline reached');
}

async function alreadySent(service: ServiceClient, invoiceId: string): Promise<boolean> {
  const { data, error } = await service
    .from('email_delivery_log')
    .select('id')
    .eq('email_type', 'receipt')
    .eq('metadata->>paymentReference', invoiceId)
    .in('status', ['sent', 'queued'])
    .limit(1);
  if (error) throw new Error(`email_delivery_log read failed: ${error.code ?? 'unknown'}`);
  return Array.isArray(data) && data.length > 0;
}

export const handleAgentReceiptRow: OutboxHandler = async (row, ctx) => {
  const invoiceId = typeof row.payload?.invoice_id === 'string' ? row.payload.invoice_id : null;
  if (!invoiceId || !row.user_id) throw new NonRetryableOutboxError('bad_payload');

  const inv = await ctx.stripe.invoices.retrieve(invoiceId, { expand: ['charge'] });
  if (inv.status !== 'paid') {
    console.info(`[billing/agent-receipt] invoice ${inv.id} is ${inv.status}; no receipt`);
    return;
  }
  const charge = inv.charge && typeof inv.charge !== 'string' ? (inv.charge as Stripe.Charge) : null;
  if (charge?.receipt_number) {
    // Stripe's own receipt went out: never a second one.
    billingAlert('agent_receipt_stripe_sent', ctx.mode, { invoice_id: inv.id });
    return;
  }
  if (await alreadySent(ctx.service, inv.id)) return;

  pastDeadline(ctx.deadline);
  const customerId = typeof inv.customer === 'string' ? inv.customer : inv.customer?.id ?? null;
  const customer = customerId ? await ctx.stripe.customers.retrieve(customerId) : null;
  let signIn: string | null = null;
  if (!billingContactEmail(customer, null)) {
    const { data } = await ctx.service.auth.admin.getUserById(row.user_id);
    signIn = data?.user?.email ?? null;
  }
  const recipientEmail = billingContactEmail(customer, signIn);
  if (!recipientEmail) throw new NonRetryableOutboxError('no_recipient');

  const result = await sendReceiptEmail({
    recipientEmail,
    amountCents: inv.amount_paid,
    description: describe(inv),
    paymentReference: inv.id,
  });
  if (result.outcome === 'sent' || result.outcome === 'queued') return;
  if (result.outcome === 'skipped') throw new NonRetryableOutboxError('email_not_configured');
  throw new Error('receipt send failed');
};
