/**
 * @jest-environment node
 *
 * BACKLOG-3847 — the Agent plan server actions (Subscribe, Cancel plan, Keep
 * my plan, confirm-on-return).
 *
 * Real: the impersonation helper (a support session is a cookie signed with the
 * real signer plus an impersonation_sessions row, SR R7), getPortalAccess and
 * classifyPortalAccess (over the transcribed PostgREST emulator), the billing
 * flag, billingCapabilities, the plan view, the mode guard, the checkout
 * orchestration and next/navigation's redirect().
 * Mocked: the two Supabase clients (an argument-applying BillingDb for the
 * service client), the Stripe client (serving the TEST objects in
 * fixtures/stripe/p3847 by id and by list page, see its README), Sentry,
 * next/cache. No network.
 */

import fs from 'fs';
import path from 'path';
import { BillingDb, eqValue, type Row } from '../../helpers/billingDb';
import {
  FIXTURE_PERSONAL_ORG_ID,
  FIXTURE_USER_ID,
  brokerageMembership,
  createPostgrestEmulator,
  personalMembership,
} from '../../helpers/postgrestEmulator';

// ---- mocks -------------------------------------------------------------------

const mockEmulator = createPostgrestEmulator();
const mockGetUser = jest.fn();
let mockCookie: string | undefined;
let mockSessionRow: Record<string, unknown> | null = null;
let mockHeaders: Record<string, string> = {};
let mockDb: BillingDb;
const mockServiceTables: string[] = [];
const mockStripeCalls: { op: string; args: any[] }[] = [];
let mockStripeImpl: Record<string, (...a: any[]) => unknown> = {};

jest.mock('@sentry/nextjs', () => ({ captureMessage: jest.fn(), captureException: jest.fn() }));
jest.mock('next/cache', () => ({ revalidatePath: jest.fn() }));
jest.mock('next/headers', () => ({
  cookies: async () => ({
    get: (name: string) => (name === 'impersonation_session' && mockCookie ? { value: mockCookie } : undefined),
    set: jest.fn(),
  }),
  headers: async () => new Headers(mockHeaders),
}));
jest.mock('@/lib/supabase/server', () => ({
  createClient: jest.fn(async () => ({ auth: { getUser: mockGetUser }, from: (t: string) => mockEmulator.from(t) })),
}));
jest.mock('@/lib/supabase/service', () => ({
  createServiceClient: jest.fn(() => ({
    rpc: jest.fn(async () => ({ data: null, error: null })),
    from: (table: string) => {
      mockServiceTables.push(table);
      if (table !== 'impersonation_sessions') return mockDb.from(table);
      const q: Record<string, unknown> = {};
      for (const m of ['select', 'eq', 'in', 'gt', 'order', 'limit']) q[m] = jest.fn(() => q);
      q.single = jest.fn(async () =>
        mockSessionRow ? { data: mockSessionRow, error: null } : { data: null, error: { code: 'PGRST116', message: 'fixture: no rows' } }
      );
      q.maybeSingle = q.single;
      return q;
    },
  })),
}));
jest.mock('stripe', () => {
  const op = (name: string) => (...args: unknown[]) => {
    mockStripeCalls.push({ op: name, args });
    const impl = mockStripeImpl[name];
    if (!impl) throw new Error(`test: unexpected Stripe call ${name}`);
    return impl(...args);
  };
  return {
    __esModule: true,
    default: jest.fn().mockImplementation(() => ({
      prices: { list: op('prices.list') },
      customers: { create: op('customers.create'), retrieve: op('customers.retrieve'), update: op('customers.update') },
      setupIntents: { retrieve: op('setupIntents.retrieve') },
      subscriptions: {
        list: op('subscriptions.list'),
        retrieve: op('subscriptions.retrieve'),
        update: op('subscriptions.update'),
        cancel: op('subscriptions.cancel'),
      },
      invoices: {
        voidInvoice: op('invoices.voidInvoice'),
        retrieve: op('invoices.retrieve'),
        list: op('invoices.list'),
        pay: op('invoices.pay'),
      },
      checkout: {
        sessions: {
          // By-subscription listings (voidIncompleteSubscription) are served
          // apart from the by-customer ones, so they never shift `lists()`.
          list: (params: { subscription?: string } | undefined, ...rest: unknown[]) =>
            op(params?.subscription ? 'checkout.sessions.list:subscription' : 'checkout.sessions.list')(params, ...rest),
          expire: op('checkout.sessions.expire'),
          create: op('checkout.sessions.create'),
          retrieve: op('checkout.sessions.retrieve'),
        },
      },
    })),
  };
});

import { confirmCardUpdate, startCardUpdate, updateBillingContact } from '@/lib/actions/billingCard';
import {
  confirmAgentCheckout,
  endAgentPlanNow,
  endAgentPlanAtPeriodEnd,
  keepAgentPlan,
  startAgentCheckout,
} from '@/lib/actions/agentPlan';
import { signCookieValue } from '@/lib/cookie-signing';
import { getAgentPlanView } from '@/lib/billing/agentPlan';
import { createServiceClient } from '@/lib/supabase/service';
import { mirrorState } from '@/lib/billing/sync';
import { agentIdempotencyKey, buildSubscriptionCheckoutParams } from '@/lib/billing/agentCheckoutParams';

// ---- fixtures ------------------------------------------------------------------

type Obj = Record<string, any>;
const FX = path.join(__dirname, '../../fixtures/stripe/p3847');
const fx = (n: string): Obj => JSON.parse(fs.readFileSync(path.join(FX, `${n}.json`), 'utf8'));
const clone = <T>(o: T): T => JSON.parse(JSON.stringify(o));

const CUS = fx('cus').id as string;
const PRICES = fx('prices-list-lookup');
const PRICE = PRICES.data[0];
const S1 = fx('cs-S1-open');
const S0 = fx('cs-S0-oldprice-open');
const A = fx('sub-A-incomplete');
const A_AFTER = fx('sub-A-after-void');
const C_INC = fx('sub-C-incomplete');
const C_ACTIVE = fx('sub-C-active-after-pay');
const C_PENDING = fx('sub-C-cancel-at-period-end');
const C_KEEP = fx('sub-C-keep');
const EMPTY_LIST = { object: 'list', data: [], has_more: false, url: '/v1/subscriptions' }; // shape of every list above, no items
const APP = 'https://app.keeprcompliance.com';

/** pii-allow-uuid: invented, not from any live row. */
const SESSION_ID = '00000000-3847-4000-8000-000000000001';
/** pii-allow-uuid: invented, not from any live row. */
const OTHER_USER = '00000000-3847-4000-8000-000000000002';

// ---- harness -------------------------------------------------------------------

