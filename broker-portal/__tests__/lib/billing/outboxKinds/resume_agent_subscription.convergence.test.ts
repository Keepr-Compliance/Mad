/**
 * @jest-environment node
 *
 * BACKLOG-3878 PR-2 — billing_outbox kind `resume_agent_subscription` (C6, SR R5).
 *
 * Objects: fixtures/stripe/p3878 (TEST, transcribed; see README).
 *   - x2-sub-after-void-and-pause + x2-renewal-voided: paused with the renewal
 *     voided -> the re-anchor charge (one new month from today).
 *   - x2-resume-sub: the same subscription after the resume (not paused) — what
 *     a second run reads; x2-resume-invoice-marker carries the spike's marker.
 *   - x4-sub-paused-inside-period + x4-latest-invoice-paid + x4-charge: paused
 *     inside a paid period (X4) -> un-pause only and repair the grant;
 *     x4-sub-after-unpause-only is the re-fetch after that update.
 *   - x4cape-*: the same with cancel_at_period_end [x4cape after the update is
 *     the x4cape re-fetch with pause_collection null — EDITED, the spike did
 *     not re-fetch it; it printed pause None after the update].
 *   - x3-sub-canceled-cape-paused: canceled (X3: Stripe refuses to update it).
 * "Now" is the X4 test clock's frozen time (period start + 3 days) unless a
 * test moves it.
 */

import fs from 'fs';
import path from 'path';
import { BillingDb } from '../../../helpers/billingDb';
import { createStripeStub, type StripeStub } from '../../../helpers/stripeStub';

jest.mock('@sentry/nextjs', () => ({ captureMessage: jest.fn(), captureException: jest.fn() }));

import { handleResumeRow } from '@/lib/billing/suspension';
import { outboxIdempotencyKey, type OutboxRow } from '@/lib/billing/outboxKinds';

type Obj = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const FX = path.join(__dirname, '../../../fixtures/stripe/p3878');
const fx = (n: string): Obj => JSON.parse(fs.readFileSync(path.join(FX, `${n}.json`), 'utf8'));

const X2_PAUSED = fx('x2-sub-after-void-and-pause');
const X2_VOIDED = fx('x2-renewal-voided');
const X2_RESUMED = fx('x2-resume-sub');
const X2_RESUME_INV = fx('x2-resume-invoice-marker');
const X4_PAUSED = fx('x4-sub-paused-inside-period');
const X4_AFTER = fx('x4-sub-after-unpause-only');
const X4_INV = fx('x4-latest-invoice-paid');
const X4_CHARGE = fx('x4-charge');
const CAPE_PAUSED = fx('x4cape-sub-paused-inside-period');
const CAPE_INV = fx('x4cape-latest-invoice-paid');
const CAPE_CHARGE = fx('x4cape-charge');
const CAPE_AFTER = { ...CAPE_PAUSED, pause_collection: null }; // [EDITED] see header
const CANCELED = fx('x3-sub-canceled-cape-paused');
const X4_NOW = (X4_PAUSED.current_period_start + 3 * 86400) * 1000;
const USER = 'USER-3878-RESUME';
const ORG = 'ORG-3878-RESUME';

const list = (data: Obj[]) => ({ object: 'list', data, has_more: false, url: '/v1/x' });

const row: OutboxRow = {
  id: 'outbox-resume-3878-b1',
  stripe_mode: 'test',
  kind: 'resume_agent_subscription',
  user_id: USER,
  organization_id: null,
  dedupe_key: `resume:test:${USER}:1`,
  run_after: '2026-10-13T00:00:00Z',
  payload: {},
  attempts: 0,
  last_error: null,
  claimed_until: null,
  created_at: '2026-10-13T00:00:00Z',
  processed_at: null,
};
const RESUME_PARAMS = { pause_collection: '', billing_cycle_anchor: 'now', proration_behavior: 'none', metadata: { keepr_resume: row.id } };

let db: BillingDb;
let stripe: StripeStub;
let subs: Obj[];
let after: Record<string, Obj>;
let invoices: Obj[];
const mockRpc = jest.fn();

