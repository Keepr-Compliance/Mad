/**
 * billing_outbox kind `notify_payment_failed` — BACKLOG-3932 (plan pm_comments 72a89749 + delta
 * ce8c1637, SR-approved 4b489443; founder answers ec5377e1, 0486b6aa).
 *
 * Enqueued by the Stripe webhook (./brokerage.ts, invoice.payment_failed on a brokerage
 * invoice, never for requires_action) with run_after = +1 hour. One row per FAILED ATTEMPT:
 * dedupe key 'notify_payment_failed:<mode>:<org>:<invoice id>:<charge id>', where the charge id
 * is the PaymentIntent's latest_charge (else last_payment_error.charge, else the PaymentIntent
 * id, else 'none' when the invoice has no PaymentIntent). A redelivered event, or a second event
 * for the same attempt, gives the same key; a new attempt that fails gives a new row.
 * Payload: {organization_id, invoice_id, charge_id}. Never the hosted invoice URL.
 *
 * Resolved at RUN time (outboxKinds.ts contract):
 *  - Deal: must exist and be active or canceling. A canceled / draft deal has nothing to pay
 *    for; a suspended deal already got the suspension email (whose copy differs: members lose
 *    access there, this email says they keep it).
 *  - Recipient: org_deals.billing_contact_email only (founder Q3). None -> nothing to send, no
 *    error (the account-manager alert still goes).
 *  - A send already in email_delivery_log for this row's key -> no second send.
 *  - ONE Stripe call: invoices.retrieve(invoice, {expand: ['payment_intent']}) (live Stripe; no
 *    invoice mirror exists). Send only when ALL hold (a positive gate, SR R2):
 *      status === 'open', amount_remaining > 0, the PaymentIntent is not processing /
 *      requires_action / succeeded, and its latest_charge is still this row's charge (else a
 *      newer attempt owns the email and its own row decides).
 *    Anything else: no send, row processed, an info log with codes only.
 *  - Amount = amount_remaining (customer_balance can pay part of an invoice), formatted from
 *    minor units: usd / 100, zero-decimal currencies / 1; any other currency -> no amount in the
 *    sentence rather than a wrong one.
 *  - Pay link = the re-fetched hosted_invoice_url when it is https, else the Keepr Billing page.
 *    It is a bearer link: email body only (never payload, log metadata, last_error or console).
 */

import type Stripe from 'stripe';
import { sendPaymentFailedEmail } from '@/lib/email';
import { NonRetryableOutboxError, type OutboxHandler, type OutboxRow } from './outboxKinds';
import type { createServiceClient } from '@/lib/supabase/service';

type ServiceClient = ReturnType<typeof createServiceClient>;

export const NOTIFY_PAYMENT_FAILED_KIND = 'notify_payment_failed';
export const PAYMENT_FAILED_LOG_KIND = 'org_payment_failed';
/** Founder Q4: wait an hour, so a quick successful retry on the hosted page supersedes the email. */
export const PAYMENT_FAILED_DELAY_MS = 60 * 60 * 1000;
/** Charge segment of the key when the invoice has no PaymentIntent at all. */
export const NO_CHARGE = 'none';

const BILLING_PATH = '/dashboard/billing';
const SENDABLE_DEAL = new Set(['active', 'canceling']);
const NOT_A_FAILURE_NOW = new Set(['processing', 'requires_action', 'succeeded']);
/** Stripe's zero-decimal currencies (amounts are already whole units). */
const ZERO_DECIMAL = new Set(['bif', 'clp', 'djf', 'gnf', 'jpy', 'kmf', 'krw', 'mga', 'pyg', 'rwf', 'ugx', 'vnd', 'vuv', 'xaf', 'xof', 'xpf']);

function baseUrl(): string {
  return process.env.NEXT_PUBLIC_APP_URL || 'https://app.keeprcompliance.com';
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}

function idOf(v: unknown): string | null {
  if (typeof v === 'string') return v || null;
  if (v && typeof v === 'object' && typeof (v as { id?: unknown }).id === 'string') return (v as { id: string }).id;
  return null;
}

