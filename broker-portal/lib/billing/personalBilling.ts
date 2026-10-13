/**
 * Billing blocks 4–6 for a personal owner (Credits, Payment method & billing
 * contact, Receipts / Invoices) — BACKLOG-3848, read-only part.
 *
 * Read only. Nothing here creates or changes a Stripe object: a page view never
 * creates a Stripe customer (no ensureStripeCustomer), never calls a Stripe write
 * endpoint and never writes a table. The caller runs it only after the page
 * admitted a personal owner.
 *
 * Sources:
 *   - credits: get_credit_balance() on the signed-in user's own session, with no
 *     argument (SECURITY DEFINER; an authenticated caller reads only its own
 *     balance);
 *   - the user's Stripe customer in this deployment's mode, from
 *     getStripeCustomer (keyed by user_id AND stripe_mode). No row -> nothing
 *     is read from Stripe;
 *   - with a customer: customers.retrieve (contact + default card), the Agent
 *     subscription's default card, invoices.list and charges.list for that
 *     customer, all in parallel. One row per INVOICE; a charge that belongs to
 *     an invoice never makes a row of its own (a renewal retried three times
 *     has four charges and one invoice).
 *
 * Each source fails soft to "unavailable" so one failed read never blanks the
 * page.
 */

import type Stripe from 'stripe';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { createServiceClient } from '@/lib/supabase/service';
import type { AgentPlanView } from './agentPlan';
import type { StripeMode } from './mode';
import { getStripeCustomer } from './customers';

type ServiceClient = ReturnType<typeof createServiceClient>;
type SessionClient = Pick<SupabaseClient, 'rpc'>;

/** How many invoices and charges are read for the table. */
export const ROWS_LIMIT = 20;

export interface CardView {
  brand: string;
  last4: string;
  expMonth: number;
  expYear: number;
}

export type RowStatus = 'paid' | 'payment_failed' | 'open' | 'void' | 'uncollectible' | 'refunded' | 'partly_refunded';

export interface BillingRow {
  id: string;
  /** Unix seconds. */
  created: number;
  description: string;
  amountCents: number;
  currency: string;
  status: RowStatus;
  link: string | null;
  linkLabel: 'View' | 'Receipt';
}

export interface FailedInvoice {
  amountCents: number;
  currency: string;
  /** Unix seconds. */
  created: number;
}

export interface PersonalBillingData {
  /** null: the balance could not be read. */
  credits: number | null;
  /** 'none': no Stripe customer in this mode. 'unavailable': the customer row or Stripe read failed. */
  customer: 'present' | 'none' | 'unavailable';
  card: CardView | null;
  contact: { name: string | null; email: string | null };
  /** null: unavailable. */
  rows: BillingRow[] | null;
  /** The open Agent invoice whose charge failed, newest first. */
  failedInvoice: FailedInvoice | null;
}

function idOf(x: string | { id: string } | null | undefined): string | null {
  if (!x) return null;
  return typeof x === 'string' ? x : x.id;
}

/** A card from an expanded PaymentMethod; an id string (not expanded) or a non-card method gives null. */
export function cardFrom(pm: string | Stripe.PaymentMethod | null | undefined): CardView | null {
  if (!pm || typeof pm === 'string' || !pm.card) return null;
  return { brand: pm.card.brand, last4: pm.card.last4, expMonth: pm.card.exp_month, expYear: pm.card.exp_year };
}

const shortDay = (sec: number) =>
  new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' }).format(new Date(sec * 1000));

function invoiceDescription(inv: Stripe.Invoice): string {
  const lines = inv.lines?.data ?? [];
  const line = lines.find((l) => l.type === 'subscription') ?? null;
  if (line?.period?.start && line.period.end) {
    return `Agent plan · ${shortDay(line.period.start)} – ${shortDay(line.period.end)}`;
  }
  return inv.description ?? 'Invoice';
}

function invoiceStatus(inv: Stripe.Invoice): RowStatus | null {
  switch (inv.status) {
    case 'paid':
      return 'paid';
    case 'open':
      return (inv.attempt_count ?? 0) > 0 ? 'payment_failed' : 'open';
    case 'void':
      return 'void';
    case 'uncollectible':
      return 'uncollectible';
    default:
      // draft (not issued yet) and anything unknown: no row.
      return null;
  }
}

function chargeStatus(ch: Stripe.Charge): RowStatus | null {
  // A failed or pending per-export charge took no money: it is not a receipt.
  if (ch.status !== 'succeeded') return null;
  if (ch.refunded) return 'refunded';
  if ((ch.amount_refunded ?? 0) > 0) return 'partly_refunded';
  return 'paid';
}

/**
 * One row per invoice (Agent plan), plus one per charge that has no invoice
 * (a per-export payment, "Export unlock"). Newest first, at most ROWS_LIMIT.
 */
