/**
 * BACKLOG-3855 fixtures, transcribed from __tests__/fixtures/stripe/p3853 (Stripe TEST spike
 * captures, send_invoice with a due date: the brokerage shape; see that README).
 *
 * Edits, each disclosed where it is made:
 *   - [EDITED] invoice_pdf: the captures carry `[REDACTED hosted URL]` (redaction, not a producer
 *     state). Re-redacted to `https://invoice.stripe.test/REDACTED/<that invoice's id>.pdf`, the
 *     same convention 3853 PR-2B used for hosted_invoice_url (README line added).
 *   - [EDITED] inv-paid.json hosted_invoice_url: same re-redaction as the open list.
 *   - [EDITED] status / due_date / amount_remaining per case (void, uncollectible, draft,
 *     boundary sweep): status flips of a captured invoice, labelled where used.
 *   - [EDITED] the test clock's frozen_time, as 3853's tests do.
 *   - [SYNTHETIC] the non-https rows (http:// links): a redaction artefact, not a producer state.
 * inv-paid.json is the SAME invoice as the open list's A9SLAZ3T-0001 after it was paid; a test
 * that lists both says so.
 */

import fs from 'fs';
import path from 'path';
import type Stripe from 'stripe';

const DIR = path.join(__dirname, '../fixtures/stripe/p3853');
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const read = (n: string): any => JSON.parse(fs.readFileSync(path.join(DIR, `${n}.json`), 'utf8'));

export const P3853_CUSTOMER = read('customer');
export const P3853_CLOCK = read('clock');
/** The customer id the captures belong to (org A's, test mode). */
export const CUSTOMER_A: string = P3853_CUSTOMER.id;

export const pdfUrlFor = (id: string) => `https://invoice.stripe.test/REDACTED/${id}.pdf`;
export const payUrlFor = (id: string) => `https://invoice.stripe.test/REDACTED/${id}`;

/** [EDITED] invoice_pdf re-redacted to an https placeholder. */
function withPdf(inv: Stripe.Invoice): Stripe.Invoice {
  return { ...inv, invoice_pdf: pdfUrlFor(inv.id as string) };
}

/** The five open invoices, newest first (as Stripe lists them), A9SLAZ3T-0005 .. -0001. */
export function openInvoices(): Stripe.Invoice[] {
  return (read('inv-list-open').data as Stripe.Invoice[]).map(withPdf);
}

/** A9SLAZ3T-0001 after it was paid. [EDITED] hosted_invoice_url + invoice_pdf placeholders. */
export function paidInvoice(): Stripe.Invoice {
  const inv = read('inv-paid') as Stripe.Invoice;
  return { ...withPdf(inv), hosted_invoice_url: payUrlFor(inv.id as string) };
}

export function listOf(data: Stripe.Invoice[]) {
  return { object: 'list', data, has_more: false, url: '/v1/invoices' };
}

/** Stripe-shaped ids that must never reach the client (SR C4). */
export const STRIPE_ID = /\b(in|cus|sub|pi|ch|bpc|bps)_[A-Za-z0-9]{6,}/;