let objects: Map<string, Obj[]>;
/** retrieve(id) answers the queued objects in order; the last one repeats. */
function serve(id: string, ...objs: Obj[]): void {
  objects.set(id, objs.map(clone));
}
/** A list endpoint served page by page. Each `versions` entry is one full listing (page 1 .. n). */
function lists(versions: Obj[][]) {
  let v = -1;
  return (params: Obj) => {
    if (!params?.starting_after) v = Math.min(v + 1, versions.length - 1);
    const pages = versions[v];
    if (!params?.starting_after) return clone(pages[0]);
    const i = pages.findIndex((p) => p.data.length && p.data[p.data.length - 1].id === params.starting_after);
    if (i < 0 || !pages[i + 1]) throw new Error(`test: no page after ${params.starting_after}`);
    return clone(pages[i + 1]);
  };
}
const calls = (op: string) => mockStripeCalls.filter((c) => c.op === op).map((c) => c.args);
const stripeOps = () => mockStripeCalls.map((c) => c.op);

function signedIn(memberships: Row[] = [personalMembership()]): void {
  mockGetUser.mockResolvedValue({
    data: { user: { id: FIXTURE_USER_ID, email: 'agent-3847@fixture.example.test', user_metadata: {} } },
  });
  mockEmulator.set({ columnPresent: true, rows: { organization_members: memberships } });
}

function givenSupportSession(): void {
  const expires = new Date(Date.now() + 3600_000).toISOString();
  mockCookie = signCookieValue(
    JSON.stringify({
      session_id: SESSION_ID,
      target_user_id: FIXTURE_USER_ID,
      admin_user_id: OTHER_USER,
      target_email: 'agent-3847@fixture.example.test',
      target_name: 'Target Fixture',
      expires_at: expires,
      started_at: new Date().toISOString(),
    })
  );
  mockSessionRow = { id: SESSION_ID, target_user_id: FIXTURE_USER_ID, status: 'active', session_expires_at: expires };
}

function seed(extra: Record<string, Row[]> = {}, isTest = true): void {
  mockDb = new BillingDb({
    organizations: [{ id: FIXTURE_PERSONAL_ORG_ID, personal_owner_user_id: FIXTURE_USER_ID, is_test: isTest }],
    stripe_customers: [{ user_id: FIXTURE_USER_ID, stripe_customer_id: CUS, default_payment_method_id: null, stripe_mode: 'test' }],
    ...extra,
  });
}
function mirrorRow(sub: Obj, over: Row = {}): Row {
  return {
    id: `row-${sub.id}`,
    stripe_mode: 'test',
    user_id: FIXTURE_USER_ID,
    organization_id: FIXTURE_PERSONAL_ORG_ID,
    stripe_customer_id: CUS,
    stripe_subscription_id: sub.id,
    ...mirrorState(sub as never),
    last_event_created: 1791000000,
    ...over,
  };
}
const dbWrites = () => mockDb.calls.filter((c) => c.op === 'insert' || c.op === 'update');

/** Run startAgentCheckout; a redirect() comes back as { redirect: url }. */
async function subscribe(interval: 'month' | 'year' = 'month'): Promise<Obj> {
  try {
    return (await startAgentCheckout(interval)) as Obj;
  } catch (e) {
    const digest = (e as { digest?: string }).digest;
    if (typeof digest === 'string' && digest.startsWith('NEXT_REDIRECT')) return { redirect: digest.split(';')[2] };
    throw e;
  }
}
function expectedCreate(anchor: string | null): [Obj, Obj] {
  return [
    buildSubscriptionCheckoutParams({
      customerId: CUS,
      priceId: PRICE.id,
      userId: FIXTURE_USER_ID,
      organizationId: FIXTURE_PERSONAL_ORG_ID,
      interval: 'month',
      returnBase: APP,
    }) as Obj,
    { idempotencyKey: agentIdempotencyKey({ userId: FIXTURE_USER_ID, mode: 'test', interval: 'month', anchorSessionId: anchor }) },
  ];
}

const OLD_ENV = { ...process.env };
beforeAll(() => {
  process.env.IMPERSONATION_COOKIE_SECRET = 'fixture-secret-3847';
});
afterAll(() => {
  process.env = OLD_ENV;
});
beforeEach(() => {
  jest.clearAllMocks();
  mockEmulator.reset();
  mockCookie = undefined;
  mockSessionRow = null;
  mockServiceTables.length = 0;
  mockStripeCalls.length = 0;
  mockHeaders = { host: 'app.keeprcompliance.com' };
  process.env.BILLING_ENABLED = 'true';
  process.env.STRIPE_SECRET_KEY = 'sk_test_fixture';
  process.env.NEXT_PUBLIC_APP_URL = APP;
  delete process.env.VERCEL_URL;
  delete process.env.VERCEL_BRANCH_URL;
  objects = new Map();
  seed();
  signedIn();
  mockStripeImpl = {
    'prices.list': async () => clone(PRICES),
    'subscriptions.retrieve': async (id) => {
      const q = objects.get(id as string);
      if (!q?.length) throw new Error(`test: no subscription re-fetch for ${id}`);
      return clone(q.length > 1 ? q.shift()! : q[0]);
    },
    'subscriptions.list': async () => clone(EMPTY_LIST),
    'checkout.sessions.list': lists([[fx('sessions-expired-p1'), fx('sessions-expired-p2')]]),
    // The API-made A/C fixtures: no Checkout session holds them.
    'checkout.sessions.list:subscription': async () => clone({ ...EMPTY_LIST, url: '/v1/checkout/sessions' }),
    'checkout.sessions.expire': async (id) => ({ id, status: 'expired' }),
    'checkout.sessions.create': async () => ({ ...clone(S1), id: 'cs_test_created', url: 'https://checkout.stripe.com/c/pay/created' }),
  };
});

// ---- Subscribe: refusals before Stripe -----------------------------------------------