export function rowsFrom(invoices: Stripe.Invoice[], charges: Stripe.Charge[]): BillingRow[] {
  const rows: BillingRow[] = [];
  for (const inv of invoices) {
    const status = invoiceStatus(inv);
    if (!status) continue;
    rows.push({
      id: inv.id,
      created: inv.created,
      description: invoiceDescription(inv),
      amountCents: inv.total,
      currency: inv.currency,
      status,
      link: inv.hosted_invoice_url ?? null,
      linkLabel: 'View',
    });
  }
  for (const ch of charges) {
    if (idOf(ch.invoice as string | Stripe.Invoice | null)) continue;
    const status = chargeStatus(ch);
    if (!status) continue;
    rows.push({
      id: ch.id,
      created: ch.created,
      description: 'Export unlock',
      amountCents: ch.amount,
      currency: ch.currency,
      status,
      link: ch.receipt_url ?? null,
      linkLabel: 'Receipt',
    });
  }
  rows.sort((a, b) => b.created - a.created);
  return rows.slice(0, ROWS_LIMIT);
}

/** The newest open invoice that has had a failed charge attempt. */
export function failedInvoiceFrom(invoices: Stripe.Invoice[]): FailedInvoice | null {
  const inv = invoices
    .filter((i) => i.status === 'open' && (i.attempt_count ?? 0) > 0)
    .sort((a, b) => b.created - a.created)[0];
  return inv ? { amountCents: inv.amount_due, currency: inv.currency, created: inv.created } : null;
}

async function soft<T>(label: string, p: Promise<T>): Promise<T | null> {
  try {
    return await p;
  } catch (e) {
    console.error(`[billing/personal] ${label} read failed:`, (e as Error).message);
    return null;
  }
}

async function creditBalance(session: SessionClient): Promise<number | null> {
  // No p_user_id: the RPC resolves the caller from the session.
  const { data, error } = await session.rpc('get_credit_balance');
  if (error) throw new Error(error.message);
  return typeof data === 'number' ? data : null;
}

export async function getPersonalBillingView(args: {
  session: SessionClient;
  service: ServiceClient;
  /** null: Stripe is not configured; card, contact and rows read as unavailable. */
  stripe: Stripe | null;
  userId: string;
  signInEmail: string | null;
  mode: StripeMode;
  view: Pick<AgentPlanView, 'row'>;
}): Promise<PersonalBillingData> {
  const { session, service, stripe, userId, signInEmail, mode, view } = args;
  const creditsP = soft('credits', creditBalance(session));

  let row: Awaited<ReturnType<typeof getStripeCustomer>> | undefined;
  try {
    row = await getStripeCustomer(service, userId, mode);
  } catch (e) {
    console.error('[billing/personal] customer row read failed:', (e as Error).message);
  }
  if (row === undefined || row === null) {
    return {
      credits: await creditsP,
      customer: row === null ? 'none' : 'unavailable',
      card: null,
      contact: { name: null, email: signInEmail },
      rows: row === null ? [] : null,
      failedInvoice: null,
    };
  }

  if (!stripe) {
    return { credits: await creditsP, customer: 'unavailable', card: null, contact: { name: null, email: signInEmail }, rows: null, failedInvoice: null };
  }
  const customerId = row.stripe_customer_id;
  const subId = view.row?.stripe_subscription_id ?? null;
  const [credits, customer, sub, invoices, charges] = await Promise.all([
    creditsP,
    soft('customer', stripe.customers.retrieve(customerId, { expand: ['invoice_settings.default_payment_method'] })),
    subId ? soft('subscription', stripe.subscriptions.retrieve(subId, { expand: ['default_payment_method'] })) : null,
    soft('invoices', stripe.invoices.list({ customer: customerId, limit: ROWS_LIMIT })),
    soft('charges', stripe.charges.list({ customer: customerId, limit: ROWS_LIMIT })),
  ]);

  const live = customer && !('deleted' in customer && customer.deleted) ? (customer as Stripe.Customer) : null;
  // The card that is charged next: the subscription's own default, then the customer's.
  let card =
    cardFrom(sub?.default_payment_method as Stripe.PaymentMethod | string | null) ??
    cardFrom(live?.invoice_settings?.default_payment_method as Stripe.PaymentMethod | string | null);
  if (!card && row.default_payment_method_id) {
    // The card saved at the last per-export purchase.
    card = cardFrom(await soft('payment method', stripe.paymentMethods.retrieve(row.default_payment_method_id)));
  }

  return {
    credits,
    customer: customer ? 'present' : 'unavailable',
    card,
    contact: { name: live?.name ?? null, email: live?.email ?? signInEmail },
    rows: invoices && charges ? rowsFrom(invoices.data, charges.data) : null,
    failedInvoice: invoices ? failedInvoiceFrom(invoices.data) : null,
  };
}
