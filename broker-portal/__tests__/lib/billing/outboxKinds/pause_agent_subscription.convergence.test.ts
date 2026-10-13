/**
 * @jest-environment node
 *
 * BACKLOG-3878 PR-2 — billing_outbox kind `pause_agent_subscription` (C5, SR R6, R8).
 *
 * Founder Q2 (2026-10-13): forgive (void) every open Agent bill FIRST, then
 * pause with behavior `void`. Measured in Stripe TEST (step 0 X1): a pause
 * alone let the smart retry charge the open renewal while suspended.
 *
 * Objects: fixtures/stripe/p3878 (TEST, transcribed; see README).
 *   - x1-sub-past-due-before-pause + x1-renewal-open: the state at suspension.
 *   - x2-sub-after-void-and-pause: a subscription after the same two steps
 *     (what the second run reads [COMPOSED: the x2 subscription stands for x1
 *     after the handler; x1 has no after-void re-fetch]).
 *   - y1-renewal-voided-by-pause [EDITED: status 'draft', the state it had
 *     when the pause was set] for "drafts are left alone".
 *   - x1-renewal-paid-while-paused: the renewal Stripe's retry paid while paused (R8).
 *   - x4-checkout-sessions-list-open / x4-checkout-session-expired: an open
 *     subscription Checkout of the x4 customer [COMPOSED: served for the x1 customer].
 *   - x3-sub-canceled-cape-paused: a canceled subscription.
 * The Stripe stub filters invoices.list by the `status` argument the way the
 * API does, so a call without the filter sees the draft too.
 */

import fs from 'fs';
import path from 'path';
import { BillingDb } from '../../../helpers/billingDb';
import { clone, createStripeStub, stripeError, type StripeStub } from '../../../helpers/stripeStub';

const mockCapture = jest.fn();
jest.mock('@sentry/nextjs', () => ({ captureMessage: (...a: unknown[]) => mockCapture(...a), captureException: jest.fn() }));

import { handlePauseRow } from '@/lib/billing/suspension';
import { outboxIdempotencyKey, type OutboxRow } from '@/lib/billing/outboxKinds';

type Obj = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const FX = path.join(__dirname, '../../../fixtures/stripe/p3878');
const fx = (n: string): Obj => JSON.parse(fs.readFileSync(path.join(FX, `${n}.json`), 'utf8'));

const SUB = fx('x1-sub-past-due-before-pause');
const OPEN = fx('x1-renewal-open');
const AFTER = fx('x2-sub-after-void-and-pause');
const DRAFT = { ...fx('y1-renewal-voided-by-pause'), status: 'draft' }; // [EDITED] see header
const PAID_WHILE_PAUSED = fx('x1-renewal-paid-while-paused');
const SESSIONS = fx('x4-checkout-sessions-list-open');
const EXPIRED = fx('x4-checkout-session-expired');
const CANCELED = fx('x3-sub-canceled-cape-paused');
const USER = 'USER-3878-PAUSE';
const CUS = SUB.customer as string;

const list = (data: Obj[], url = '/v1/x') => ({ object: 'list', data, has_more: false, url });

const row: OutboxRow = {
  id: 'outbox-pause-3878-a1',
  stripe_mode: 'test',
  kind: 'pause_agent_subscription',
  user_id: USER,
  organization_id: null,
  dedupe_key: `pause:test:${USER}:1`,
  run_after: '2026-10-13T00:00:00Z',
  payload: {},
  attempts: 0,
  last_error: null,
  claimed_until: null,
  // The suspension moment: before the renewal was paid by the retry in x1.
  created_at: new Date((PAID_WHILE_PAUSED.status_transitions.paid_at - 3600) * 1000).toISOString(),
  processed_at: null,
};

let db: BillingDb;
let stripe: StripeStub;
let subs: Obj[];
let invoices: Obj[];
let sessions: Obj[];

function ctx(deadlineMs = 60_000) {
  return { stripe: stripe.client, service: { from: db.from } as never, mode: 'test' as const, deadline: new Date(Date.now() + deadlineMs) };
}
const alerts = () => mockCapture.mock.calls.filter((c) => c[0] === 'billing alert: paid_while_suspended').map((c) => c[1].extra);

