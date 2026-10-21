/**
 * @jest-environment node
 *
 * BACKLOG-3853 PR-2 — billing_outbox kind `sync_org_subscription` (lib/billing/brokerageSync.ts).
 *
 * Stripe is a recording stub (helpers/stripeStub) over a small in-test "world" that honours
 * idempotency keys as the PR-0 spike measured them (#13): the same key with the same
 * parameters returns the first object; the same key with different parameters raises
 * idempotency_error (fixtures/stripe/p3853/idempotency-error.json). Subscription objects are
 * built from fixtures/stripe/p3853/sub-create.json (TEST capture) with id / quantity / price /
 * metadata set per call [EDITED]. Our rows: helpers/brokerageFake (BillingDb + RPC model).
 * No network.
 */

import fs from 'fs';
import path from 'path';
import { createHash } from 'crypto';
import { clone, createStripeStub, stripeError, type StripeStub } from '../../../helpers/stripeStub';
import { createBrokerageFake, dealRow, type BrokerageFake } from '../../../helpers/brokerageFake';

jest.mock('@sentry/nextjs', () => ({ captureMessage: jest.fn(), captureException: jest.fn() }));

import { handleSyncOrgSubscriptionRow } from '@/lib/billing/brokerageSync';
import { NonRetryableOutboxError, type OutboxRow } from '@/lib/billing/outboxKinds';

type Obj = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const FX = path.join(__dirname, '../../../fixtures/stripe/p3853');
const fx = (n: string): Obj => JSON.parse(fs.readFileSync(path.join(FX, `${n}.json`), 'utf8'));
const SUB_TEMPLATE = fx('sub-create');
const IDEMPOTENCY_ERROR = fx('idempotency-error');

const ORG = 'ORG-3853-S';
let fake: BrokerageFake;
let stripe: StripeStub;

/** Stripe-side state for one test. */
interface World {
  customers: Map<string, Obj>;
  subs: Map<string, Obj>;
  keys: Map<string, { digest: string; result: Obj }>;
  product: Obj | null;
  seq: number;
}
let world: World;
const digest = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');

function idempotent(key: string | undefined, params: unknown, make: () => Obj): Obj {
  if (!key) return make();
  const d = digest(params);
  const prior = world.keys.get(key);
  if (prior) {
    if (prior.digest !== d) throw stripeError(IDEMPOTENCY_ERROR as never);
    return prior.result;
  }
  const result = make();
  world.keys.set(key, { digest: d, result });
  return result;
}

function makeSub(params: Obj): Obj {
  const s = clone(SUB_TEMPLATE);
  s.id = `sub_3853_${++world.seq}`;
  s.customer = params.customer;
  s.status = 'active';
  s.metadata = params.metadata;
  s.items.data[0].id = `si_3853_${world.seq}`;
  s.items.data[0].quantity = params.items[0].quantity;
  s.items.data[0].price.unit_amount = params.items[0].price_data.unit_amount;
  s.quantity = params.items[0].quantity;
  return s;
}

function stub(): StripeStub {
  return createStripeStub({
    'products.retrieve': () => {
      if (!world.product) throw Object.assign(new Error('No such product'), { code: 'resource_missing', statusCode: 404 });
      return world.product;
    },
    'products.create': (p: Obj, o: Obj) => idempotent(o?.idempotencyKey, p, () => (world.product = { id: p.id, name: p.name })),
    'customers.create': (p: Obj, o: Obj) =>
      idempotent(o?.idempotencyKey, p, () => {
        const c = { id: `cus_3853_${++world.seq}`, email: null, name: null, metadata: p.metadata };
        world.customers.set(c.id, c);
        return c;
      }),
    'customers.retrieve': (id: string) => world.customers.get(id),
    'customers.update': (id: string, p: Obj, o: Obj) =>
      idempotent(o?.idempotencyKey, [id, p], () => Object.assign(world.customers.get(id)!, p)),
    'subscriptions.retrieve': (id: string) => world.subs.get(id),
    'subscriptions.list': (p: Obj) => ({ object: 'list', data: [...world.subs.values()].filter((s) => s.customer === p.customer), has_more: false }),
    'subscriptions.create': (p: Obj, o: Obj) =>
      idempotent(o?.idempotencyKey, p, () => {
        const s = makeSub(p);
        world.subs.set(s.id, s);
        return s;
      }),
    'subscriptions.update': (id: string, p: Obj, o: Obj) =>
      idempotent(o?.idempotencyKey, [id, p], () => {
        const s = world.subs.get(id)!;
        const it = p.items[0];
        s.items.data[0].quantity = it.quantity;
        if (it.price_data) s.items.data[0].price.unit_amount = it.price_data.unit_amount;
        return s;
      }),
  });
}