describe('Subscribe: refused before any Stripe call', () => {
  it('C-IMP (startAgentCheckout): support session -> refused, zero Stripe calls, zero writes', async () => {
    givenSupportSession();
    expect(await subscribe()).toEqual({ error: 'Write operations are not allowed during impersonation sessions' });
    expect(stripeOps()).toEqual([]);
    expect(dbWrites()).toEqual([]);
    expect(mockServiceTables).toEqual(['impersonation_sessions']);
  });

  it('fixture check: the same caller without the support cookie reaches Stripe', async () => {
    mockStripeImpl['checkout.sessions.list'] = lists([[fx('sessions-expired-p1'), fx('sessions-expired-p2')]]);
    expect(await subscribe()).toEqual({ redirect: 'https://checkout.stripe.com/c/pay/created' });
  });

  it('C-FLAG: flag off -> refused, nothing read', async () => {
    process.env.BILLING_ENABLED = 'false';
    expect(await subscribe()).toEqual({ error: 'Billing is not available for this account.' });
    expect(mockServiceTables).toEqual([]);
    expect(mockEmulator.state.selects).toEqual([]);
    expect(stripeOps()).toEqual([]);
  });

  it.each([
    ['brokerage agent', [brokerageMembership('agent')]],
    ['brokerage admin', [brokerageMembership('admin')]],
  ])('C-CAPS-SRV: %s -> refused, no billing read, no Stripe call', async (_n, rows) => {
    signedIn(rows);
    expect(await subscribe()).toEqual({ error: 'Billing is not available for this account.' });
    expect(stripeOps()).toEqual([]);
    expect(mockServiceTables).toEqual([]);
  });

  it('C-CAPS-SRV: a caller whose mirror row is active -> refused (the hidden button is not the gate)', async () => {
    seed({ billing_subscriptions: [mirrorRow(C_KEEP)] });
    expect(await subscribe()).toEqual({ error: expect.stringContaining('not available for your plan') });
    expect(stripeOps()).toEqual([]);
  });

  // SR (PR #2986) should-fix: a sweep over every mirror row that has a plan, not one sample.
  it.each([
    ['trialing [EDITED status of sub-C-keep]', () => mirrorRow(C_KEEP, { status: 'trialing' })],
    ['cancel_pending (captured sub-C-cancel-at-period-end)', () => mirrorRow(C_PENDING)],
    ['past_due [EDITED status of sub-C-keep]', () => mirrorRow(C_KEEP, { status: 'past_due' })],
    ['unpaid [EDITED status of sub-C-keep]', () => mirrorRow(C_KEEP, { status: 'unpaid' })],
  ])('C-CAPS-SRV sweep: mirror row %s -> refused "not available right now", zero Stripe calls', async (_n, row) => {
    seed({ billing_subscriptions: [row()] });
    expect(await subscribe()).toEqual({ error: 'That change is not available for your plan right now. Refresh the page.' });
    expect(stripeOps()).toEqual([]);
  });

  it.each([
    ['prod shape {enabled:true}', { enabled: true }],
    ['{enabled:false}', { enabled: false }],
    ['past paid_through, no source', { enabled: true, paid_through: '2026-01-01T00:00:00Z' }],
  ])('C-SG (R4): non-stripe override %s -> refused, zero Stripe calls', async (_n, override) => {
    seed({ organization_plans: [{ organization_id: FIXTURE_PERSONAL_ORG_ID, feature_overrides: { unlimited_transactions: override } }] });
    expect(await subscribe()).toEqual({ error: expect.stringContaining('come from Keepr') });
    expect(stripeOps()).toEqual([]);
  });

  it('C-SG control: a stripe-sourced override is not a support grant', async () => {
    seed({
      organization_plans: [
        { organization_id: FIXTURE_PERSONAL_ORG_ID, feature_overrides: { unlimited_transactions: { enabled: true, source: 'stripe', paid_through: '2026-01-01T00:00:00Z' } } },
      ],
    });
    expect(await subscribe()).toHaveProperty('redirect');
  });

  it('C-SUSP (R4): a suspended licence row of ANY type (here team) -> refused, zero Stripe calls', async () => {
    seed({ licenses: [{ id: 'lic-1', user_id: FIXTURE_USER_ID, status: 'suspended', license_type: 'team' }] });
    expect(await subscribe()).toEqual({ error: 'Your account is suspended. Please contact support.' });
    expect(stripeOps()).toEqual([]);
  });

  it('C-MODE: test key + personal org not is_test -> refused before any Stripe call', async () => {
    seed({}, false);
    expect(await subscribe()).toEqual({ error: 'Payments are not available for this account.' });
    expect(stripeOps()).toEqual([]);
  });
});

// ---- Subscribe: Stripe-side state ---------------------------------------------------

