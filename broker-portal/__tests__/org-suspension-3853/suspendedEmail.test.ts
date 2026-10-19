/**
 * @jest-environment node
 *
 * BACKLOG-3853 PR-2B — the "account suspended" email's Pay button and wording
 * (founder 64e00066, 1e164f56 Q1; SR 4942bc59 RC2-RC6).
 *
 * The REAL handler (lib/billing/brokerageNotify.ts) and the REAL template
 * (lib/email/templates/account-suspended.ts) run; only the sender is mocked (it
 * returns the built content) and Stripe is a recorder over transcribed fixtures:
 *   inv-list-open.json  five open invoices on test clock A, newest first, as Stripe
 *                       lists them; hosted_invoice_url re-redacted per invoice id
 *                       (README, disclosed) so the link names the invoice chosen.
 *   customer.json       the customer on clock A (test_clock set).
 *   clock.json          clock A; frozen_time is [EDITED] per test to the "now" named.
 * Due dates (oldest first): in_1URdzA 1794754800, in_1URe1b 1797346800,
 * in_1URe1n 1800025200, in_1URe1z 1802703600, in_1URe2F 1805122800.
 */

import fs from 'fs';
import path from 'path';
import { createBrokerageFake, dealRow, type BrokerageFake } from '../helpers/brokerageFake';

const mockAlert = jest.fn();
const mockSend = jest.fn();
jest.mock('@sentry/nextjs', () => ({ captureMessage: jest.fn(), captureException: jest.fn() }));
jest.mock('@/lib/billing/alert', () => ({ billingAlert: (...a: unknown[]) => mockAlert(...a) }));
jest.mock('@/lib/email', () => ({
  sendAccountSuspendedEmail: (...a: unknown[]) => mockSend(...a),
  sendAccountManagerAlertEmail: jest.fn(),
}));

import { handleNotifyOrgSuspendedRow } from '@/lib/billing/brokerageNotify';
import { buildAccountSuspendedEmail } from '@/lib/email/templates/account-suspended';
import type { OutboxRow } from '@/lib/billing/outboxKinds';
import type { AccountSuspendedParams } from '@/lib/email/types';

type Obj = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const FX = path.join(__dirname, '../fixtures/stripe/p3853');
const fx = (name: string): Obj => JSON.parse(fs.readFileSync(path.join(FX, `${name}.json`), 'utf8'));

const ORG = 'ORG-3853-A';
const CUSTOMER = 'cus_VSZ7P8iqRvHlbC';
const OLDEST = 'in_1URdzABg3cyTef3dyKhMzjZn';
const NEWEST = 'in_1URe2FBg3cyTef3dddMb2Oqn';
const OLDEST_DUE = 1794754800;
const NEWEST_DUE = 1805122800;
const CLOCK_START = 1793458800;
const SUSPENDED_AT = '2026-10-19T12:00:00.000Z';
const EPOCH = Date.parse(SUSPENDED_AT) / 1000;
const MEMBERS =
  "While the account is suspended, members can't submit transactions, buy exports or invite people. They can still view their own submissions.";

let fake: BrokerageFake;
let frozen = NEWEST_DUE + 1;
const stripe = {
  customers: { retrieve: jest.fn() },
  testHelpers: { testClocks: { retrieve: jest.fn() } },
  invoices: { list: jest.fn() },
};

function row(over: Partial<OutboxRow> = {}): OutboxRow {
  return {
    id: 'outbox-pr2b',
    stripe_mode: 'test',
    kind: 'notify_org_suspended',
    user_id: null,
    organization_id: ORG,
    dedupe_key: `notify_org_suspended:test:${ORG}:${EPOCH}`,
    run_after: SUSPENDED_AT,
    payload: { organization_id: ORG, suspended_at_epoch: EPOCH },
    attempts: 1,
    last_error: null,
    claimed_until: null,
    created_at: SUSPENDED_AT,
    processed_at: null,
    ...over,
  };
}
const ctx = () => ({ stripe: stripe as never, service: fake.service as never, mode: 'test' as const, deadline: new Date(Date.now() + 60_000) });

function given(reason: 'non_payment' | 'other', opts: { customer?: string | null; noRow?: boolean } = {}): void {
  fake = createBrokerageFake({
    organizations: [{ id: ORG, name: 'Brokerage 3853 A', is_test: true }],
    org_deals: [dealRow(ORG, { status: 'suspended', suspended_reason: reason, suspended_at: SUSPENDED_AT })],
    org_billing_stripe: opts.noRow
      ? []
      : [{ organization_id: ORG, stripe_mode: 'test', stripe_customer_id: opts.customer === undefined ? CUSTOMER : opts.customer }],
    email_delivery_log: [],
  });
}