beforeEach(() => {
  jest.clearAllMocks();
  expect([SUB.status, SUB.pause_collection, SUB.latest_invoice]).toEqual(['past_due', null, OPEN.id]);
  expect([OPEN.status, OPEN.subscription, OPEN.attempt_count]).toEqual(['open', SUB.id, 1]);
  db = new BillingDb({
    licenses: [{ user_id: USER, status: 'suspended' }],
    stripe_customers: [{ user_id: USER, stripe_customer_id: CUS, default_payment_method_id: null, stripe_mode: 'test' }],
  });
  subs = [SUB];
  invoices = [OPEN, DRAFT];
  sessions = clone(SESSIONS.data);
  stripe = createStripeStub({
    'checkout.sessions.list': () => list(sessions.filter((s) => s.status === 'open')),
    'checkout.sessions.expire': (id: string) => {
      sessions = sessions.map((s) => (s.id === id ? { ...s, status: 'expired' } : s));
      return { ...EXPIRED, id };
    },
    'checkout.sessions.retrieve': (id: string) => sessions.find((s) => s.id === id),
    'subscriptions.list': () => list(subs),
    'invoices.list': (p: Obj) =>
      list(invoices.filter((i) => i.subscription === p.subscription && (p.status === undefined || i.status === p.status))),
    'invoices.voidInvoice': (id: string) => {
      invoices = invoices.map((i) => (i.id === id ? { ...i, status: 'void' } : i));
      return invoices.find((i) => i.id === id);
    },
    'invoices.retrieve': (id: string) => invoices.find((i) => i.id === id),
    'subscriptions.update': (id: string) => {
      subs = [AFTER];
      return { ...AFTER, id };
    },
  });
});