describe('Subscribe: what Stripe already has', () => {
  it('C-LIVE: Stripe lists an active subscription (mirror empty) -> refused, no session', async () => {
    mockStripeImpl['subscriptions.list'] = lists([[fx('subs-L3-C-active')]]);
    expect(await subscribe()).toEqual({ error: 'You already have a plan. Refresh the page to see it.' });
    expect(calls('checkout.sessions.create')).toEqual([]);
  });

  // SR round 1: C-LIVE sampled `active` only. The mirror is empty (webhook lag) and Stripe holds a plan in
  // any of the five "already has a plan" statuses -> refused. A sweep, not a sample.
  it.each(['active', 'trialing', 'past_due', 'unpaid', 'paused'])(
    'C-LIVE sweep: real sub C with status %s [EDITED status] -> refused, no session, zero Stripe create calls',
    async (status) => {
      const page = clone(fx('subs-L3-C-active'));
      expect(page.data[0].status).toBe('active'); // the captured status; the others are [EDITED]
      page.data[0].status = status;
      mockStripeImpl['subscriptions.list'] = lists([[page]]);
      expect(await subscribe()).toEqual({ error: 'You already have a plan. Refresh the page to see it.' });
      expect(calls('checkout.sessions.create')).toEqual([]);
      expect(calls('customers.create')).toEqual([]);
      expect(stripeOps().filter((o) => o.endsWith('.create'))).toEqual([]);
    }
  );

  it('C-PAGE (subscriptions): the active one is item 11, past the first page -> found, refused', async () => {
    const [p1, p2] = [fx('subs-L4-p1'), fx('subs-L4-p2')];
    expect([p1.data.length, p1.has_more, p1.data.every((s: Obj) => s.status === 'incomplete_expired')]).toEqual([10, true, true]);
    expect(p2.data[0].status).toBe('active');
    mockStripeImpl['subscriptions.list'] = lists([[p1, p2]]);
    expect(await subscribe()).toEqual({ error: 'You already have a plan. Refresh the page to see it.' });
    expect(calls('checkout.sessions.create')).toEqual([]);
  });

  it('C-VOID (R1a): an incomplete subscription -> its unpaid invoice is voided (never cancel), then a session', async () => {
    expect(A.status).toBe('incomplete');
    mockStripeImpl['subscriptions.list'] = lists([[fx('subs-L1-A-incomplete')]]);
    serve(A.id, A_AFTER);
    mockStripeImpl['invoices.voidInvoice'] = async () => fx('inv-A-void');
    expect(await subscribe()).toEqual({ redirect: 'https://checkout.stripe.com/c/pay/created' });
    expect(calls('invoices.voidInvoice')).toEqual([[A.latest_invoice, {}, { idempotencyKey: `incomplete-void:${A.latest_invoice}` }]]);
    expect(calls('subscriptions.cancel')).toEqual([]);
  });

  it('C-VOID (R1a): Stripe refuses the void because it was paid meanwhile -> re-listed, "already have a plan", nothing cancelled', async () => {
    expect(C_INC.status).toBe('incomplete');
    const err = fx('inv-C-void-refused').error;
    mockStripeImpl['subscriptions.list'] = lists([[fx('subs-L2-C-incomplete')], [fx('subs-L3-C-active')]]);
    mockStripeImpl['invoices.voidInvoice'] = async () => {
      throw Object.assign(new Error(err.message), { type: 'StripeInvalidRequestError', rawType: err.type });
    };
    serve(C_INC.id, C_ACTIVE);
    expect(await subscribe()).toEqual({ error: 'You already have a plan. Refresh the page to see it.' });
    expect(calls('subscriptions.cancel')).toEqual([]);
    expect(calls('checkout.sessions.create')).toEqual([]);
    expect(calls('subscriptions.list')).toHaveLength(2);
  });

  // ---- BACKLOG-3847 QA3: the incomplete subscription was made BY Checkout -------------
  // Founder QA: 3DS failed inside Checkout, Subscribe again -> "Something went wrong".
  // Measured in TEST (fixtures/stripe/p3847-qa3, README): while the session that made
  // the subscription is open, Stripe refuses the void ("You cannot void an invoice
  // with an active checkout session"); expiring that session voids the invoice and
  // moves the subscription to incomplete_expired itself; a second void or a second
  // expire is refused as "not open".
  const FXQ = path.join(__dirname, '../../fixtures/stripe/p3847-qa3');
  const fxq = (n: string): Obj => JSON.parse(fs.readFileSync(path.join(FXQ, `${n}.json`), 'utf8'));
  const stripeErr = (n: string) => {
    const e = fxq(n).error;
    return Object.assign(new Error(e.message), { type: 'StripeInvalidRequestError', rawType: e.type });
  };
  /** Stripe as measured: the open session holds the invoice until it is expired. */
  function givenCheckoutMadeIncomplete(o: { expiredElsewhere?: 'before-list' | 'before-expire' } = {}) {
    const Q = fxq('sub-Q-incomplete');
    const CS = fxq('cs-Q-open');
    expect([Q.status, Q.customer, CS.status, CS.subscription, CS.invoice, CS.metadata.kind]).toEqual(['incomplete', CUS, 'open', Q.id, Q.latest_invoice, 'agent']);
    let expired = o.expiredElsewhere === 'before-list';
    const expire = () => {
      expired = true;
      serve(Q.id, fxq('sub-Q-after-expire'));
    };
    serve(Q.id, expired ? fxq('sub-Q-after-expire') : Q);
    mockStripeImpl['subscriptions.list'] = lists([[fxq('subs-by-customer-Q-incomplete')]]);
    // [COMPOSED] before expiry: the captured after-expiry by-subscription listing with
    // its one session swapped for the open capture of the same session.
    mockStripeImpl['checkout.sessions.list:subscription'] = async () => {
      const page = fxq('sessions-by-sub-Q-after-expire');
      if (expired) return page;
      if (o.expiredElsewhere === 'before-expire') expire(); // a concurrent request wins after our listing
      return { ...page, data: [clone(CS)] };
    };
    // By-customer listing for step 7: open before, the expire result after [COMPOSED envelope].
    mockStripeImpl['checkout.sessions.list'] = async () =>
      expired ? { ...fxq('sessions-by-customer-Q-open'), data: [fxq('cs-Q-expire')] } : fxq('sessions-by-customer-Q-open');
    mockStripeImpl['checkout.sessions.expire'] = async () => {
      if (expired) throw stripeErr('cs-Q-expire-refused-not-open');
      expire();
      return fxq('cs-Q-expire');
    };
    mockStripeImpl['invoices.voidInvoice'] = async () => {
      throw stripeErr(expired ? 'inv-Q-void-refused-not-open' : 'inv-Q-void-refused-open-session');
    };
    return { Q, CS };
  }

  it('C-QA3: the open session holding the incomplete invoice is expired BEFORE any void -> a fresh session, never reused', async () => {
    const { Q, CS } = givenCheckoutMadeIncomplete();
    expect(await subscribe()).toEqual({ redirect: 'https://checkout.stripe.com/c/pay/created' });
    const ops = stripeOps();
    expect(ops.indexOf('checkout.sessions.expire')).toBeGreaterThan(-1);
    expect(ops.indexOf('invoices.voidInvoice') === -1 || ops.indexOf('invoices.voidInvoice') > ops.indexOf('checkout.sessions.expire')).toBe(true);
    expect(calls('checkout.sessions.list:subscription')[0][0]).toEqual({ subscription: Q.id });
    expect(calls('checkout.sessions.expire')).toEqual([[CS.id]]);
    expect(calls('invoices.voidInvoice')).toEqual([]); // Stripe voided it on expiry (measured)
    expect(calls('subscriptions.cancel')).toEqual([]);
    expect(calls('checkout.sessions.create')).toEqual([expectedCreate(CS.id)]);
  });

  it('C-QA3-RACE1: a concurrent request expires the session between our listing and our expire -> refused expire is not an error', async () => {
    const { CS } = givenCheckoutMadeIncomplete({ expiredElsewhere: 'before-expire' });
    expect(await subscribe()).toEqual({ redirect: 'https://checkout.stripe.com/c/pay/created' });
    expect(calls('checkout.sessions.expire')).toEqual([[CS.id]]);
    expect(calls('invoices.voidInvoice')).toEqual([]);
  });

  it('C-QA3-RACE2: stale incomplete read, session already expired elsewhere -> void refused "not open" is success', async () => {
    givenCheckoutMadeIncomplete({ expiredElsewhere: 'before-list' });
    // [COMPOSED] the subscription listing still says incomplete (read before the other request ended it).
    expect(await subscribe()).toEqual({ redirect: 'https://checkout.stripe.com/c/pay/created' });
    expect(calls('checkout.sessions.expire')).toEqual([]);
    expect(calls('invoices.voidInvoice')).toHaveLength(1);
  });

  it('C-QA3-PAID: the session completes (paid) between our listing and our expire -> "already have a plan", no session, nothing cancelled', async () => {
    const { Q, CS } = givenCheckoutMadeIncomplete();
    // [COMPOSED] the paid subscription: the captured sub-Q-incomplete with status active.
    const paid = { ...clone(Q), status: 'active' };
    // [COMPOSED] the second listing: the captured by-customer listing with its one item paid.
    const listed = fxq('subs-by-customer-Q-incomplete');
    expect(listed.data.map((s: Obj) => [s.id, s.status])).toEqual([[Q.id, 'incomplete']]);
    mockStripeImpl['subscriptions.list'] = lists([[listed], [{ ...listed, data: [paid] }]]);
    // Stripe refuses the expire: the session is no longer open. The captured refusal
    // (cs-Q-expire-refused-not-open) names `expired`; for a paid session it would name `complete`.
    mockStripeImpl['checkout.sessions.expire'] = async () => {
      throw stripeErr('cs-Q-expire-refused-not-open');
    };
    serve(Q.id, paid);
    expect(await subscribe()).toEqual({ error: 'You already have a plan. Refresh the page to see it.' });
    expect(calls('checkout.sessions.expire')).toEqual([[CS.id]]);
    expect(calls('subscriptions.list')).toHaveLength(2);
    expect(calls('checkout.sessions.create')).toEqual([]);
    expect(calls('subscriptions.cancel')).toEqual([]);
    expect(calls('invoices.voidInvoice')).toEqual([]);
  });

  it('C-NOREUSE (R2): after ending an incomplete, the open same-interval session is expired, not reused', async () => {
    mockStripeImpl['subscriptions.list'] = lists([[fx('subs-L1-A-incomplete')]]);
    serve(A.id, A_AFTER);
    mockStripeImpl['invoices.voidInvoice'] = async () => fx('inv-A-void');
    mockStripeImpl['checkout.sessions.list'] = lists([[fx('sessions-open-p1'), fx('sessions-open-p2')]]);
    expect(await subscribe()).toEqual({ redirect: 'https://checkout.stripe.com/c/pay/created' });
    expect(calls('checkout.sessions.expire').map((a) => a[0]).sort()).toEqual([S0.id, S1.id].sort());
    expect(calls('checkout.sessions.create')).toEqual([expectedCreate(S1.id)]);
  });

  it('C-REUSE + C-EXP + C-PAGE (sessions): the open same-price session (page 2) is reused; the old-price one expired; pay-per-export untouched', async () => {
    const [p1, p2] = [fx('sessions-open-p1'), fx('sessions-open-p2')];
    expect([p1.data.length, p1.has_more, p1.data.every((s: Obj) => s.mode === 'payment')]).toEqual([10, true, true]);
    expect(p2.data.map((s: Obj) => s.id)).toEqual([p2.data[0].id, S1.id, S0.id]);
    mockStripeImpl['checkout.sessions.list'] = lists([[p1, p2]]);
    expect(await subscribe()).toEqual({ redirect: S1.url });
    expect(calls('checkout.sessions.create')).toEqual([]);
    expect(calls('checkout.sessions.expire')).toEqual([[S0.id]]);
  });

  it('C-REUSE price: only the OLD-price session S0 is open, same interval -> expired, a new session created, never reused', async () => {
    // [COMPOSED] a one-item listing holding only S0 (captured object: open, interval month, old price_id).
    expect([S0.status, S0.metadata.interval, S0.metadata.price_id === PRICE.id]).toEqual(['open', 'month', false]);
    mockStripeImpl['checkout.sessions.list'] = lists([[{ ...clone(EMPTY_LIST), url: '/v1/checkout/sessions', data: [clone(S0)] }]]);
    expect(await subscribe()).toEqual({ redirect: 'https://checkout.stripe.com/c/pay/created' });
    expect(calls('checkout.sessions.expire')).toEqual([[S0.id]]);
    expect(calls('checkout.sessions.create')).toEqual([expectedCreate(S0.id)]);
  });

  it('C-ANCHOR (R3): newest Agent session expired, none open -> key anchored on it, not "none"', async () => {
    const p2 = fx('sessions-expired-p2');
    expect(p2.data.find((s: Obj) => s.id === S1.id).status).toBe('expired');
    expect(await subscribe()).toEqual({ redirect: 'https://checkout.stripe.com/c/pay/created' });
    expect(calls('checkout.sessions.create')).toEqual([expectedCreate(S1.id)]);
    expect(calls('checkout.sessions.expire')).toEqual([]);
  });

  it('first ever Subscribe -> key anchored on "none"', async () => {
    mockStripeImpl['checkout.sessions.list'] = async () => clone({ ...EMPTY_LIST, url: '/v1/checkout/sessions' });
    await subscribe();
    expect(calls('checkout.sessions.create')).toEqual([expectedCreate(null)]);
  });

  it('C1 (server half): the Checkout URL is delivered by redirect(), not swallowed', async () => {
    let thrown: unknown;
    try {
      await startAgentCheckout('month');
    } catch (e) {
      thrown = e;
    }
    expect((thrown as { digest?: string })?.digest).toMatch(/^NEXT_REDIRECT;[a-z]+;https:\/\/checkout\.stripe\.com\/c\/pay\/created;/);
  });

  it('C-META (RC6, R11): the helper reproduces the captured TEST request; kind/user/org on both metadata blocks; a Price, never price_data', () => {
    const req = fx('cs-S1-open-request');
    const p = req.params;
    expect(buildSubscriptionCheckoutParams({
      customerId: p.customer,
      priceId: p.line_items[0].price,
      userId: p.metadata.user_id,
      organizationId: p.metadata.organization_id,
      interval: 'month',
      returnBase: APP,
    })).toEqual(p);
    for (const md of [p.metadata, p.subscription_data.metadata]) {
      expect(md).toMatchObject({ kind: 'agent', user_id: 'USER-3847', organization_id: 'ORG-P3847' });
    }
    expect(JSON.stringify(p)).not.toContain('price_data');
    // What Stripe stored on the session it created from those params.
    expect(S1.metadata).toMatchObject({ kind: 'agent', user_id: 'USER-3847', organization_id: 'ORG-P3847' });
    expect([S1.mode, S1.status, S1.subscription]).toEqual(['subscription', 'open', null]);
  });

  it('C-URL (R5): a forwarded host outside the allowlist -> success_url on NEXT_PUBLIC_APP_URL', async () => {
    mockHeaders = { host: 'x', 'x-forwarded-host': 'other.vercel.app' };
    await subscribe();
    expect(calls('checkout.sessions.create')[0][0].success_url).toMatch(/^https:\/\/app\.keeprcompliance\.com\/dashboard\/billing\?/);
  });

  it('C-URL (R5): the branch preview host (VERCEL_BRANCH_URL) -> success_url on that host', async () => {
    process.env.VERCEL_BRANCH_URL = 'keepr-git-feat-portal-x.vercel.app';
    mockHeaders = { 'x-forwarded-host': 'keepr-git-feat-portal-x.vercel.app' };
    await subscribe();
    expect(calls('checkout.sessions.create')[0][0].success_url).toMatch(/^https:\/\/keepr-git-feat-portal-x\.vercel\.app\/dashboard\/billing\?checkout=success&session_id=\{CHECKOUT_SESSION_ID\}$/);
  });
});