function row(version: number, over: Partial<OutboxRow> = {}): OutboxRow {
  return {
    id: `0000000${version}-3853-4000-8000-00000000000${version}`,
    stripe_mode: 'test',
    kind: 'sync_org_subscription',
    user_id: null,
    organization_id: ORG,
    dedupe_key: `sync_org_subscription:test:${ORG}:v${version}`,
    run_after: '2026-10-19T00:00:00Z',
    payload: { organization_id: ORG, deal_version: version },
    attempts: 1,
    last_error: null,
    claimed_until: null,
    created_at: '2026-10-19T00:00:00Z',
    processed_at: null,
    ...over,
  };
}

function ctx(mode: 'test' | 'live' = 'test', deadlineMs = 60_000) {
  return { stripe: stripe.client, service: fake.service as never, mode, deadline: new Date(Date.now() + deadlineMs) };
}

const deal = () => fake.db.rows('org_deals')[0];
function saveDeal(over: Obj) {
  Object.assign(deal(), over, { version: (deal().version as number) + 1 });
}
const mutations = () => stripe.ops().filter((o) => /\.(create|update)$/.test(o));
const leaseHeld = () => fake.db.rows('org_billing_stripe').some((r) => r.sync_lease_holder);

beforeEach(() => {
  world = { customers: new Map(), subs: new Map(), keys: new Map(), product: null, seq: 0 };
  stripe = stub();
  fake = createBrokerageFake({
    organizations: [{ id: ORG, name: 'Brokerage 3853 S', is_test: true }],
    org_deals: [dealRow(ORG)],
    org_deal_lines: [{ organization_id: ORG, item_key: 'brokerage_seat', unit_price_cents: 2499 }],
    org_billing_stripe: [],
  });
});

