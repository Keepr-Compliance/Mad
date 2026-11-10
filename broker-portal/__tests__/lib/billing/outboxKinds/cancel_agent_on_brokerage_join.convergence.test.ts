/**
 * @jest-environment node
 *
 * BACKLOG-3850 — billing_outbox kind `cancel_agent_on_brokerage_join` (lib/billing/joinCancel.ts).
 * Plan pm_comments d443fb5b; SR 989c8798 (R3-R6, R8); founder dd904bb8 + 35b3b3ab; rulings 89ef80a7.
 *
 * Row shape: the producer is the database (migration 20261111130000,
 * _billing_enqueue_agent_cancel_on_join), measured on keepr-test by supabase/tests/backlog-3850
 * control S1: organization_id NULL, dedupe_key 'join-cancel:<mode>:<user>:<clock µs>', payload
 * {brokerage_organization_id, member_id, stripe_customer_id}.
 *
 * Stripe objects: __tests__/fixtures/stripe/p3848 (TEST captures, see its README):
 *   - pr2-sub-past_due / pr2-inv-open: a past_due Agent plan and its open renewal (one customer);
 *   - pr2-inv-paid: the same invoice paid; pr2-void-paid-refused: the void refused on it;
 *   - SR-VOID-inv-voided + SR-VOID-sub-canceled: the TEST trace of voidInvoice on a past_due
 *     renewal followed by subscriptions.cancel(id, {prorate: false, invoice_now: false}) ->
 *     'canceled' [COMPOSED: served under this file's invoice / subscription ids];
 *   - pr2-cs-setup-open: an open Checkout session of the same customer.
 * Edits are marked [EDITED]; composed objects [COMPOSED].
 */

import fs from 'fs';
import path from 'path';
import { BillingDb, type Row } from '../../../helpers/billingDb';
import { clone, createStripeStub, stripeError, type StripeStub } from '../../../helpers/stripeStub';

const mockCapture = jest.fn();
const mockSend = jest.fn();
jest.mock('@sentry/nextjs', () => ({ captureMessage: (...a: unknown[]) => mockCapture(...a), captureException: jest.fn() }));
jest.mock('@/lib/email', () => ({ sendAgentPlanEndedEmail: (...a: unknown[]) => mockSend(...a) }));

import { handleJoinCancelRow, AGENT_PLAN_ENDED_LOG_KIND } from '@/lib/billing/joinCancel';
import { NonRetryableOutboxError, outboxIdempotencyKey, type OutboxRow } from '@/lib/billing/outboxKinds';
import { agentPlanEndedLines, buildAgentPlanEndedEmail, AGENT_PLAN_ENDED_SUBJECT } from '@/lib/email/templates/agent-plan-ended';

type Obj = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const FX = path.join(__dirname, '../../../fixtures/stripe/p3848');
const fx = (n: string): Obj => JSON.parse(fs.readFileSync(path.join(FX, `${n}.json`), 'utf8'));
const list = (data: Obj[]) => ({ object: 'list', data, has_more: false, url: '/v1/x' });

const SUB = fx('pr2-sub-past_due');
const OPEN = fx('pr2-inv-open');
const PAID = fx('pr2-inv-paid');
const VOID_REFUSED = fx('pr2-void-paid-refused');
const SESSION = fx('pr2-cs-setup-open');
const CUS: string = SUB.customer;
const VOIDED = { ...fx('SR-VOID-inv-voided'), id: OPEN.id, subscription: SUB.id, customer: CUS }; // [COMPOSED]
const CANCELED_TRACE = fx('SR-VOID-sub-canceled');

const USER = 'USER-3850-JOIN';
const PERSONAL = 'ORG-3850-PERSONAL';
const BRK = 'ORG-3850-BRK';
const MEMBER = 'om-3850-brk';
const QUEUED_AT = '2026-01-01T00:00:00.000Z'; // before any wall-clock cancel in this file
const QUEUED_SEC = Date.parse(QUEUED_AT) / 1000;

function row(over: Partial<OutboxRow> = {}): OutboxRow {
  return {
    id: 'outbox-join-3850-a1',
    stripe_mode: 'test',
    kind: 'cancel_agent_on_brokerage_join',
    user_id: USER,
    organization_id: null,
    dedupe_key: `join-cancel:test:${USER}:1794852000000000`,
    run_after: QUEUED_AT,
    payload: { brokerage_organization_id: BRK, member_id: MEMBER, stripe_customer_id: CUS },
    attempts: 1,
    last_error: null,
    claimed_until: null,
    created_at: QUEUED_AT,
    processed_at: null,
    ...over,
  };
}