// ---- Cancel plan / Keep my plan --------------------------------------------------------

describe('Cancel plan and Keep my plan', () => {
  it('C-END + C-WT: ends at period end via update (never cancel); the mirror shows "ending" before any webhook', async () => {
    seed({ billing_subscriptions: [mirrorRow(C_KEEP)] });
    serve(C_KEEP.id, C_KEEP);
    mockStripeImpl['subscriptions.update'] = async () => clone(C_PENDING);
    expect(await endAgentPlanAtPeriodEnd()).toEqual({ ok: true });
    expect(calls('subscriptions.update')).toEqual([[C_KEEP.id, { cancel_at_period_end: true }]]);
    expect(calls('subscriptions.cancel')).toEqual([]);
    const row = mockDb.rows('billing_subscriptions')[0];
    expect(row).toMatchObject({ cancel_at_period_end: true, status: 'active', last_event_created: 1791000000 });
    const view = await getAgentPlanView(createServiceClient(), FIXTURE_USER_ID, 'test');
    expect(view.state).toBe('cancel_pending');
  });

  it('R6: the write-through touches only cancel_at_period_end and canceled_at, only on an active/trialing row', async () => {
    seed({ billing_subscriptions: [mirrorRow(C_KEEP)] });
    serve(C_KEEP.id, C_KEEP);
    mockStripeImpl['subscriptions.update'] = async () => clone(C_PENDING);
    await endAgentPlanAtPeriodEnd();
    const upd = mockDb.callsTo('billing_subscriptions', 'update');
    expect(upd).toHaveLength(1);
    expect(Object.keys(upd[0].payload as Row).sort()).toEqual(['cancel_at_period_end', 'canceled_at']);
    expect(upd[0].filters).toEqual([
      { op: 'eq', column: 'stripe_subscription_id', value: C_KEEP.id },
      { op: 'in', column: 'status', value: ['active', 'trialing'] },
    ]);
  });

  it('C-OWN: a subscription id in the request is ignored; only the caller\'s own row is ended', async () => {
    const other = mirrorRow({ ...C_KEEP, id: 'sub_OTHER_USER' }, { user_id: OTHER_USER, stripe_customer_id: 'cus_other', organization_id: null });
    seed({ billing_subscriptions: [mirrorRow(C_KEEP), other] });
    serve(C_KEEP.id, C_KEEP);
    serve('sub_OTHER_USER', { ...C_KEEP, id: 'sub_OTHER_USER' });
    mockStripeImpl['subscriptions.update'] = async (id) => ({ ...clone(C_PENDING), id });
    const fd = new FormData();
    fd.set('subscription_id', 'sub_OTHER_USER');
    await (endAgentPlanAtPeriodEnd as unknown as (f: FormData) => Promise<unknown>)(fd);
    expect(calls('subscriptions.update').map((a) => a[0])).toEqual([C_KEEP.id]);
    expect(mockDb.rows('billing_subscriptions').find((r) => r.user_id === OTHER_USER)).toMatchObject({ cancel_at_period_end: false });
  });

  // BACKLOG-3848 R5 (SR probe SR-PIN-142): pins the caps gate in endAgentPlanAtPeriodEnd. Without it
  // the Stripe status check alone decides, and a mirror that lags Stripe would be let through.
  it('C-PIN-142: past_due mirror, Stripe re-fetch says active -> End at period end refused by the caps gate, no update', async () => {
    seed({ billing_subscriptions: [mirrorRow(C_KEEP, { status: 'past_due' })] });
    serve(C_KEEP.id, C_KEEP); // [COMPOSED] mirror lags Stripe: Stripe already active
    const view = await getAgentPlanView(createServiceClient(), FIXTURE_USER_ID, 'test');
    expect(view.state).toBe('payment_failed');
    expect(await endAgentPlanAtPeriodEnd()).toHaveProperty('error');
    expect(calls('subscriptions.update')).toEqual([]);
  });

  it('End when Stripe already says it is ending -> refused, no update', async () => {
    seed({ billing_subscriptions: [mirrorRow(C_KEEP)] });
    serve(C_KEEP.id, C_PENDING);
    expect(await endAgentPlanAtPeriodEnd()).toHaveProperty('error');
    expect(calls('subscriptions.update')).toEqual([]);
  });

  it('Keep my plan: pending + period running -> update(cancel_at_period_end:false), mirror back to active', async () => {
    seed({ billing_subscriptions: [mirrorRow(C_PENDING)] });
    serve(C_PENDING.id, C_PENDING);
    mockStripeImpl['subscriptions.update'] = async () => clone(C_KEEP);
    expect(await keepAgentPlan()).toEqual({ ok: true });
    expect(calls('subscriptions.update')).toEqual([[C_PENDING.id, { cancel_at_period_end: false }]]);
    expect(mockDb.rows('billing_subscriptions')[0]).toMatchObject({ cancel_at_period_end: false, canceled_at: null });
  });

  it('C-KEEP: Keep on a plan that is not ending -> refused by the server-side capabilities, no Stripe call', async () => {
    seed({ billing_subscriptions: [mirrorRow(C_KEEP)] });
    expect(await keepAgentPlan()).toHaveProperty('error');
    expect(stripeOps()).toEqual([]);
  });

  it('C-KEEP: Keep after the period has ended -> refused, no update [EDITED: current_period_end moved into the past]', async () => {
    seed({ billing_subscriptions: [mirrorRow(C_PENDING)] });
    serve(C_PENDING.id, { ...C_PENDING, current_period_end: Math.floor(Date.now() / 1000) - 60 });
    expect(await keepAgentPlan()).toHaveProperty('error');
    expect(calls('subscriptions.update')).toEqual([]);
  });

  it.each([
    ['endAgentPlanAtPeriodEnd', () => endAgentPlanAtPeriodEnd()],
    ['keepAgentPlan', () => keepAgentPlan()],
    ['confirmAgentCheckout', () => confirmAgentCheckout(S1.id)],
  ] as [string, () => Promise<unknown>][])('C-IMP (%s): support session -> refused, zero Stripe calls, zero writes', async (_n, run) => {
    seed({ billing_subscriptions: [mirrorRow(C_PENDING)] });
    serve(C_PENDING.id, C_PENDING);
    mockStripeImpl['subscriptions.update'] = async () => clone(C_KEEP);
    givenSupportSession();
    expect(await run()).toEqual({ error: 'Write operations are not allowed during impersonation sessions' });
    expect(stripeOps()).toEqual([]);
    expect(dbWrites()).toEqual([]);
  });
});