function seed(customerId: string) {
  db = new BillingDb({
    licenses: [{ user_id: USER, status: 'active' }],
    stripe_customers: [{ user_id: USER, stripe_customer_id: customerId, default_payment_method_id: null, stripe_mode: 'test' }],
    organizations: [{ id: ORG, personal_owner_user_id: USER, is_test: true }],
    billing_outbox: [{ ...row }],
  });
}
function ctx() {
  return { stripe: stripe.client, service: { from: db.from, rpc: mockRpc } as never, mode: 'test' as const, deadline: new Date(Date.now() + 60_000) };
}
const grants = () => mockRpc.mock.calls.filter((c) => c[0] === 'grant_unlimited_from_subscription').map((c) => c[1]);
const updates = () => stripe.callsTo('subscriptions.update');

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(Date, 'now').mockReturnValue(X4_NOW);
  mockRpc.mockResolvedValue({ data: { status: 'granted' }, error: null });
  invoices = [X2_VOIDED, X4_INV, CAPE_INV, X2_RESUME_INV];
  after = { [X2_PAUSED.id]: X2_RESUMED, [X4_PAUSED.id]: X4_AFTER, [CAPE_PAUSED.id]: CAPE_AFTER };
  stripe = createStripeStub({
    'subscriptions.list': () => list(subs),
    'subscriptions.retrieve': (id: string) => subs.find((s) => s.id === id),
    'subscriptions.update': (id: string) => {
      subs = subs.map((s) => (s.id === id ? after[id] : s));
      return after[id];
    },
    'invoices.retrieve': (id: string) => invoices.find((i) => i.id === id),
    'invoices.list': (p: Obj) => list(invoices.filter((i) => i.subscription === p.subscription && i.billing_reason === 'subscription_update' && i.id !== X2_RESUME_INV.id)),
    'charges.retrieve': (id: string) => [X4_CHARGE, CAPE_CHARGE].find((c) => c.id === id),
  });
});
afterEach(() => jest.restoreAllMocks());