/** The params the handler sent, and the email the real template builds from them. */
async function sent(r: OutboxRow = row()): Promise<{ params: AccountSuspendedParams; html: string; text: string }> {
  await handleNotifyOrgSuspendedRow(r, ctx());
  expect(mockSend).toHaveBeenCalledTimes(1);
  const params = mockSend.mock.calls[0][0] as AccountSuspendedParams;
  const { html, text } = buildAccountSuspendedEmail(params);
  return { params, html, text };
}

function payHref(html: string): string | null {
  const m = html.match(/<a href="([^"]*)"[^>]*data-pay-overdue-invoice="true"/);
  return m ? m[1] : null;
}

beforeEach(() => {
  jest.clearAllMocks();
  frozen = NEWEST_DUE + 1;
  stripe.customers.retrieve.mockImplementation(async () => fx('customer'));
  stripe.testHelpers.testClocks.retrieve.mockImplementation(async () => ({ ...fx('clock'), frozen_time: frozen })); // [EDITED] frozen_time
  stripe.invoices.list.mockImplementation(async () => fx('inv-list-open'));
  mockSend.mockImplementation(async () => ({ success: true, outcome: 'sent' }));
});

describe('C-E1 (W4, RC2, RC5): the button opens the OLDEST OVERDUE invoice, on the customer clock', () => {
  it('all five overdue: href names the oldest, whose due date is before now; Stripe lists it last', async () => {
    given('non_payment');
    const list = fx('inv-list-open');
    expect(list.data[0].id).toBe(NEWEST); // newest first: data[0] is the wrong invoice
    const { params, html, text } = await sent();
    const href = payHref(html);
    expect(href).toBe(`https://invoice.stripe.test/REDACTED/${OLDEST}`);
    const chosen = list.data.find((i: Obj) => href?.endsWith(i.id));
    expect(chosen.due_date).toBeLessThan(frozen);
    expect(html).toContain('Pay overdue invoice');
    expect(text).toContain(`Pay overdue invoice: https://invoice.stripe.test/REDACTED/${OLDEST}`);
    expect(params.payment).toEqual({ kind: 'invoice', url: `https://invoice.stripe.test/REDACTED/${OLDEST}`, overdueCount: 5 });
    expect(stripe.invoices.list).toHaveBeenCalledWith({ customer: CUSTOMER, status: 'open', limit: 100 });
    expect(stripe.testHelpers.testClocks.retrieve).toHaveBeenCalledWith(fx('customer').test_clock);
  });

  it('only the oldest overdue: count 1', async () => {
    frozen = OLDEST_DUE + 1;
    given('non_payment');
    const { params } = await sent();
    expect(params.payment).toEqual({ kind: 'invoice', url: `https://invoice.stripe.test/REDACTED/${OLDEST}`, overdueCount: 1 });
  });

  it('none overdue yet (clock at its start): falls back to the oldest open invoice, count 0', async () => {
    frozen = CLOCK_START;
    given('non_payment');
    const { params } = await sent();
    expect(params.payment).toEqual({ kind: 'invoice', url: `https://invoice.stripe.test/REDACTED/${OLDEST}`, overdueCount: 0 });
  });
});

describe('C-RC3: the access sentence when more than one invoice is past due', () => {
  it('5 overdue: "5 invoices are past due; access returns once all are paid. The button opens the oldest."', async () => {
    given('non_payment');
    const { html, text } = await sent();
    for (const body of [html, text]) {
      expect(body).toContain('5 invoices are past due; access returns once all are paid. The button opens the oldest.');
      expect(body).not.toContain('Access returns on its own shortly after the payment clears.');
    }
  });

  it('1 overdue: the plain sentence', async () => {
    frozen = OLDEST_DUE + 1;
    given('non_payment');
    const { text } = await sent();
    expect(text).toContain('Access returns on its own shortly after the payment clears.');
    expect(text).not.toContain('invoices are past due');
  });
});

describe('C-E3 (W6): an Other suspension has no button and makes no Stripe call', () => {
  it('reason other', async () => {
    given('other');
    const { html, text } = await sent();
    expect(stripe.invoices.list).not.toHaveBeenCalled();
    expect(stripe.customers.retrieve).not.toHaveBeenCalled();
    expect(payHref(html)).toBeNull();
    expect(html).not.toContain('Pay overdue invoice');
    expect(text).not.toContain('Pay overdue invoice');
    expect(text).toContain('Please contact your Keepr account manager to restore access.');
  });
});