// ---- Return from Checkout -------------------------------------------------------------

describe('confirmAgentCheckout (C-CONF, R8)', () => {
  // [EDITED] A completed session cannot be produced without card entry on the
  // hosted page (QA cell). This is the real open S1 with status/subscription set.
  const COMPLETE = { ...S1, status: 'complete', payment_status: 'paid', subscription: C_KEEP.id };

  it('complete Agent session of the caller -> mirror row inserted, cursor NULL, no grant, synthetic id', async () => {
    mockStripeImpl['checkout.sessions.retrieve'] = async () => clone(COMPLETE);
    serve(C_KEEP.id, C_KEEP);
    const info = jest.spyOn(console, 'info').mockImplementation(() => undefined);
    expect(await confirmAgentCheckout(S1.id)).toEqual({ ok: true });
    const rows = mockDb.rows('billing_subscriptions');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ stripe_subscription_id: C_KEEP.id, user_id: FIXTURE_USER_ID, status: 'active', last_event_created: null });
    info.mockRestore();
  });

  it.each([
    ['still open (real S1)', () => clone(S1)],
    ['another customer\'s session', () => ({ ...clone(COMPLETE), customer: 'cus_someone_else' })],
    ['not an Agent session (no kind)', () => ({ ...clone(COMPLETE), metadata: { user_id: 'USER-3847' } })],
    ['payment mode (real PAYG)', () => ({ ...fx('cs-payg-open'), status: 'complete' })],
  ])('%s -> refused, no mirror write', async (_n, session) => {
    mockStripeImpl['checkout.sessions.retrieve'] = async () => session();
    serve(C_KEEP.id, C_KEEP);
    expect(await confirmAgentCheckout(S1.id)).toHaveProperty('error');
    expect(dbWrites()).toEqual([]);
    expect(calls('subscriptions.retrieve')).toEqual([]);
  });

  it('a session id that is not one -> refused before Stripe', async () => {
    expect(await confirmAgentCheckout('../../v1/customers')).toHaveProperty('error');
    expect(stripeOps()).toEqual([]);
  });

  it('the stored customer row is read for the caller in this mode', async () => {
    mockStripeImpl['checkout.sessions.retrieve'] = async () => clone(COMPLETE);
    serve(C_KEEP.id, C_KEEP);
    await confirmAgentCheckout(S1.id);
    const read = mockDb.callsTo('stripe_customers', 'select')[0];
    expect([eqValue(read, 'user_id'), eqValue(read, 'stripe_mode')]).toEqual([FIXTURE_USER_ID, 'test']);
  });
});