let db: BillingDb;
let stripe: StripeStub;
let subs: Obj[];
let invoices: Obj[];
let sessions: Obj[];
let customer: Obj;
const mockGetUser = jest.fn();

/** [COMPOSED] the SR-VOID cancel trace served for one subscription, canceled now. */
function canceledNow(sub: Obj): Obj {
  return { ...clone(CANCELED_TRACE), id: sub.id, customer: sub.customer, metadata: sub.metadata, canceled_at: Math.floor(Date.now() / 1000) };
}

function seed(memberStatus = 'active', extra: Record<string, Row[]> = {}): void {
  db = new BillingDb({
    organizations: [
      { id: PERSONAL, name: 'Personal', personal_owner_user_id: USER, is_test: true },
      { id: BRK, name: 'Brokerage 3850', personal_owner_user_id: null, is_test: true },
    ],
    organization_members: [{ id: MEMBER, user_id: USER, organization_id: BRK, license_status: memberStatus, role: 'agent' }],
    stripe_customers: [{ user_id: USER, stripe_customer_id: CUS, default_payment_method_id: null, stripe_mode: 'test' }],
    billing_subscriptions: [{ id: 'bs-1', user_id: USER, stripe_mode: 'test', stripe_subscription_id: SUB.id, status: 'past_due' }],
    org_billing_stripe: [],
    email_delivery_log: [],
    ...extra,
  });
}

function ctx(deadlineMs = 60_000) {
  return {
    stripe: stripe.client,
    service: { from: db.from, auth: { admin: { getUserById: mockGetUser } } } as never,
    mode: 'test' as const,
    deadline: new Date(Date.now() + deadlineMs),
  };
}
const sends = () => mockSend.mock.calls.map((c) => c[0] as Obj);
const alerts = (name: string) => mockCapture.mock.calls.filter((c) => c[0] === `billing alert: ${name}`).map((c) => c[1].extra);
const MUTATING = ['checkout.sessions.expire', 'invoices.voidInvoice', 'subscriptions.cancel', 'subscriptions.update'];

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(console, 'info').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
  expect([SUB.status, SUB.metadata?.kind, OPEN.status, OPEN.subscription]).toEqual(['past_due', 'agent', 'open', SUB.id]);
  expect([SESSION.status, SESSION.customer]).toEqual(['open', CUS]);
  seed();
  subs = [clone(SUB)];
  invoices = [clone(OPEN)];
  sessions = [clone(SESSION)];
  customer = { id: CUS, object: 'customer', email: 'billing-3850@example.test' };
  mockGetUser.mockResolvedValue({ data: { user: { email: 'signin-3850@example.test' } } });
  stripe = createStripeStub({
    'checkout.sessions.list': () => list(sessions.filter((s) => s.status === 'open')),
    'checkout.sessions.expire': (id: string) => {
      sessions = sessions.map((s) => (s.id === id ? { ...s, status: 'expired' } : s));
      return sessions.find((s) => s.id === id);
    },
    'checkout.sessions.retrieve': (id: string) => sessions.find((s) => s.id === id),
    'subscriptions.list': () => list(subs),
    'invoices.list': (p: Obj) => list(invoices.filter((i) => i.subscription === p.subscription && i.status === p.status)),
    'invoices.voidInvoice': (id: string) => {
      invoices = invoices.map((i) => (i.id === id ? { ...VOIDED, id, subscription: i.subscription } : i));
      return invoices.find((i) => i.id === id);
    },
    'invoices.retrieve': (id: string) => invoices.find((i) => i.id === id),
    'subscriptions.cancel': (id: string) => {
      const ended = canceledNow(subs.find((s) => s.id === id) as Obj);
      subs = subs.map((s) => (s.id === id ? ended : s));
      return ended;
    },
    'customers.retrieve': () => customer,
  });
  mockSend.mockImplementation(async (p: Obj) => {
    db.rows('email_delivery_log').push({ status: 'sent', metadata: { kind: AGENT_PLAN_ENDED_LOG_KIND, outboxKey: p.outboxKey } });
    return { success: true, outcome: 'sent' };
  });
});

afterEach(() => jest.restoreAllMocks());