describe('resume_agent_subscription handler', () => {
  it('C6 re-anchor: paused, renewal voided -> one update with the exact params and the row key', async () => {
    seed(X2_PAUSED.customer);
    subs = [X2_PAUSED];
    expect([X2_PAUSED.pause_collection?.behavior, X2_VOIDED.id, X2_VOIDED.status]).toEqual(['void', X2_PAUSED.latest_invoice, 'void']);
    await handleResumeRow(row, ctx());
    expect(updates()).toEqual([[X2_PAUSED.id, RESUME_PARAMS, { idempotencyKey: outboxIdempotencyKey(row, `resume:${X2_PAUSED.id}`, RESUME_PARAMS) }]]);
    expect(grants()).toEqual([]); // the resume charge grants through invoice.paid (D2), not here
  });

  it('converges: a second run reads the subscription un-paused and changes nothing', async () => {
    seed(X2_PAUSED.customer);
    subs = [X2_PAUSED];
    await handleResumeRow(row, ctx());
    await handleResumeRow({ ...row, attempts: 1 }, ctx());
    expect(updates()).toHaveLength(1);
  });

  it('contract (c): an invoice already carrying this row\'s marker -> no second charge [COMPOSED: row id = the spike marker, sub still paused]', async () => {
    const marked = { ...row, id: X2_RESUME_INV.subscription_details.metadata.keepr_resume };
    seed(X2_PAUSED.customer);
    subs = [X2_PAUSED];
    stripe.impl['invoices.list'] = () => list([X2_RESUME_INV]);
    await handleResumeRow(marked, ctx());
    expect(updates()).toEqual([]);
  });

  it('contract (c) negative: a recent invoice carrying ANOTHER row\'s marker, paid period lapsed -> exactly one re-anchor [COMPOSED: row id differs from the spike marker]', async () => {
    expect(X2_RESUME_INV.subscription_details.metadata.keepr_resume).not.toBe(row.id);
    seed(X2_PAUSED.customer);
    subs = [X2_PAUSED];
    stripe.impl['invoices.list'] = () => list([X2_RESUME_INV]);
    await handleResumeRow(row, ctx());
    expect(updates()).toEqual([[X2_PAUSED.id, RESUME_PARAMS, { idempotencyKey: outboxIdempotencyKey(row, `resume:${X2_PAUSED.id}`, RESUME_PARAMS) }]]);
  });

  it('R5 / X4: latest invoice paid and its period running -> un-pause ONLY, then the grant is repaired', async () => {
    seed(X4_PAUSED.customer);
    subs = [X4_PAUSED];
    const line = X4_INV.lines.data.find((l: Obj) => l.type === 'subscription' && !l.proration);
    expect(line.period.end * 1000).toBeGreaterThan(X4_NOW);
    await handleResumeRow(row, ctx());
    expect(updates()).toEqual([[X4_PAUSED.id, { pause_collection: '' }, { idempotencyKey: outboxIdempotencyKey(row, `unpause:${X4_PAUSED.id}`) }]]);
    expect(grants()).toEqual([{ p_user_id: USER, p_paid_through: new Date((line.period.end + 7200) * 1000).toISOString(), p_mode: 'test' }]);
  });

  it('R5 boundary sweep: at period end - 1 s un-pause only; at period end and after it, re-anchor', async () => {
    const end = X4_INV.lines.data[0].period.end as number;
    for (const [t, want] of [[end - 1, 'unpause'], [end, 'anchor'], [end + 1, 'anchor']] as const) {
      jest.spyOn(Date, 'now').mockReturnValue(t * 1000);
      seed(X4_PAUSED.customer);
      subs = [X4_PAUSED];
      stripe.calls.length = 0;
      await handleResumeRow(row, ctx());
      const params = updates()[0][1];
      expect([t, params.billing_cycle_anchor ? 'anchor' : 'unpause']).toEqual([t, want]);
    }
  });

  it('cancel_at_period_end -> pause_collection \'\' only (never re-anchored), grant repaired while paid', async () => {
    seed(CAPE_PAUSED.customer);
    subs = [CAPE_PAUSED];
    expect(CAPE_PAUSED.cancel_at_period_end).toBe(true);
    await handleResumeRow(row, ctx());
    expect(updates()).toEqual([[CAPE_PAUSED.id, { pause_collection: '' }, { idempotencyKey: outboxIdempotencyKey(row, `unpause:${CAPE_PAUSED.id}`) }]]);
    expect(grants()).toHaveLength(1);
  });

  it('cancel_at_period_end with no paid running period -> pause_collection \'\' only, no grant', async () => {
    jest.spyOn(Date, 'now').mockReturnValue((CAPE_PAUSED.current_period_end + 10) * 1000);
    seed(CAPE_PAUSED.customer);
    subs = [CAPE_PAUSED];
    await handleResumeRow(row, ctx());
    expect(updates().map((u) => u[1])).toEqual([{ pause_collection: '' }]);
    expect(grants()).toEqual([]);
  });

  it('canceled (X3) -> no update', async () => {
    seed(CANCELED.customer);
    subs = [CANCELED];
    await handleResumeRow(row, ctx());
    expect(updates()).toEqual([]);
  });

  it('not paused (x2 after resume) -> no update', async () => {
    seed(X2_RESUMED.customer);
    subs = [X2_RESUMED];
    await handleResumeRow(row, ctx());
    expect(updates()).toEqual([]);
  });

  it.each(['suspended', 'expired', 'cancelled'])('licence %s at drain time -> zero Stripe calls', async (status) => {
    seed(X2_PAUSED.customer);
    db.rows('licenses')[0].status = status;
    subs = [X2_PAUSED];
    await handleResumeRow(row, ctx());
    expect(stripe.calls).toEqual([]);
  });

  it('no stripe_customers row in this mode -> zero Stripe calls', async () => {
    seed(X2_PAUSED.customer);
    db.rows('stripe_customers')[0].stripe_mode = 'live';
    await handleResumeRow(row, ctx());
    expect(stripe.calls).toEqual([]);
  });

  it('a row without a user is parked', async () => {
    seed(X2_PAUSED.customer);
    await expect(handleResumeRow({ ...row, user_id: null }, ctx())).rejects.toMatchObject({ code: 'bad_payload' });
  });
});