// ---- BACKLOG-3848: Update card, End plan now, Edit contact ------------------------
//
// Objects: fixtures/stripe/p3848 (TEST, acacia; README). The setup session is the
// captured open one with `status` [EDITED] complete; its setup_intent answers the
// standalone succeeded SetupIntent of the same customer [COMPOSED].

const FX48 = path.join(__dirname, '../../fixtures/stripe/p3848');
const fx48 = (n: string): Obj => JSON.parse(fs.readFileSync(path.join(FX48, `${n}.json`), 'utf8'));
const CS48 = { ...fx48('pr2-cs-setup-open'), status: 'complete' }; // [EDITED]
const SI48 = fx48('pr2-seti-succeeded');
const SUB48 = fx48('pr2-sub-past_due');
const CUS48 = CS48.customer as string;
const IMP_ERROR = 'Write operations are not allowed during impersonation sessions';

async function caught(fn: () => Promise<unknown>): Promise<Obj> {
  try {
    return (await fn()) as Obj;
  } catch (e) {
    const digest = (e as { digest?: string }).digest;
    if (typeof digest === 'string' && digest.startsWith('NEXT_REDIRECT')) return { redirect: digest.split(';')[2] };
    throw e;
  }
}

const ACTIONS_3848: [string, () => Promise<unknown>][] = [
  ['startCardUpdate', () => startCardUpdate()],
  ['confirmCardUpdate', () => confirmCardUpdate(CS48.id)],
  ['endAgentPlanNow', () => endAgentPlanNow()],
  ['updateBillingContact', () => updateBillingContact({ name: 'Billing contact 3848', email: 'billing-3848@example.invalid' })],
];

describe('3848 actions: refused before any Stripe call', () => {
  it.each(ACTIONS_3848)('C-IMP (%s): support session -> refused, zero Stripe calls, zero writes', async (_n, fn) => {
    seed({ billing_subscriptions: [mirrorRow(SUB48, { status: 'past_due' })] });
    givenSupportSession();
    expect(await caught(fn)).toEqual({ error: IMP_ERROR });
    expect(stripeOps()).toEqual([]);
    expect(dbWrites()).toEqual([]);
    expect(mockServiceTables).toEqual(['impersonation_sessions']);
  });

  it.each(
    ACTIONS_3848.flatMap(([n, fn]) => [
      [n, 'brokerage agent', fn, [brokerageMembership('agent')]],
      [n, 'brokerage admin', fn, [brokerageMembership('admin')]],
      [n, 'brokerage it_admin', fn, [brokerageMembership('it_admin')]],
    ]) as [string, string, () => Promise<unknown>, Row[]][]
  )('C-SRV (%s): %s -> refused, no billing read, no Stripe call', async (_n, _who, fn, rows) => {
    signedIn(rows);
    expect(await caught(fn)).toEqual({ error: 'Billing is not available for this account.' });
    expect(stripeOps()).toEqual([]);
    expect(mockServiceTables).toEqual([]);
  });

  it.each([
    ['startCardUpdate', () => startCardUpdate()],
    ['updateBillingContact', () => updateBillingContact({ name: 'Pat', email: 'billing-3848@example.invalid' })],
    ['confirmCardUpdate', () => confirmCardUpdate(CS48.id)],
  ] as [string, () => Promise<unknown>][])(
    'C-MODE-GUARD / C-CONTACT-MODE (%s): test key + personal org not is_test -> refused before any Stripe call (no customer created)',
    async (_n, fn) => {
      seed({ stripe_customers: [] }, false);
      expect(await caught(fn)).toEqual({ error: 'Payments are not available for this account.' });
      expect(stripeOps()).toEqual([]);
      expect(mockDb.rows('stripe_customers')).toEqual([]);
    }
  );
});