describe('cancel_agent_on_brokerage_join', () => {
  it('C1: expire Checkout, void the open renewal, cancel now (prorate false, invoice_now false), re-check, one email', async () => {
    await handleJoinCancelRow(row(), ctx());
    expect(stripe.ops()).toEqual([
      'checkout.sessions.list',
      'checkout.sessions.expire',
      'subscriptions.list',
      'invoices.list',
      'invoices.voidInvoice',
      'subscriptions.cancel',
      'invoices.list',
      'customers.retrieve',
    ]);
    expect(stripe.callsTo('checkout.sessions.list')[0][0]).toMatchObject({ customer: CUS, status: 'open' });
    expect(stripe.callsTo('subscriptions.list')[0][0]).toMatchObject({ customer: CUS, status: 'all' });
    expect(stripe.callsTo('invoices.voidInvoice')).toEqual([[OPEN.id, {}, { idempotencyKey: outboxIdempotencyKey(row(), `void:${OPEN.id}`) }]]);
    expect(stripe.callsTo('subscriptions.cancel')).toEqual([
      [SUB.id, { prorate: false, invoice_now: false }, { idempotencyKey: outboxIdempotencyKey(row(), `cancel:${SUB.id}`) }],
    ]);
    // Never cancel_at_period_end, never a refund or credit note (the stub has no such call at all).
    expect(stripe.callsTo('subscriptions.update')).toEqual([]);
    expect(JSON.stringify(stripe.calls)).not.toContain('cancel_at_period_end');
    // Mirror write-through (this user, this mode, this subscription).
    expect(db.rows('billing_subscriptions')[0]).toMatchObject({ status: 'canceled', cancel_at_period_end: false, paused: false });
    expect(sends()).toEqual([
      { recipientEmail: 'billing-3850@example.test', brokerageName: 'Brokerage 3850', licensed: true, outboxKey: row().dedupe_key, userId: USER },
    ]);
  });

  it('C4: converges: a second run voids, cancels and sends nothing more', async () => {
    await handleJoinCancelRow(row(), ctx());
    const before = stripe.calls.length;
    await handleJoinCancelRow({ ...row(), attempts: 2 }, ctx());
    const second = stripe.ops().slice(before);
    expect(second.filter((op) => MUTATING.includes(op))).toEqual([]);
    expect(stripe.callsTo('subscriptions.cancel')).toHaveLength(1);
    expect(sends()).toHaveLength(1);
  });

  it('C13a: cancel then the send fails -> retry sends ONE email and cancels nothing again', async () => {
    mockSend.mockResolvedValueOnce({ success: false, outcome: 'failed' });
    await expect(handleJoinCancelRow(row(), ctx())).rejects.toThrow('email send failed');
    expect(stripe.callsTo('subscriptions.cancel')).toHaveLength(1);
    await handleJoinCancelRow({ ...row(), attempts: 2 }, ctx());
    expect(stripe.callsTo('subscriptions.cancel')).toHaveLength(1);
    expect(sends()).toHaveLength(2); // the failed attempt + the one that went out
    expect(db.rows('email_delivery_log')).toHaveLength(1);
  });

  it('C13b: two Agent plans -> both cancelled, ONE email', async () => {
    const second = { ...clone(SUB), id: 'sub_composed_second' }; // [COMPOSED]
    subs = [clone(SUB), second];
    await handleJoinCancelRow(row(), ctx());
    expect(stripe.callsTo('subscriptions.cancel').map((c) => c[0])).toEqual([SUB.id, second.id]);
    expect(sends()).toHaveLength(1);
  });

  it('C3 / C13c: every Agent plan already closed before the join -> 0 cancels, 0 voids, 0 emails', async () => {
    subs = [{ ...canceledNow(SUB), canceled_at: QUEUED_SEC - 3600 }];
    await handleJoinCancelRow(row(), ctx());
    expect(stripe.ops().filter((op) => MUTATING.includes(op) && op !== 'checkout.sessions.expire')).toEqual([]);
    expect(sends()).toEqual([]);
  });

  it('C5: a brokerage-kind subscription on the same customer is not touched [COMPOSED: kind brokerage]', async () => {
    subs = [{ ...clone(SUB), id: 'sub_composed_brk', metadata: { kind: 'brokerage' } }];
    await handleJoinCancelRow(row(), ctx());
    expect(stripe.callsTo('subscriptions.cancel')).toEqual([]);
    expect(stripe.callsTo('invoices.voidInvoice')).toEqual([]);
    expect(sends()).toEqual([]);
  });

  it.each([
    ['member deactivated (suspended)', () => seed('suspended')],
    ['member deactivated (expired)', () => seed('expired')],
    ['member row gone', () => seed('active', { organization_members: [] })],
    ['member row now at another org', () => seed('active', { organization_members: [{ id: MEMBER, user_id: USER, organization_id: 'ORG-OTHER', license_status: 'active' }] })],
    ['reverted: a personal membership again', () =>
      seed('active', {
        organization_members: [
          { id: MEMBER, user_id: USER, organization_id: BRK, license_status: 'active' },
          { id: 'om-personal', user_id: USER, organization_id: PERSONAL, license_status: 'active' },
        ],
      })],
    ['the organization is a personal one', () =>
      seed('active', { organizations: [{ id: BRK, name: 'x', personal_owner_user_id: 'U-OTHER', is_test: true }] })],
  ])('C6: superseded (%s) -> ZERO Stripe calls', async (_l, setup) => {
    setup();
    await handleJoinCancelRow(row(), ctx());
    expect(stripe.calls).toEqual([]);
    expect(sends()).toEqual([]);
  });

  it('F3: payload customer is not the user\'s current one -> NonRetryable not_owner, ZERO Stripe calls', async () => {
    seed('active', { stripe_customers: [{ user_id: USER, stripe_customer_id: 'cus_other', default_payment_method_id: null, stripe_mode: 'test' }] });
    const err = await handleJoinCancelRow(row(), ctx()).catch((e) => e);
    expect(err).toBeInstanceOf(NonRetryableOutboxError);
    expect(err.code).toBe('not_owner');
    expect(stripe.calls).toEqual([]);
  });

  it('F3: no stripe_customers row in this mode any more -> not_owner, ZERO Stripe calls', async () => {
    seed('active', { stripe_customers: [] });
    await expect(handleJoinCancelRow(row(), ctx())).rejects.toMatchObject({ code: 'not_owner' });
    expect(stripe.calls).toEqual([]);
  });

  it('R4: the customer is a brokerage\'s own (org_billing_stripe) -> brokerage_customer, ZERO Stripe calls', async () => {
    seed('active', { org_billing_stripe: [{ organization_id: BRK, stripe_customer_id: CUS, stripe_mode: 'test' }] });
    await expect(handleJoinCancelRow(row(), ctx())).rejects.toMatchObject({ code: 'brokerage_customer' });
    expect(stripe.calls).toEqual([]);
  });

  it('C7 / R3: a plan created AFTER the row was queued is cancelled too (no created filter)', async () => {
    subs = [{ ...clone(SUB), created: QUEUED_SEC + 600 }];
    await handleJoinCancelRow(row(), ctx());
    expect(stripe.callsTo('subscriptions.cancel').map((c) => c[0])).toEqual([SUB.id]);
  });

  it('R8: mirror says canceled, Stripe says past_due -> cancelled (Stripe decides)', async () => {
    db.rows('billing_subscriptions')[0].status = 'canceled';
    await handleJoinCancelRow(row(), ctx());
    expect(stripe.callsTo('subscriptions.cancel')).toHaveLength(1);
  });

  it('R8: mirror says past_due, Stripe says canceled (before the join) -> no cancel call', async () => {
    subs = [{ ...canceledNow(SUB), canceled_at: QUEUED_SEC - 60 }];
    await handleJoinCancelRow(row(), ctx());
    expect(stripe.callsTo('subscriptions.cancel')).toEqual([]);
    expect(sends()).toEqual([]);
  });

  it('Q2 / R5: the renewal was paid before the void -> alert paid_at_brokerage_join, plan still ended, no refund', async () => {
    stripe.impl['invoices.voidInvoice'] = () => {
      invoices = [clone(PAID)];
      throw stripeError(VOID_REFUSED as { error: { message?: string } });
    };
    await handleJoinCancelRow(row(), ctx());
    expect(alerts('paid_at_brokerage_join')).toEqual([{ subscription_id: SUB.id, invoice_id: OPEN.id, outbox_id: row().id }]);
    expect(stripe.callsTo('subscriptions.cancel')).toHaveLength(1);
    expect(sends()).toHaveLength(1);
  });

  it('R5: a void refused while the invoice is still open -> throws (retried), nothing cancelled', async () => {
    stripe.impl['invoices.voidInvoice'] = () => {
      throw stripeError({ error: { type: 'api_error', message: 'temporary' } });
    };
    await expect(handleJoinCancelRow(row(), ctx())).rejects.toThrow('temporary');
    expect(stripe.callsTo('subscriptions.cancel')).toEqual([]);
  });

  it('R5: an open invoice that appears after the cancel is voided in the second pass', async () => {
    const late = { ...clone(OPEN), id: 'in_composed_late' }; // [COMPOSED]
    const cancel = stripe.impl['subscriptions.cancel'];
    stripe.impl['subscriptions.cancel'] = (id: string) => {
      invoices.push(clone(late));
      return cancel(id);
    };
    await handleJoinCancelRow(row(), ctx());
    expect(stripe.callsTo('invoices.voidInvoice').map((c) => c[0])).toEqual([OPEN.id, late.id]);
  });

  it('F2: a paused Agent plan is cancelled too', async () => {
    subs = [{ ...clone(SUB), status: 'active', pause_collection: { behavior: 'void', resumes_at: null } }]; // [EDITED] paused
    invoices = [];
    await handleJoinCancelRow(row(), ctx());
    expect(stripe.callsTo('subscriptions.cancel').map((c) => c[0])).toEqual([SUB.id]);
  });

  it('incomplete: only its open invoice is voided (that ends it); no cancel, no email', async () => {
    subs = [{ ...clone(SUB), status: 'incomplete' }]; // [EDITED]
    await handleJoinCancelRow(row(), ctx());
    expect(stripe.callsTo('invoices.voidInvoice').map((c) => c[0])).toEqual([OPEN.id]);
    expect(stripe.callsTo('subscriptions.cancel')).toEqual([]);
    expect(sends()).toEqual([]);
  });

  it('contract (e): past the deadline the first call runs, the next is refused (retried), nothing cancelled', async () => {
    await expect(handleJoinCancelRow(row(), ctx(-1))).rejects.toThrow('outbox deadline reached');
    expect(stripe.ops()).toEqual(['checkout.sessions.list']);
  });

  it('bad payload -> NonRetryable bad_payload', async () => {
    await expect(handleJoinCancelRow(row({ payload: { brokerage_organization_id: BRK, member_id: MEMBER } }), ctx())).rejects.toMatchObject({
      code: 'bad_payload',
    });
    expect(stripe.calls).toEqual([]);
  });

  it('email not configured -> NonRetryable email_not_configured (after the cancel)', async () => {
    mockSend.mockResolvedValueOnce({ success: false, outcome: 'skipped' });
    await expect(handleJoinCancelRow(row(), ctx())).rejects.toMatchObject({ code: 'email_not_configured' });
    expect(stripe.callsTo('subscriptions.cancel')).toHaveLength(1);
  });

  it('recipient: no billing contact email on the customer -> the sign-in email', async () => {
    customer = { id: CUS, object: 'customer', email: null };
    await handleJoinCancelRow(row(), ctx());
    expect(mockGetUser).toHaveBeenCalledWith(USER);
    expect(sends()[0].recipientEmail).toBe('signin-3850@example.test');
  });
});

