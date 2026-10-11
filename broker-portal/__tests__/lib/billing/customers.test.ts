/**
 * @jest-environment node
 *
 * BACKLOG-3845 — lib/billing/customers.ts against the recording fake
 * (__tests__/helpers/billingDb.ts): every read and write is keyed by
 * (user_id, stripe_mode); the test-mode guard fails closed.
 */
import { BillingDb, eqValue, type Row } from '../../helpers/billingDb';

const mockCaptureMessage = jest.fn();
jest.mock('@sentry/nextjs', () => ({
  captureMessage: (...a: unknown[]) => mockCaptureMessage(...a),
  captureException: jest.fn(),
}));

import {
  clearDefaultPaymentMethod,
  ensureStripeCustomer,
  getStripeCustomer,
  isModeAllowedForUser,
  setDefaultPaymentMethod,
} from '@/lib/billing/customers';

type Service = Parameters<typeof getStripeCustomer>[0];
type StripeLike = Parameters<typeof ensureStripeCustomer>[1];

function row(mode: 'test' | 'live', over: Row = {}): Row {
  return {
    user_id: 'U1',
    stripe_customer_id: mode === 'test' ? 'cus_FX3845test' : 'cus_LIVE_PLACEHOLDER',
    default_payment_method_id: `pm_FX3845${mode}`,
    stripe_mode: mode,
    ...over,
  };
}
function svc(db: BillingDb): Service {
  return { from: db.from } as unknown as Service;
}
function stripeWith(create: jest.Mock): StripeLike {
  return { customers: { create } } as unknown as StripeLike;
}

beforeEach(() => jest.clearAllMocks());

describe('getStripeCustomer', () => {
  it('returns only the row of the asked mode', async () => {
    const db = new BillingDb({ stripe_customers: [row('test'), row('live')] });
    expect(await getStripeCustomer(svc(db), 'U1', 'live')).toMatchObject({ stripe_customer_id: 'cus_LIVE_PLACEHOLDER' });
    expect(await getStripeCustomer(svc(db), 'U1', 'test')).toMatchObject({ stripe_customer_id: 'cus_FX3845test' });
    expect(db.calls.every((c) => eqValue(c, 'stripe_mode') !== undefined)).toBe(true);
  });

  it('throws on a read error instead of reading it as "no customer"', async () => {
    const db = new BillingDb({ stripe_customers: [] });
    db.failNext['stripe_customers.select'] = { code: 'PGRST000', message: 'down' };
    await expect(getStripeCustomer(svc(db), 'U1', 'live')).rejects.toThrow('down');
  });
});

describe('ensureStripeCustomer', () => {
  it('inserts the new customer with its mode', async () => {
    const db = new BillingDb({ stripe_customers: [row('test')] });
    const create = jest.fn().mockResolvedValue({ id: 'cus_FX3845new' });
    expect(await ensureStripeCustomer(svc(db), stripeWith(create), 'U1', null, 'live')).toBe('cus_FX3845new');
    expect(db.rows('stripe_customers')[1]).toEqual({ user_id: 'U1', stripe_customer_id: 'cus_FX3845new', stripe_mode: 'live' });
  });

  it('concurrent insert (23505) → the stored id wins, reported', async () => {
    const db = new BillingDb({ stripe_customers: [] });
    const create = jest.fn().mockImplementation(async () => {
      // another request stores its customer between our read and our insert
      db.rows('stripe_customers').push(row('live', { stripe_customer_id: 'cus_FX3845winner' }));
      return { id: 'cus_FX3845loser' };
    });
    expect(await ensureStripeCustomer(svc(db), stripeWith(create), 'U1', null, 'live')).toBe('cus_FX3845winner');
    expect(mockCaptureMessage).toHaveBeenCalledWith('stripe_customers insert failed', expect.anything());
  });
});

describe('card writes touch one mode only', () => {
  it('clearDefaultPaymentMethod', async () => {
    const db = new BillingDb({ stripe_customers: [row('test'), row('live')] });
    await clearDefaultPaymentMethod(svc(db), 'U1', 'test');
    expect(db.rows('stripe_customers')).toEqual([row('test', { default_payment_method_id: null }), row('live')]);
  });

  it('setDefaultPaymentMethod', async () => {
    const db = new BillingDb({ stripe_customers: [row('test'), row('live')] });
    await setDefaultPaymentMethod(svc(db), 'U1', 'live', 'pm_FX3845new');
    expect(db.rows('stripe_customers')[0]).toEqual(row('test'));
    expect(db.rows('stripe_customers')[1].default_payment_method_id).toBe('pm_FX3845new');
  });
});

describe('isModeAllowedForUser (SR req. 10)', () => {
  const org = (isTest: boolean | null) => ({ id: 'O1', personal_owner_user_id: 'U1', is_test: isTest });
  it.each([
    ['live, non-test user', 'live', [org(false)], true],
    ['test, is_test user', 'test', [org(true)], true],
    ['test, non-test user', 'test', [org(false)], false],
    ['test, no personal org', 'test', [], false],
    ['test, is_test null', 'test', [org(null)], false],
  ] as const)('%s → %s', async (_l, mode, orgs, want) => {
    const db = new BillingDb({ organizations: [...orgs] });
    expect(await isModeAllowedForUser(svc(db), 'U1', mode)).toBe(want);
  });

  it('test, read error → refused', async () => {
    const db = new BillingDb({ organizations: [org(true)] });
    db.failNext['organizations.select'] = { code: 'PGRST000', message: 'down' };
    expect(await isModeAllowedForUser(svc(db), 'U1', 'test')).toBe(false);
  });
});