describe('3848 Update card', () => {
  beforeEach(() => {
    seed({
      stripe_customers: [{ user_id: FIXTURE_USER_ID, stripe_customer_id: CUS48, default_payment_method_id: null, stripe_mode: 'test' }],
      billing_subscriptions: [mirrorRow(SUB48, { status: 'past_due', stripe_customer_id: CUS48 })],
    });
    mockStripeImpl['checkout.sessions.create'] = async () => ({ ...clone(fx48('pr2-cs-setup-open')), url: 'https://checkout.stripe.com/c/pay/setup' });
  });

  it('opens a setup-mode Stripe page for the caller\'s own customer; return URL carries the session id', async () => {
    expect(await caught(() => startCardUpdate())).toEqual({ redirect: 'https://checkout.stripe.com/c/pay/setup' });
    const [[params]] = calls('checkout.sessions.create');
    expect(params).toEqual({
      mode: 'setup',
      customer: CUS48,
      currency: 'usd',
      payment_method_types: ['card'],
      metadata: { kind: 'agent_card_update', user_id: FIXTURE_USER_ID },
      setup_intent_data: { metadata: { kind: 'agent_card_update', user_id: FIXTURE_USER_ID } },
      success_url: `${APP}/dashboard/billing?card=updated&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${APP}/dashboard/billing?card=cancelled`,
    });
  });

  it('no Stripe customer in this mode -> refused, nothing created', async () => {
    seed({ stripe_customers: [] });
    expect(await caught(() => startCardUpdate())).toEqual({ error: 'A card is saved at your first purchase in the Keepr app.' });
    expect(stripeOps()).toEqual([]);
  });

  it('confirm: a session id that is not one -> refused before Stripe', async () => {
    expect(await confirmCardUpdate('not-a-session')).toHaveProperty('error');
    expect(stripeOps()).toEqual([]);
  });

  it('confirm: a completed session of ANOTHER customer -> refused, nothing written', async () => {
    seed({ stripe_customers: [{ user_id: FIXTURE_USER_ID, stripe_customer_id: 'cus_EDITED_mine', default_payment_method_id: null, stripe_mode: 'test' }] });
    mockStripeImpl['checkout.sessions.retrieve'] = async () => clone(CS48);
    expect(await confirmCardUpdate(CS48.id)).toHaveProperty('error');
    expect(stripeOps()).toEqual(['checkout.sessions.retrieve']);
    expect(dbWrites()).toEqual([]);
  });

  it('confirm: the caller\'s completed session -> card saved, failed renewal paid, a notice for the person', async () => {
    mockStripeImpl['checkout.sessions.retrieve'] = async () => clone(CS48);
    mockStripeImpl['setupIntents.retrieve'] = async () => clone(SI48); // [COMPOSED]
    mockStripeImpl['customers.retrieve'] = async () => fx48('pr2-cus-update-default');
    mockStripeImpl['customers.update'] = async () => fx48('pr2-cus-update-default');
    serve(SUB48.id, SUB48, SUB48, fx48('pr2-sub-after-pay'));
    mockStripeImpl['subscriptions.update'] = async () => fx48('pr2-sub-update-default');
    mockStripeImpl['invoices.retrieve'] = async () => fx48('pr2-inv-open');
    mockStripeImpl['invoices.pay'] = async () => fx48('pr2-inv-paid');
    const r = await confirmCardUpdate(CS48.id);
    expect(r).toEqual({ ok: true, notice: expect.stringContaining('payment went through') });
    expect(calls('invoices.pay')).toHaveLength(1);
    expect(mockDb.rows('stripe_customers')[0].default_payment_method_id).toBe(SI48.payment_method);
  });
});

describe('3848 End plan now', () => {
  it('C-END-SCOPE: an active plan -> refused by the server-side capability, zero Stripe calls', async () => {
    seed({ billing_subscriptions: [mirrorRow(C_KEEP)] });
    expect(await endAgentPlanNow()).toEqual({ error: 'That change is not available for your plan right now. Refresh the page.' });
    expect(stripeOps()).toEqual([]);
  });

  it('a past_due plan of the caller -> voided, cancelled, mirror canceled; a subscription id in the request is impossible (no parameter)', async () => {
    seed({ billing_subscriptions: [mirrorRow(SUB48, { status: 'past_due' })] });
    serve(SUB48.id, SUB48);
    mockStripeImpl['invoices.list'] = async () => fx48('pr2-invoices-list-sub-open');
    mockStripeImpl['invoices.voidInvoice'] = async () => fx48('SR-VOID-inv-voided');
    mockStripeImpl['subscriptions.cancel'] = async () => ({ ...fx48('SR-VOID-sub-canceled'), id: SUB48.id }); // [COMPOSED]
    mockStripeImpl['invoices.retrieve'] = async () => fx48('SR-VOID-inv-voided'); // step-3 re-fetch of the latest invoice
    expect(await endAgentPlanNow()).toEqual({ ok: true });
    expect(stripeOps()).toEqual(['subscriptions.retrieve', 'invoices.list', 'invoices.voidInvoice', 'invoices.retrieve', 'subscriptions.cancel']);
    expect(mockDb.rows('billing_subscriptions')[0]).toMatchObject({ status: 'canceled', paused: false });
  });

  it('C-END-UNPAID (SR RC4): an unpaid plan [EDITED status unpaid] -> the support message (never "Refresh the page"), zero Stripe calls', async () => {
    seed({ billing_subscriptions: [mirrorRow(SUB48, { status: 'unpaid' })] });
    expect(await endAgentPlanNow()).toEqual({ error: 'Your plan has an unpaid bill. Please contact support to end it.' });
    expect(stripeOps()).toEqual([]);
  });

  it('paid in the meantime -> ok with a notice, nothing cancelled', async () => {
    seed({ billing_subscriptions: [mirrorRow(SUB48, { status: 'past_due' })] });
    serve(SUB48.id, SUB48);
    mockStripeImpl['invoices.list'] = async () => fx48('pr2-invoices-list-sub-open');
    mockStripeImpl['invoices.voidInvoice'] = async () => {
      throw Object.assign(new Error('Invoices with `paid` payments cannot be voided.'), { type: 'StripeInvalidRequestError' });
    };
    mockStripeImpl['invoices.retrieve'] = async () => fx48('pr2-inv-paid');
    expect(await endAgentPlanNow()).toEqual({ ok: true, notice: expect.stringContaining('payment went through') });
    expect(calls('subscriptions.cancel')).toEqual([]);
  });
});

describe('3848 Edit contact (C-CONTACT)', () => {
  it('updates the caller\'s own customer only; an id in the request is ignored', async () => {
    mockStripeImpl['customers.update'] = async () => fx48('pr2-cus-update-contact');
    const r = await updateBillingContact({ name: '  Billing contact 3848 ', email: 'billing-3848@example.invalid', customer: 'cus_EDITED_victim' } as never);
    expect(r).toEqual({ ok: true });
    expect(calls('customers.update')).toEqual([[CUS, { name: 'Billing contact 3848', email: 'billing-3848@example.invalid' }]]);
    expect(calls('customers.create')).toEqual([]);
  });

  it.each([
    ['empty email', { name: 'Pat', email: '' }],
    ['not an email', { name: 'Pat', email: 'not-an-email' }],
    ['name over 100', { name: 'x'.repeat(101), email: 'a@example.invalid' }],
  ])('validation: %s -> refused, zero Stripe calls', async (_n, input) => {
    expect(await updateBillingContact(input)).toHaveProperty('error');
    expect(stripeOps()).toEqual([]);
  });

  it('no customer yet in this (test-allowed) mode -> one customer created for the caller, then updated', async () => {
    seed({ stripe_customers: [] });
    mockStripeImpl['customers.create'] = async () => ({ ...fx48('pr2-cus-update-contact'), id: 'cus_EDITED_new' });
    mockStripeImpl['customers.update'] = async () => fx48('pr2-cus-update-contact');
    expect(await updateBillingContact({ name: 'Pat', email: 'billing-3848@example.invalid' })).toEqual({ ok: true });
    expect(stripeOps()).toEqual(['customers.create', 'customers.update']);
    expect(calls('customers.update')[0][0]).toBe('cus_EDITED_new');
  });
});