describe('F6 / 35b3b3ab: each license_status gets its own copy', () => {
  it.each([
    ['active', true],
    ['unassigned', false],
    ['pending', false],
  ])('license_status %s at run time -> licensed=%s', async (status, licensed) => {
    seed(status);
    await handleJoinCancelRow(row(), ctx());
    expect(sends().map((s) => s.licensed)).toEqual([licensed]);
  });

  it('licensed copy: the approved Q1 text', () => {
    expect(agentPlanEndedLines({ brokerageName: 'Acme Realty', licensed: true })).toEqual([
      "You've joined Acme Realty on Keepr, so your brokerage now covers your account.",
      "We've ended your personal Agent plan today, and you won't be charged for it again. Your transactions and credits stay with you.",
      'Questions? Reply to this email.',
    ]);
  });

  it('unlicensed copy: the covers clause replaced, the rest unchanged', () => {
    const lines = agentPlanEndedLines({ brokerageName: 'Acme Realty', licensed: false });
    expect(lines[0]).toBe("You've joined Acme Realty on Keepr. Once Acme Realty assigns you a license, you can use Keepr through them.");
    expect(lines.join(' ')).not.toContain('covers your account');
    expect(lines.slice(1)).toEqual(agentPlanEndedLines({ brokerageName: 'Acme Realty', licensed: true }).slice(1));
  });

  it('built email: subject, both bodies, escaped brokerage name', () => {
    const lic = buildAgentPlanEndedEmail({ recipientEmail: 'a@example.test', brokerageName: 'A & B <Realty>', licensed: true, outboxKey: 'k', userId: 'u' });
    const unl = buildAgentPlanEndedEmail({ recipientEmail: 'a@example.test', brokerageName: 'A & B <Realty>', licensed: false, outboxKey: 'k', userId: 'u' });
    expect([lic.subject, unl.subject]).toEqual([AGENT_PLAN_ENDED_SUBJECT, AGENT_PLAN_ENDED_SUBJECT]);
    expect(AGENT_PLAN_ENDED_SUBJECT).toBe('Your Keepr Agent plan has ended');
    expect(lic.text).toContain('covers your account');
    expect(unl.text).toContain('assigns you a license');
    expect(unl.text).not.toContain('covers your account');
    expect(lic.html).toContain('A &amp; B &lt;Realty&gt;');
    expect(lic.html).not.toContain('<Realty>');
  });
});
