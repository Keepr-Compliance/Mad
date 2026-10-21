/**
 * @jest-environment node
 *
 * BACKLOG-4019 — the payment-reconcile backstop for a missed customer.subscription.deleted
 * (lib/billing/brokerageEndBackstop.ts). Subscription shapes: fixtures/stripe/p4019 (sandbox
 * probe, see its README). Our rows: helpers/brokerageFake. No network.
 */

import fs from 'fs';
import path from 'path';
import { createBrokerageFake, dealRow, type BrokerageFake } from '../../helpers/brokerageFake';

jest.mock('@sentry/nextjs', () => ({ captureMessage: jest.fn(), captureException: jest.fn() }));
jest.mock('@/lib/email', () => ({}));

import { endLapsedBrokerageDeals } from '@/lib/billing/brokerageEndBackstop';

type Obj = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const FX = path.join(__dirname, '../../fixtures/stripe/p4019');
const fx = (n: string): Obj => JSON.parse(fs.readFileSync(path.join(FX, `${n}.json`), 'utf8'));
const ENDED = fx('sub-ended');
const PENDING = fx('sub-cancel-pending');

const ORG = 'ORG-4019-B';
const NOW = new Date('2026-12-01T00:00:00Z');
let fake: BrokerageFake;
let subs: Map<string, Obj>;
const retrieve = jest.fn(async (id: string) => subs.get(id));
const stripe = { subscriptions: { retrieve } } as never;

function seed(deal: Obj, periodEnd: string) {
  fake = createBrokerageFake({
    org_deals: [dealRow(ORG, deal)],
    org_billing_stripe: [
      { organization_id: ORG, stripe_mode: 'test', stripe_customer_id: 'cus_4019', stripe_subscription_id: 'sub_4019_1', status: 'active', current_period_end: periodEnd },
    ],
    billing_outbox: [],
  });
}
const run = () => endLapsedBrokerageDeals({ service: fake.service as never, stripe, mode: 'test', now: () => NOW });

beforeEach(() => {
  retrieve.mockClear();
  subs = new Map();
});

describe('brokerage end backstop', () => {
  it('canceling, period end > 1 h ago, Stripe says canceled -> the deal ends (webhook path)', async () => {
    seed({ status: 'canceling' }, '2026-11-30T12:00:00Z');
    subs.set('sub_4019_1', { ...ENDED, id: 'sub_4019_1' });
    expect(await run()).toEqual({ scanned: 1, ended: 1, stillOpen: 0 });
    expect(fake.callsTo('_billing_end_org_deal')).toEqual([{ p_org: ORG, p_mode: 'test', p_subscription_id: 'sub_4019_1' }]);
    expect(fake.db.rows('org_deals')[0].status).toBe('canceled');
  });

  it('suspended while canceling -> ends too', async () => {
    seed({ status: 'suspended', status_before_suspension: 'canceling', suspended_reason: 'other' }, '2026-11-30T12:00:00Z');
    subs.set('sub_4019_1', { ...ENDED, id: 'sub_4019_1' });
    expect((await run()).ended).toBe(1);
  });

  it('Stripe still has it open -> nothing ends, counted', async () => {
    seed({ status: 'canceling' }, '2026-11-30T12:00:00Z');
    subs.set('sub_4019_1', { ...PENDING, id: 'sub_4019_1' });
    expect(await run()).toEqual({ scanned: 1, ended: 0, stillOpen: 1 });
    expect(fake.callsTo('_billing_end_org_deal')).toEqual([]);
  });

  it('period end within the last hour, or ahead -> not looked at (no Stripe call)', async () => {
    seed({ status: 'canceling' }, '2026-11-30T23:30:00Z');
    expect(await run()).toEqual({ scanned: 0, ended: 0, stillOpen: 0 });
    expect(retrieve).not.toHaveBeenCalled();
  });

  it('active and suspended-before-active deals are never looked at', async () => {
    seed({ status: 'active' }, '2026-11-01T00:00:00Z');
    expect((await run()).scanned).toBe(0);
    seed({ status: 'suspended', status_before_suspension: 'active', suspended_reason: 'other' }, '2026-11-01T00:00:00Z');
    expect((await run()).scanned).toBe(0);
    expect(retrieve).not.toHaveBeenCalled();
  });
});
