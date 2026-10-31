/**
 * The brokerage's recent invoices on the organization Billing page — BACKLOG-3855.
 *
 * Live Stripe read, server side, for the caller's own organization (the page passes the org id
 * from the admitted session and only when billingCapabilities says canSeeInvoices). No mirror
 * table and no caching. Same shape as ./orgPayLink.ts: one time limit for all reads, any failure
 * or timeout -> null ("unavailable"), the page never waits longer or breaks for it.
 *
 * Rows are plain data for the client: no Stripe object ids. `number` is the printed invoice
 * number. Links are https only.
 */

import type Stripe from 'stripe';
import type { SupabaseClient } from '@supabase/supabase-js';
import { overdueOf, stripeNow } from './overdue';
import { readOrgCustomerId } from './orgBillingSetUp';
import type { StripeMode } from './mode';

/** Rows shown on the page. */
export const ORG_INVOICES_LIMIT = 5;
/** All Stripe reads together get this long; past it the rows read "unavailable". */
export const ORG_INVOICES_TIMEOUT_MS = 3000;
/** One page from Stripe; drafts are skipped before taking ORG_INVOICES_LIMIT. */
const LIST_PAGE = 10;

export type OrgInvoiceStatus = 'paid' | 'due' | 'overdue' | 'void' | 'unpaid';

export interface OrgInvoiceRow {
  /** The printed invoice number (not a Stripe object id). */
  number: string | null;
  /** Unix seconds the invoice was created. */
  created: number;
  /** What the invoice asked for (amount_due), in the currency's minor unit. */
  amountCents: number;
  currency: string;
  status: OrgInvoiceStatus;
  /** https PDF link, or null. */
  pdfUrl: string | null;
  /** https hosted invoice page, only while something is left to pay; else null. */
  payUrl: string | null;
}

type Deps = { service: SupabaseClient; stripe: Stripe; mode: StripeMode; organizationId: string };

export async function recentOrgInvoices(deps: Deps): Promise<OrgInvoiceRow[] | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<null>((resolve) => {
    timer = setTimeout(() => {
      console.error('[billing/page] organization invoices timed out');
      resolve(null);
    }, ORG_INVOICES_TIMEOUT_MS);
  });
  try {
    return await Promise.race([lookup(deps), timedOut]);
  } finally {
    clearTimeout(timer);
  }
}

async function lookup(deps: Deps): Promise<OrgInvoiceRow[] | null> {
  try {
    const customerId = await readOrgCustomerId(deps.service, deps.organizationId, deps.mode);
    if (!customerId) return [];
    const [now, list] = await Promise.all([
      stripeNow({ stripe: deps.stripe }, customerId),
      deps.stripe.invoices.list({ customer: customerId, limit: LIST_PAGE }),
    ]);
    return list.data
      .filter((inv) => inv.status !== 'draft')
      .slice(0, ORG_INVOICES_LIMIT)
      .map((inv) => toRow(inv, now));
  } catch (e) {
    console.error('[billing/page] organization invoices unavailable:', (e as Error).message);
    return null;
  }
}

function httpsOnly(url: string | null | undefined): string | null {
  return typeof url === 'string' && url.startsWith('https://') ? url : null;
}

function statusOf(inv: Stripe.Invoice, now: number): OrgInvoiceStatus {
  if (inv.status === 'open') return overdueOf([inv], now).length > 0 ? 'overdue' : 'due';
  if (inv.status === 'paid') return 'paid';
  if (inv.status === 'void') return 'void';
  return 'unpaid';
}

function toRow(inv: Stripe.Invoice, now: number): OrgInvoiceRow {
  const status = statusOf(inv, now);
  const payable = (status === 'due' || status === 'overdue' || status === 'unpaid') && inv.amount_remaining > 0;
  return {
    number: inv.number ?? null,
    created: inv.created,
    amountCents: inv.amount_due,
    currency: inv.currency,
    status,
    pdfUrl: httpsOnly(inv.invoice_pdf),
    payUrl: payable ? httpsOnly(inv.hosted_invoice_url) : null,
  };
}