/** The charge segment of the dedupe key for one PaymentIntent (shared with the webhook). */
export function failedAttemptId(pi: Pick<Stripe.PaymentIntent, 'id' | 'latest_charge' | 'last_payment_error'> | null): string {
  if (!pi) return NO_CHARGE;
  const lastError = pi.last_payment_error as { charge?: unknown } | null | undefined;
  return idOf(pi.latest_charge) ?? idOf(lastError?.charge) ?? pi.id;
}

/** "$24.97" from minor units, or null when the currency is not one we format safely. */
export function formatAmount(minor: number, currency: string): string | null {
  const c = currency.toLowerCase();
  let units: number;
  if (c === 'usd') units = minor / 100;
  else if (ZERO_DECIMAL.has(c)) units = minor;
  else return null;
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: c.toUpperCase() }).format(units);
}

async function alreadySent(service: ServiceClient, outboxKey: string): Promise<boolean> {
  const { data, error } = await service
    .from('email_delivery_log')
    .select('id')
    .eq('metadata->>kind', PAYMENT_FAILED_LOG_KIND)
    .eq('metadata->>outboxKey', outboxKey)
    .in('status', ['sent', 'queued'])
    .limit(1);
  if (error) throw new Error(`email_delivery_log read failed: ${error.code ?? 'unknown'}`);
  return Array.isArray(data) && data.length > 0;
}

function skip(row: OutboxRow, code: string): void {
  console.info(`[billing/payment-failed] ${row.id}: ${code}; nothing to send`);
}

export const handleNotifyPaymentFailedRow: OutboxHandler = async (row: OutboxRow, ctx) => {
  const org = row.organization_id ?? str(row.payload?.organization_id);
  const invoiceId = str(row.payload?.invoice_id);
  const chargeId = str(row.payload?.charge_id);
  if (!org || !invoiceId || !chargeId) throw new NonRetryableOutboxError('bad_payload');
  const { service } = ctx;

  const { data: deal, error: dErr } = await service
    .from('org_deals')
    .select('status, billing_contact_email')
    .eq('organization_id', org)
    .maybeSingle();
  if (dErr) throw new Error(`org_deals read failed: ${dErr.code ?? 'unknown'}`);
  const d = deal as { status?: string | null; billing_contact_email?: string | null } | null;
  if (!d || !SENDABLE_DEAL.has(d.status ?? '')) return skip(row, `deal_${d?.status ?? 'missing'}`);
  const email = (d.billing_contact_email ?? '').trim();
  if (!email) return skip(row, 'no_billing_contact');
  if (await alreadySent(service, row.dedupe_key)) return;

  // The only Stripe call (contract (e) needs no deadline check).
  const inv = await ctx.stripe.invoices.retrieve(invoiceId, { expand: ['payment_intent'] });
  const pi = (inv as unknown as { payment_intent?: Stripe.PaymentIntent | string | null }).payment_intent ?? null;
  const piObj = pi && typeof pi === 'object' ? pi : null;
  if (inv.status !== 'open') return skip(row, `invoice_${inv.status ?? 'unknown'}`);
  const remaining = typeof inv.amount_remaining === 'number' ? inv.amount_remaining : 0;
  if (remaining <= 0) return skip(row, 'nothing_remaining');
  if (piObj && NOT_A_FAILURE_NOW.has(piObj.status)) return skip(row, `payment_${piObj.status}`);
  if (failedAttemptId(piObj) !== chargeId) return skip(row, 'superseded_by_newer_attempt');

  const { data: o, error: oErr } = await service.from('organizations').select('name').eq('id', org).maybeSingle();
  if (oErr) throw new Error(`organizations read failed: ${oErr.code ?? 'unknown'}`);
  const brokerageName = ((o as { name?: string | null } | null)?.name ?? '').trim() || 'your brokerage';
  const hosted = inv.hosted_invoice_url ?? null;
  const payUrl = hosted && hosted.startsWith('https://') ? hosted : `${baseUrl()}${BILLING_PATH}`;

  const result = await sendPaymentFailedEmail({
    recipientEmail: email,
    brokerageName,
    amountLabel: formatAmount(remaining, inv.currency ?? ''),
    payUrl,
    outboxKey: row.dedupe_key,
    organizationId: org,
  });
  if (result.outcome === 'sent' || result.outcome === 'queued') return;
  if (result.outcome === 'skipped') throw new NonRetryableOutboxError('email_not_configured');
  throw new Error('email send failed');
};