describe('pause_agent_subscription handler', () => {
  it('C5: expires open Checkout, voids the open renewal, THEN pauses with behavior void (keys per row)', async () => {
    expect(sessions.filter((s) => s.status === 'open')).toHaveLength(1);
    await handlePauseRow(row, ctx());
    expect(stripe.ops()).toEqual([
      'checkout.sessions.list',
      'checkout.sessions.expire',
      'subscriptions.list',
      'invoices.list',
      'invoices.voidInvoice',
      'invoices.list',
      'subscriptions.update',
    ]);
    expect(stripe.callsTo('checkout.sessions.list')[0][0]).toMatchObject({ customer: CUS, status: 'open' });
    expect(stripe.callsTo('subscriptions.list')[0][0]).toMatchObject({ customer: CUS, status: 'all' });
    expect(stripe.callsTo('invoices.voidInvoice')).toEqual([[OPEN.id, {}, { idempotencyKey: outboxIdempotencyKey(row, `void:${OPEN.id}`) }]]);
    expect(stripe.callsTo('subscriptions.update')).toEqual([
      [SUB.id, { pause_collection: { behavior: 'void' } }, { idempotencyKey: outboxIdempotencyKey(row, `pause:${SUB.id}`) }],
    ]);
  });

  it('converges: a second run voids, expires and pauses nothing more', async () => {
    await handlePauseRow(row, ctx());
    const before = stripe.calls.length;
    await handlePauseRow({ ...row, attempts: 1 }, ctx());
    const second = stripe.ops().slice(before);
    expect(second).not.toContain('invoices.voidInvoice');
    expect(second).not.toContain('subscriptions.update');
    expect(second).not.toContain('checkout.sessions.expire');
  });

  it('drafts are left alone: only invoices listed as open are voided (Y1)', async () => {
    await handlePauseRow(row, ctx());
    expect(stripe.callsTo('invoices.list')[0][0]).toMatchObject({ subscription: SUB.id, status: 'open' });
    expect(stripe.callsTo('invoices.voidInvoice').map((c) => c[0])).toEqual([OPEN.id]);
  });

  it('licence reinstated before the drain -> zero Stripe calls', async () => {
    db.rows('licenses')[0].status = 'active';
    await handlePauseRow(row, ctx());
    expect(stripe.calls).toEqual([]);
  });

  it('no stripe_customers row in this mode -> zero Stripe calls', async () => {
    db.rows('stripe_customers')[0].stripe_mode = 'live';
    await handlePauseRow(row, ctx());
    expect(stripe.calls).toEqual([]);
  });

  it('already paused (x2 after void + pause) -> no void, no update', async () => {
    subs = [AFTER];
    invoices = [];
    await handlePauseRow(row, ctx());
    expect(stripe.callsTo('invoices.voidInvoice')).toEqual([]);
    expect(stripe.callsTo('subscriptions.update')).toEqual([]);
  });

  it('a canceled subscription is skipped (no invoice read, no update)', async () => {
    subs = [CANCELED];
    await handlePauseRow(row, ctx());
    expect(stripe.callsTo('invoices.list')).toEqual([]);
    expect(stripe.callsTo('subscriptions.update')).toEqual([]);
  });

  it('a subscription of another kind is skipped [EDITED: metadata.kind brokerage]', async () => {
    subs = [{ ...SUB, metadata: { ...SUB.metadata, kind: 'brokerage' } }];
    await handlePauseRow(row, ctx());
    expect(stripe.callsTo('invoices.list')).toEqual([]);
    expect(stripe.callsTo('subscriptions.update')).toEqual([]);
  });

  it('R8: the renewal was paid after the suspension -> alert, no refund call, still paused', async () => {
    invoices = [PAID_WHILE_PAUSED];
    expect(PAID_WHILE_PAUSED.status).toBe('paid');
    await handlePauseRow(row, ctx());
    expect(alerts()).toEqual([expect.objectContaining({ subscription_id: SUB.id, invoice_id: PAID_WHILE_PAUSED.id, outbox_id: row.id })]);
    expect(stripe.callsTo('subscriptions.update')).toHaveLength(1);
  });

  it('R8: a paid invoice from before the suspension raises nothing', async () => {
    invoices = [PAID_WHILE_PAUSED];
    await handlePauseRow({ ...row, created_at: new Date((PAID_WHILE_PAUSED.status_transitions.paid_at + 1) * 1000).toISOString() }, ctx());
    expect(alerts()).toEqual([]);
  });

  it('R8: the void is refused because the renewal was paid meanwhile -> alert, pause still set', async () => {
    stripe.impl['invoices.voidInvoice'] = () => {
      invoices = [PAID_WHILE_PAUSED];
      throw stripeError({ error: { type: 'invalid_request_error', message: 'You can only pass in open invoices.' } });
    };
    await handlePauseRow(row, ctx());
    expect(alerts().map((a) => a.invoice_id)).toContain(OPEN.id);
    expect(stripe.callsTo('subscriptions.update')).toHaveLength(1);
  });

  it('a void refused while the invoice is still open -> throws (retried), no pause', async () => {
    stripe.impl['invoices.voidInvoice'] = () => {
      throw stripeError({ error: { type: 'api_error', message: 'boom' } });
    };
    await expect(handlePauseRow(row, ctx())).rejects.toThrow('boom');
    expect(stripe.callsTo('subscriptions.update')).toEqual([]);
  });

  it('R6: an expire refused for a session that is no longer open is fine; one still open throws', async () => {
    stripe.impl['checkout.sessions.expire'] = (id: string) => {
      sessions = sessions.map((s) => (s.id === id ? { ...s, status: 'complete' } : s));
      throw stripeError({ error: { type: 'invalid_request_error', message: 'not open' } });
    };
    await handlePauseRow(row, ctx());
    expect(stripe.callsTo('subscriptions.update')).toHaveLength(1);

    sessions = clone(SESSIONS.data);
    stripe.impl['checkout.sessions.expire'] = () => {
      throw stripeError({ error: { type: 'api_error', message: 'expire failed' } });
    };
    await expect(handlePauseRow(row, ctx())).rejects.toThrow('expire failed');
  });

  it('contract (e): past the deadline only the first Stripe call runs', async () => {
    await expect(handlePauseRow(row, ctx(-1))).rejects.toThrow('outbox deadline reached');
    expect(stripe.ops()).toEqual(['checkout.sessions.list']);
  });

  it('a row without a user is parked', async () => {
    await expect(handlePauseRow({ ...row, user_id: null }, ctx())).rejects.toMatchObject({ code: 'bad_payload' });
  });
});