describe('C-E4 (W7): the founder wording', () => {
  it.each(['non_payment', 'other'] as const)('%s: the members sentence, not the old one', async (reason) => {
    given(reason);
    const { html, text } = await sent();
    expect(text).toContain(MEMBERS);
    expect(html).toContain(MEMBERS.replace(/'/g, '&#039;'));
    expect(text).not.toContain('members cannot use Keepr');
  });
});

describe('C-RC4: non-payment with nothing to pay is alerted and worded for the account manager', () => {
  it('no open invoice', async () => {
    stripe.invoices.list.mockImplementation(async () => ({ ...fx('inv-list-open'), data: [] }));
    given('non_payment');
    const { params, html, text } = await sent();
    expect(params.payment).toEqual({ kind: 'none' });
    expect(payHref(html)).toBeNull();
    expect(text).toContain('Please contact your Keepr account manager about the overdue invoice to restore access.');
    expect(text).not.toContain('invoice email from Stripe');
    expect(mockAlert).toHaveBeenCalledWith('brokerage_suspended_no_invoice', 'test', expect.objectContaining({ cause: 'no_open_invoice' }));
  });

  it.each([
    ['no org_billing_stripe row', { noRow: true }],
    ['no customer on the row', { customer: null }],
  ])('%s: no Stripe call, account-manager wording, alert', async (_n, opts) => {
    given('non_payment', opts);
    const { params } = await sent();
    expect(params.payment).toEqual({ kind: 'none' });
    expect(stripe.invoices.list).not.toHaveBeenCalled();
    expect(mockAlert).toHaveBeenCalledWith('brokerage_suspended_no_invoice', 'test', expect.objectContaining({ cause: 'no_customer' }));
  });
});

describe('C-E2 (W5) and RC6: a Stripe failure retries, but never ends with no email', () => {
  const FAIL = Object.assign(new Error('fixture: api_connection_error'), { type: 'StripeConnectionError' });

  it('first try, list rejects -> throws (row retries), nothing sent, no alert', async () => {
    stripe.invoices.list.mockRejectedValue(FAIL);
    given('non_payment');
    await expect(handleNotifyOrgSuspendedRow(row({ attempts: 1 }), ctx())).rejects.toBe(FAIL);
    expect(mockSend).not.toHaveBeenCalled();
    expect(mockAlert).not.toHaveBeenCalled();
  });

  it('try 7 of 8 still throws', async () => {
    stripe.invoices.list.mockRejectedValue(FAIL);
    given('non_payment');
    await expect(handleNotifyOrgSuspendedRow(row({ attempts: 7 }), ctx())).rejects.toBe(FAIL);
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('last try (attempts 8) -> sent without the button, pay-from-Stripe wording, alert', async () => {
    stripe.invoices.list.mockRejectedValue(FAIL);
    given('non_payment');
    const { params, html, text } = await sent(row({ attempts: 8 }));
    expect(params.payment).toEqual({ kind: 'stripe_email' });
    expect(payHref(html)).toBeNull();
    expect(text).toContain('pay the overdue invoice from the link in the invoice email from Stripe');
    expect(mockAlert).toHaveBeenCalledWith(
      'brokerage_suspended_invoice_lookup_failed',
      'test',
      expect.objectContaining({ cause: 'last_try', attempts: 8 })
    );
  });

  it('the Stripe customer is gone (resource_missing) on the first try -> sent without the button, alert', async () => {
    stripe.customers.retrieve.mockRejectedValue(Object.assign(new Error('No such customer'), { code: 'resource_missing', statusCode: 404 }));
    given('non_payment');
    const { params } = await sent(row({ attempts: 1 }));
    expect(params.payment).toEqual({ kind: 'stripe_email' });
    expect(mockAlert).toHaveBeenCalledWith(
      'brokerage_suspended_invoice_lookup_failed',
      'test',
      expect.objectContaining({ cause: 'resource_missing' })
    );
  });

  it('deadline already passed -> plain retryable error before any Stripe call', async () => {
    given('non_payment');
    await expect(
      handleNotifyOrgSuspendedRow(row(), { ...ctx(), deadline: new Date(Date.now() - 1) })
    ).rejects.toThrow('outbox deadline reached');
    expect(stripe.customers.retrieve).not.toHaveBeenCalled();
    expect(mockSend).not.toHaveBeenCalled();
  });
});
