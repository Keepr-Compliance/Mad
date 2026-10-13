/**
 * @jest-environment node
 *
 * BACKLOG-3848 — the billing contact (SR R8, R9 and the PR-1 binding note):
 * the address the Billing page shows under "Receipts sent to" / "Invoices sent
 * to" and the address the Keepr Agent receipt goes to are the SAME field. After
 * Edit contact they still agree.
 *
 * Customer: fixtures/stripe/p3848/pr2-cus-update-contact — the TEST customer as
 * `customers.update({name, email})` returned it (what customers.retrieve then
 * returns). Paid Agent invoice: pr2-inv-paid-expand-charge. Email sender mocked.
 * No network.
 */

import fs from 'fs';
import path from 'path';
import { BillingDb } from '../../helpers/billingDb';
import { clone, createStripeStub, type StripeStub } from '../../helpers/stripeStub';

const mockSendReceipt = jest.fn();
jest.mock('@sentry/nextjs', () => ({ captureMessage: jest.fn(), captureException: jest.fn() }));
jest.mock('@/lib/email', () => ({ sendReceiptEmail: (...a: unknown[]) => mockSendReceipt(...a) }));

import { handleAgentReceiptRow } from '@/lib/billing/agentReceipt';
import { getPersonalBillingView } from '@/lib/billing/personalBilling';
import type { OutboxRow } from '@/lib/billing/outboxKinds';

type Obj = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const FX = path.join(__dirname, '../../fixtures/stripe/p3848');
const fx = (n: string): Obj => JSON.parse(fs.readFileSync(path.join(FX, `${n}.json`), 'utf8'));

const EDITED = fx('pr2-cus-update-contact');
const INV = fx('pr2-inv-paid-expand-charge');
const USER = 'USER-3848-CONTACT';
const SIGN_IN = 'signin-3848@example.invalid';
const EMPTY_LIST = { object: 'list', data: [], has_more: false, url: '/v1/invoices' };

let stripe: StripeStub;
let getUserById: jest.Mock;
let db: BillingDb;

function service() {
  return { from: db.from, auth: { admin: { getUserById } } } as never;
}

beforeEach(() => {
  jest.clearAllMocks();
  db = new BillingDb({
    stripe_customers: [{ user_id: USER, stripe_customer_id: EDITED.id, default_payment_method_id: null, stripe_mode: 'test' }],
    email_delivery_log: [],
  });
  getUserById = jest.fn(async () => ({ data: { user: { email: SIGN_IN } }, error: null }));
  stripe = createStripeStub({
    'customers.retrieve': () => EDITED,
    'invoices.list': () => EMPTY_LIST,
    'charges.list': () => ({ ...EMPTY_LIST, url: '/v1/charges' }),
    'invoices.retrieve': () => INV,
  });
  mockSendReceipt.mockResolvedValue({ success: true, outcome: 'sent' });
});

async function labelEmail(): Promise<string | null> {
  const v = await getPersonalBillingView({
    session: { rpc: async () => ({ data: 0, error: null }) } as never,
    service: service(),
    stripe: stripe.client,
    userId: USER,
    signInEmail: SIGN_IN,
    mode: 'test',
    view: { row: null },
  });
  return v.contact.email;
}

async function agentRecipient(): Promise<string> {
  mockSendReceipt.mockClear();
  const row: OutboxRow = {
    id: 'ob-1', stripe_mode: 'test', kind: 'agent_receipt', user_id: USER, organization_id: null,
    dedupe_key: `agent_receipt:test:${INV.id}`, run_after: '2026-10-13T00:00:00Z', payload: { invoice_id: INV.id },
    attempts: 1, last_error: null, claimed_until: null, created_at: '2026-10-13T00:00:00Z', processed_at: null,
  };
  await handleAgentReceiptRow(row, { stripe: stripe.client, service: service(), mode: 'test', deadline: new Date(Date.now() + 60_000) });
  return mockSendReceipt.mock.calls[0][0].recipientEmail;
}

describe('C-RCPT: the Agent plan receipt goes to the billing contact', () => {
  it('customer email set (after Edit contact) -> that address, not the sign-in email', async () => {
    expect(EDITED.email).toBe('billing-3848@example.invalid');
    expect(await agentRecipient()).toBe(EDITED.email);
    expect(stripe.callsTo('customers.retrieve')).toEqual([[EDITED.id]]);
  });

  it.each([
    ['deleted customer', () => ({ id: EDITED.id, object: 'customer', deleted: true })],
    ['customer without email [EDITED email null]', () => ({ ...clone(EDITED), email: null })],
  ])('%s -> the sign-in email', async (_n, c) => {
    stripe.impl['customers.retrieve'] = c;
    expect(await agentRecipient()).toBe(SIGN_IN);
  });
});

describe('C-RCPT-SAME-FIELD: the label and the receipt sender read one address', () => {
  it('after Edit contact: label == Agent recipient == the edited email', async () => {
    const label = await labelEmail();
    expect(label).toBe(EDITED.email);
    expect(await agentRecipient()).toBe(label);
  });

  it('no customer email [EDITED email null]: both fall back to the sign-in email', async () => {
    stripe.impl['customers.retrieve'] = () => ({ ...clone(EDITED), email: null });
    const label = await labelEmail();
    expect(label).toBe(SIGN_IN);
    expect(await agentRecipient()).toBe(label);
  });
});
