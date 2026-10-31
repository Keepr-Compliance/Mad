/**
 * lib/billing/orgPayLink.ts filters — BACKLOG-3855 SR ruling 4 (C2). Test only; no change to
 * orgPayLink.ts.
 *
 *   - the customer row read is filtered to the caller's organization (another org's row in the
 *     same mode is never used);
 *   - a non-https hosted_invoice_url gives no button.
 *
 * Service client: BillingDb (filters applied and recorded; maybeSingle over two rows answers
 * PGRST116, as PostgREST does). Stripe: p3853 TEST captures (README there).
 */

import fs from 'fs';
import path from 'path';
import type Stripe from 'stripe';
import type { SupabaseClient } from '@supabase/supabase-js';
import { BillingDb } from '../helpers/billingDb';
import { oldestOverdueInvoiceUrl } from '@/lib/billing/orgPayLink';

const DIR = path.join(__dirname, '../fixtures/stripe/p3853');
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const p3853 = (n: string): any => JSON.parse(fs.readFileSync(path.join(DIR, `${n}.json`), 'utf8'));

const ORG_A = '00000000-0000-4000-8000-000000000000'; // pii-allow-uuid: nil-style invented fixture id
const ORG_B = '00000000-0000-4000-8000-000000385502'; // pii-allow-uuid: invented fixture id
const CUSTOMER_A: string = p3853('customer').id;
const CUSTOMER_B = 'cus_EDITED_3855_orgB';
const OLDEST_PAY_URL = 'https://invoice.stripe.test/REDACTED/in_1URdzABg3cyTef3dyKhMzjZn';

const invoicesList = jest.fn();
const stripe = {
  invoices: { list: (...a: unknown[]) => invoicesList(...a) },
  customers: { retrieve: jest.fn(async () => p3853('customer')) },
  testHelpers: { testClocks: { retrieve: jest.fn(async () => ({ ...p3853('clock'), frozen_time: 1805122801 })) } }, // [EDITED] frozen_time
} as unknown as Stripe;

let db: BillingDb;
const run = (organizationId: string) =>
  oldestOverdueInvoiceUrl({ service: { from: db.from } as unknown as SupabaseClient, stripe, mode: 'test', organizationId });

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(console, 'error').mockImplementation(() => {});
  invoicesList.mockResolvedValue(p3853('inv-list-open'));
  db = new BillingDb({
    org_billing_stripe: [
      { organization_id: ORG_A, stripe_mode: 'test', stripe_customer_id: CUSTOMER_A },
      { organization_id: ORG_B, stripe_mode: 'test', stripe_customer_id: CUSTOMER_B },
    ],
  });
});
afterEach(() => jest.restoreAllMocks());

describe('orgPayLink: the caller organization only', () => {
  it('two organizations with customers in this mode: org A gets its own oldest overdue invoice', async () => {
    expect(await run(ORG_A)).toBe(OLDEST_PAY_URL);
    expect(invoicesList.mock.calls).toEqual([[{ customer: CUSTOMER_A, status: 'open', limit: 100 }]]);
  });
  it('org B reads B\'s customer, never A\'s', async () => {
    await run(ORG_B);
    expect(invoicesList.mock.calls).toEqual([[{ customer: CUSTOMER_B, status: 'open', limit: 100 }]]);
  });
});

describe('orgPayLink: https only', () => {
  it('[SYNTHETIC] http:// hosted_invoice_url on the oldest overdue invoice -> no button', async () => {
    const list = p3853('inv-list-open');
    list.data = list.data.map((i: { id: string; hosted_invoice_url: string }) => ({ ...i, hosted_invoice_url: `http://invoice.stripe.test/REDACTED/${i.id}` }));
    invoicesList.mockResolvedValue(list);
    expect(await run(ORG_A)).toBeNull();
  });
});