describe('sync_org_subscription', () => {
  it('first run: product, customer (metadata only), contact, then one send_invoice net-15 subscription; ids persisted', async () => {
    await handleSyncOrgSubscriptionRow(row(1), ctx());
    expect(stripe.callsTo('products.create')).toEqual([[{ id: 'keepr_team_seat', name: 'Keepr Team seat' }, { idempotencyKey: 'brokerage:product:test' }]]);
    expect(stripe.callsTo('customers.create')).toEqual([
      [{ metadata: { kind: 'brokerage', organization_id: ORG } }, { idempotencyKey: `brokerage:${ORG}:test:customer` }],
    ]);
    expect(stripe.callsTo('customers.update')[0][1]).toEqual({ email: 'billing-3853@example.test', name: 'Brokerage 3853 S' });
    const [[params, opts]] = stripe.callsTo('subscriptions.create');
    expect(opts).toEqual({ idempotencyKey: `brokerage:${ORG}:test:subscription:v1:none` });
    expect(params).toMatchObject({
      collection_method: 'send_invoice',
      days_until_due: 15,
      proration_behavior: 'none',
      items: [{ quantity: 5, price_data: { currency: 'usd', product: 'keepr_team_seat', unit_amount: 2499, recurring: { interval: 'month' } } }],
      payment_settings: { payment_method_types: ['us_bank_account', 'card', 'customer_balance'] },
      metadata: { kind: 'brokerage', organization_id: ORG, deal_version: '1' },
    });
    const [m] = fake.db.rows('org_billing_stripe');
    expect(m).toMatchObject({ stripe_customer_id: 'cus_3853_1', stripe_subscription_id: 'sub_3853_2' });
    expect(m.status).toBeUndefined(); // the drain never writes status (SR plan review item 1)
    // Every drain write to the mirror carries ids only and no event time.
    for (const a of fake.callsTo('_billing_apply_org_subscription')) {
      expect(a.p_event_created).toBeNull();
      expect(Object.keys(a.p_fields as Obj).sort()).toEqual(expect.arrayContaining(['stripe_customer_id']));
      expect(a.p_fields).not.toHaveProperty('status');
    }
    expect(leaseHeld()).toBe(false);
  });

  it('convergence: the same row again changes nothing in Stripe', async () => {
    await handleSyncOrgSubscriptionRow(row(1), ctx());
    world.product = world.product ?? { id: 'keepr_team_seat' };
    const before = stripe.calls.length;
    await handleSyncOrgSubscriptionRow(row(1, { attempts: 2 }), ctx());
    const second = stripe.ops().slice(before);
    expect(second.filter((o) => /\.(create|update)$/.test(o))).toEqual([]);
    expect(world.subs.size).toBe(1);
    expect(world.customers.size).toBe(1);
  });

  it('C-S: a seat change updates quantity with proration none, keeps the price, creates nothing', async () => {
    await handleSyncOrgSubscriptionRow(row(1), ctx());
    saveDeal({ seats: 7 });
    const before = stripe.calls.length;
    await handleSyncOrgSubscriptionRow(row(2), ctx());
    expect(stripe.ops().slice(before).filter((o) => o.endsWith('.create'))).toEqual([]);
    const [[subId, params, opts]] = stripe.callsTo('subscriptions.update');
    expect(subId).toBe('sub_3853_2');
    expect(params).toEqual({ items: [{ id: 'si_3853_2', quantity: 7 }], proration_behavior: 'none' });
    expect(opts.idempotencyKey).toMatch(new RegExp(`^brokerage:${ORG}:test:subscription_update:v2:[0-9a-f]{16}$`));
  });

  it('C-S2: a price change sends price_data on the item', async () => {
    await handleSyncOrgSubscriptionRow(row(1), ctx());
    saveDeal({});
    fake.db.rows('org_deal_lines')[0].unit_price_cents = 2199;
    await handleSyncOrgSubscriptionRow(row(2), ctx());
    const [[, params]] = stripe.callsTo('subscriptions.update');
    expect(params.items[0]).toMatchObject({ quantity: 5, price_data: { unit_amount: 2199, product: 'keepr_team_seat' } });
  });

  it('C-K: a v1 row drained after a v2 save -> superseded, zero Stripe calls; the v2 row creates once', async () => {
    saveDeal({ seats: 7 });
    await handleSyncOrgSubscriptionRow(row(1), ctx());
    expect(stripe.calls).toEqual([]);
    await handleSyncOrgSubscriptionRow(row(2), ctx());
    expect(stripe.callsTo('subscriptions.create')).toHaveLength(1);
    expect(stripe.callsTo('subscriptions.create')[0][1]).toEqual({ idempotencyKey: `brokerage:${ORG}:test:subscription:v2:none` });
    expect(world.subs.size).toBe(1);
  });

  it('C-6: two runs for one organization at once -> one customer, one subscription (lease)', async () => {
    let inner: Promise<unknown> | undefined;
    const create = stripe.impl['subscriptions.create'];
    stripe.impl['subscriptions.create'] = async (p: Obj, o: Obj) => {
      if (!inner) {
        // While run A's create is in flight, the deal is saved again and run B starts.
        saveDeal({ seats: 7 });
        inner = handleSyncOrgSubscriptionRow(row(2), ctx()).catch((e) => e);
        await inner;
      }
      return create(p, o);
    };
    await handleSyncOrgSubscriptionRow(row(1), ctx());
    const bResult: unknown = await inner;
    expect(bResult).toBeInstanceOf(Error);
    expect((bResult as Error).message).toBe('brokerage sync lease busy');
    // B retries after A released the lease: it adopts A's subscription and sets 7 seats.
    await handleSyncOrgSubscriptionRow(row(2, { attempts: 2 }), ctx());
    expect(world.customers.size).toBe(1);
    expect(world.subs.size).toBe(1);
    expect([...world.subs.values()][0].items.data[0].quantity).toBe(7);
  });

  it('C-6c: crash after create, before the id is saved -> the next version adopts it from the list', async () => {
    const orig = fake.service.rpc;
    let applies = 0;
    fake.service.rpc = async (fn, args) => {
      if (fn === '_billing_apply_org_subscription' && ++applies === 2) {
        return { data: null, error: { code: 'PGRST000', message: 'fixture: crash before persist' } };
      }
      return orig(fn, args);
    };
    await expect(handleSyncOrgSubscriptionRow(row(1), ctx())).rejects.toThrow('_billing_apply_org_subscription failed');
    expect(world.subs.size).toBe(1);
    expect(fake.db.rows('org_billing_stripe')[0].stripe_subscription_id).toBeUndefined();
    saveDeal({ seats: 6 });
    await handleSyncOrgSubscriptionRow(row(2), ctx());
    expect(world.subs.size).toBe(1);
    expect(fake.db.rows('org_billing_stripe')[0].stripe_subscription_id).toBe('sub_3853_2');
    expect([...world.subs.values()][0].items.data[0].quantity).toBe(6);
    expect(leaseHeld()).toBe(false);
  });

  it('C-M: a live deal while brokerage billing is not live -> billing_not_live, zero Stripe calls', async () => {
    deal().stripe_mode = 'live';
    await expect(handleSyncOrgSubscriptionRow(row(1, { stripe_mode: 'live' }), ctx('live'))).rejects.toMatchObject({
      code: 'billing_not_live',
    });
    expect(stripe.calls).toEqual([]);
  });

  it('belt (not a counted control): deal mode differs from the drain mode -> mode_mismatch', async () => {
    await expect(handleSyncOrgSubscriptionRow(row(1), ctx('live'))).rejects.toBeInstanceOf(NonRetryableOutboxError);
    expect(stripe.calls).toEqual([]);
  });

  it('deadline: past the deadline after the first call -> ordinary error, lease released, no second call', async () => {
    await expect(handleSyncOrgSubscriptionRow(row(1), ctx('test', -1))).rejects.toThrow('outbox deadline reached');
    expect(stripe.ops()).toEqual(['products.retrieve']);
    expect(leaseHeld()).toBe(false);
  });

  it('a canceled deal -> nothing to sync', async () => {
    deal().status = 'canceled';
    await handleSyncOrgSubscriptionRow(row(1), ctx());
    expect(stripe.calls).toEqual([]);
    expect(mutations()).toEqual([]);
  });
});

/**
 * BACKLOG-4007 PR-3 — billing start (trial_end decided when the row runs) and customer details.
 * Deal shape from broker_complete_billing_setup (supabase/migrations/20261020100000…:861-870):
 * status 'active', version + 1, billing_starts_on = greatest(Pacific business date, start_date).
 */
describe('sync_org_subscription — 4007 billing start and customer details', () => {
  const at = (iso: string) => jest.spyOn(Date, 'now').mockReturnValue(Date.parse(iso));
  const noon = (d: string) => Date.parse(`${d}T12:00:00Z`) / 1000;
  afterEach(() => jest.restoreAllMocks());

  it('C-P1a: a future billing start -> trial_end = that date 12:00 UTC; the key carries it', async () => {
    at('2026-10-20T18:00:00Z');
    deal().billing_starts_on = '2026-10-30';
    await handleSyncOrgSubscriptionRow(row(1), ctx());
    const [[params, opts]] = stripe.callsTo('subscriptions.create');
    expect(params.trial_end).toBe(noon('2026-10-30'));
    expect(opts).toEqual({ idempotencyKey: `brokerage:${ORG}:test:subscription:v1:${noon('2026-10-30')}` });
  });

  it('C-P1b: billing starts today (Pacific), completed at 19:00 PT -> no trial_end, bill now', async () => {
    at('2026-10-21T02:00:00Z'); // 2026-10-20 19:00 America/Los_Angeles
    deal().billing_starts_on = '2026-10-20';
    await handleSyncOrgSubscriptionRow(row(1), ctx());
    const [[params, opts]] = stripe.callsTo('subscriptions.create');
    expect(params).not.toHaveProperty('trial_end');
    expect(opts.idempotencyKey).toBe(`brokerage:${ORG}:test:subscription:v1:none`);
  });

  it('C-P1c: a late retry (drain ran 30 min before the start noon) -> no trial_end', async () => {
    at('2026-10-30T11:30:00Z');
    deal().billing_starts_on = '2026-10-30';
    await handleSyncOrgSubscriptionRow(row(1), ctx());
    expect(stripe.callsTo('subscriptions.create')[0][0]).not.toHaveProperty('trial_end');
  });

  it('C-P1d: boundary sweep of the 1 h lead', async () => {
    const { trialEndFor, TRIAL_END_MIN_LEAD_SECONDS } = await import('@/lib/billing/brokerageSync');
    const n = noon('2026-10-30');
    for (const lead of [-86400, -1, 0, 1, TRIAL_END_MIN_LEAD_SECONDS - 1]) {
      expect(trialEndFor('2026-10-30', (n - lead) * 1000)).toBeNull();
    }
    for (const lead of [TRIAL_END_MIN_LEAD_SECONDS, TRIAL_END_MIN_LEAD_SECONDS + 1, 86400 * 30]) {
      expect(trialEndFor('2026-10-30', (n - lead) * 1000)).toBe(n);
    }
    expect(trialEndFor(null, 0)).toBeNull();
    expect(trialEndFor('not-a-date', 0)).toBeNull();
  });

  it('C-P1e: no billing_starts_on (deals saved before 4007, e.g. Alpha/Beta) -> no trial_end', async () => {
    at('2026-10-20T18:00:00Z');
    await handleSyncOrgSubscriptionRow(row(1), ctx());
    expect(stripe.callsTo('subscriptions.create')[0][0]).not.toHaveProperty('trial_end');
  });

  it('C-P1f: one row run on both sides of the cutoff -> two different keys, still one subscription (adopt)', async () => {
    deal().billing_starts_on = '2026-10-30';
    const orig = fake.service.rpc;
    let applies = 0;
    fake.service.rpc = async (fn, args) => {
      if (fn === '_billing_apply_org_subscription' && ++applies === 2) {
        return { data: null, error: { code: 'PGRST000', message: 'fixture: crash before persist' } };
      }
      return orig(fn, args);
    };
    at('2026-10-29T12:00:00Z');
    await expect(handleSyncOrgSubscriptionRow(row(1), ctx())).rejects.toThrow('_billing_apply_org_subscription failed');
    at('2026-10-30T11:30:00Z');
    await handleSyncOrgSubscriptionRow(row(1, { attempts: 2 }), ctx());
    expect(stripe.callsTo('subscriptions.create')).toHaveLength(1);
    expect(world.subs.size).toBe(1);
  });

  it('C-C1: company, phone and PO go on the Stripe customer; a second run changes nothing', async () => {
    deal().billing_contact_id = 'CONTACT-1';
    // People v2: the contact is a member link; the phone is the person's (user_phones).
    fake.db.rows('org_contacts').push({ id: 'CONTACT-1', organization_id: ORG, role: 'billing', member_id: 'MEMBER-1', removed_at: null });
    fake.db.rows('organization_members').push({ id: 'MEMBER-1', organization_id: ORG, user_id: 'USER-1', role: 'admin', license_status: 'active' });
    fake.db.rows('user_phones').push({ user_id: 'USER-1', pending_member_id: null, phone: '+12065550100' });
    fake.db.rows('org_billing_profile').push({
      organization_id: ORG,
      legal_name: 'Brokerage 3853 S LLC',
      address_line1: '1 Main St',
      address_line2: null,
      city: 'Seattle',
      region: 'WA',
      postal_code: '98101',
      country: 'US',
      po_number: 'PO-77',
    });
    await handleSyncOrgSubscriptionRow(row(1), ctx());
    expect(stripe.callsTo('customers.update')[0][1]).toEqual({
      email: 'billing-3853@example.test',
      name: 'Brokerage 3853 S LLC',
      phone: '+12065550100',
      address: { line1: '1 Main St', line2: '', city: 'Seattle', state: 'WA', postal_code: '98101', country: 'US' },
      invoice_settings: { custom_fields: [{ name: 'PO number', value: 'PO-77' }] },
    });
    const before = stripe.callsTo('customers.update').length;
    await handleSyncOrgSubscriptionRow(row(1, { attempts: 2 }), ctx());
    expect(stripe.callsTo('customers.update')).toHaveLength(before);
  });

  it('C-C2: PO removed -> the custom field is cleared; other custom fields are kept', async () => {
    fake.db.rows('org_billing_profile').push({
      organization_id: ORG, legal_name: 'B LLC', address_line1: '1 Main St', address_line2: null,
      city: 'Seattle', region: 'WA', postal_code: '98101', country: 'US', po_number: null,
    });
    await handleSyncOrgSubscriptionRow(row(1), ctx());
    const c = [...world.customers.values()][0];
    c.invoice_settings = { custom_fields: [{ name: 'PO number', value: 'OLD' }, { name: 'Tax ID', value: 'T1' }] };
    saveDeal({});
    await handleSyncOrgSubscriptionRow(row(2), ctx());
    const last = stripe.callsTo('customers.update').at(-1)!;
    expect(last[1]).toEqual({ invoice_settings: { custom_fields: [{ name: 'Tax ID', value: 'T1' }] } });
  });

  it('C-C3: no company details yet -> name falls back to the organization, PO untouched', async () => {
    await handleSyncOrgSubscriptionRow(row(1), ctx());
    expect(stripe.callsTo('customers.update')[0][1]).toEqual({ email: 'billing-3853@example.test', name: 'Brokerage 3853 S' });
  });
});
