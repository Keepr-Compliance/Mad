/**
 * @jest-environment node
 *
 * POST /api/payments/subscription-session and GET /api/billing/agent-prices —
 * BACKLOG-3676 (the Keepr desktop app starts the Agent plan Checkout).
 *
 * Real: the route, the membership classifier, the agent context core, the plan
 * view, billingCapabilities, the mode guard, the suspension reads, the Checkout
 * orchestration (prepareAgentCheckout) and the params builder.
 * Mocked: the two Supabase clients (an argument-applying BillingDb behind each:
 * one for the Bearer-token client, one for the service client), the Stripe
 * client (serving the TEST objects in fixtures/stripe/p3847, see its README),
 * Sentry. No network.
 */

import fs from 'fs';
import path from 'path';
import { BillingDb, type Row } from '../helpers/billingDb';
import {
  FIXTURE_BROKERAGE_ORG_ID,
  FIXTURE_OTHER_USER_ID,
  FIXTURE_PERSONAL_ORG_ID,
  FIXTURE_USER_ID,
  brokerageMembership,
  personalMembership,
  personalMembershipOwnedBy,
} from '../helpers/postgrestEmulator';

// ---- mocks -------------------------------------------------------------------

type Obj = Record<string, any>;
type Logged = { table: string; method: string; args: unknown[] };

let mockMemberDb: BillingDb;
let mockDb: BillingDb;
const mockMemberLog: Logged[] = [];
const mockServiceLog: Logged[] = [];
const mockClientOptions: Obj[] = [];
const mockRpc = jest.fn();
const mockGetUser = jest.fn();
const mockStripeCalls: { op: string; args: any[] }[] = [];
let mockStripeImpl: Record<string, (...a: any[]) => unknown> = {};

/** Every chained call on a BillingDb query is logged; the query itself does the filtering. */
function mockRecording(db: BillingDb, log: Logged[]) {
  return (table: string) => {
    log.push({ table, method: 'from', args: [table] });
    const q: any = db.from(table);
    const proxy: any = new Proxy(q, {
      get(target, prop) {
        const v = target[prop];
        if (typeof v !== 'function') return v;
        if (prop === 'then') return v.bind(target);
        return (...args: unknown[]) => {
          log.push({ table, method: String(prop), args });
          const r = v.apply(target, args);
          return r === target ? proxy : r;
        };
      },
    });
    return proxy;
  };
}

jest.mock('@sentry/nextjs', () => ({ captureMessage: jest.fn(), captureException: jest.fn() }));
jest.mock('@supabase/supabase-js', () => ({
  // Both the token verifier (lib/stripe.ts) and the Bearer membership reader build this client.
  createClient: (_url: string, _key: string, options: Obj) => {
    mockClientOptions.push(options);
    return { auth: { getUser: mockGetUser }, from: mockRecording(mockMemberDb, mockMemberLog) };
  },
}));
jest.mock('@/lib/supabase/service', () => ({
  createServiceClient: () => ({
    rpc: (...a: unknown[]) => mockRpc(...a),
    from: (t: string) => mockRecording(mockDb, mockServiceLog)(t),
  }),
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
      customers: { create: op('customers.create') },
      subscriptions: { list: op('subscriptions.list') },
      invoices: { voidInvoice: op('invoices.voidInvoice') },
      checkout: {
        sessions: {
          list: op('checkout.sessions.list'),
          expire: op('checkout.sessions.expire'),
          create: op('checkout.sessions.create'),
        },
      },
    })),
  };
});

import { POST } from '@/app/api/payments/subscription-session/route';
import { GET as GET_PRICES } from '@/app/api/billing/agent-prices/route';
import { PORTAL_MEMBERSHIP_SELECT } from '@/lib/auth/membership';
import { agentIdempotencyKey, buildSubscriptionCheckoutParams } from '@/lib/billing/agentCheckoutParams';
import { prepareAgentCheckout } from '@/lib/billing/agentCheckout';
import { agentContextForUser } from '@/lib/billing/agentContextCore';
import { classifyPortalAccess } from '@/lib/auth/membership';
import { mirrorState } from '@/lib/billing/sync';
import { BOOK_A_CALL_URL } from '@/lib/billing/bookCall';
import { getStripe } from '@/lib/stripe';

// ---- fixtures ------------------------------------------------------------------

const FX = path.join(__dirname, '../fixtures/stripe/p3847');
const fx = (n: string): Obj => JSON.parse(fs.readFileSync(path.join(FX, `${n}.json`), 'utf8'));
const clone = <T>(o: T): T => JSON.parse(JSON.stringify(o));

const CUS = fx('cus').id as string;
const PRICES = fx('prices-list-lookup');
const PRICE = PRICES.data[0];
const S1 = fx('cs-S1-open');
const S0 = fx('cs-S0-oldprice-open');
const C_KEEP = fx('sub-C-keep');
const EMPTY_LIST = { object: 'list', data: [], has_more: false, url: '/v1/subscriptions' };
const APP = 'https://app.keeprcompliance.com';
const TOKEN_A = 'fixture-jwt-caller';
const CREATED = 'https://checkout.stripe.com/c/pay/created';
const DESKTOP_SUCCESS = `${APP}/payments/complete?session={CHECKOUT_SESSION_ID}&kind=agent`;

/** Membership rows carry the base columns the read filters and orders on. */
function member(row: Row, createdAt: string): Row {
  return { ...row, created_at: createdAt };
}

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

function members(rows: Row[]): void {
  mockMemberDb = new BillingDb({ organization_members: rows });
}
function seed(extra: Record<string, Row[]> = {}, isTest = true): void {
  mockDb = new BillingDb({
    organizations: [{ id: FIXTURE_PERSONAL_ORG_ID, personal_owner_user_id: FIXTURE_USER_ID, is_test: isTest }],
    stripe_customers: [{ user_id: FIXTURE_USER_ID, stripe_customer_id: CUS, default_payment_method_id: null, stripe_mode: 'test' }],
    licenses: [{ id: 'lic-1', user_id: FIXTURE_USER_ID, status: 'active' }],
    ...extra,
  });
}
function mirrorRow(sub: Obj): Row {
  return {
    id: `row-${sub.id}`,
    stripe_mode: 'test',
    user_id: FIXTURE_USER_ID,
    organization_id: FIXTURE_PERSONAL_ORG_ID,
    stripe_customer_id: CUS,
    stripe_subscription_id: sub.id,
    ...mirrorState(sub as never),
    last_event_created: 1791000000,
  };
}

function post(opts: { token?: string | null; body?: unknown; headers?: Record<string, string> } = {}): Request {
  const headers: Record<string, string> = { host: 'app.keeprcompliance.com', 'content-type': 'application/json', ...opts.headers };
  const token = opts.token === undefined ? TOKEN_A : opts.token;
  if (token !== null) headers.authorization = `Bearer ${token}`;
  return new Request(`${APP}/api/payments/subscription-session`, {
    method: 'POST',
    headers,
    body: opts.body === undefined ? undefined : typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body),
  });
}
async function call(opts: Parameters<typeof post>[0] = {}): Promise<{ status: number; body: Obj }> {
  const res = await POST(post(opts));
  return { status: res.status, body: await res.json() };
}

function expectedCreate(anchor: string | null, base = APP): [Obj, Obj] {
  return [
    buildSubscriptionCheckoutParams({
      customerId: CUS,
      priceId: PRICE.id,
      userId: FIXTURE_USER_ID,
      organizationId: FIXTURE_PERSONAL_ORG_ID,
      interval: 'month',
      returnBase: base,
      origin: 'desktop',
    }) as Obj,
    { idempotencyKey: agentIdempotencyKey({ userId: FIXTURE_USER_ID, mode: 'test', interval: 'month', anchorSessionId: anchor, origin: 'desktop' }) },
  ];
}

const OLD_ENV = { ...process.env };
afterAll(() => {
  process.env = OLD_ENV;
});
beforeEach(() => {
  mockMemberLog.length = 0;
  mockServiceLog.length = 0;
  mockClientOptions.length = 0;
  mockStripeCalls.length = 0;
  mockRpc.mockReset();
  mockGetUser.mockReset();
  process.env.BILLING_ENABLED = 'true';
  process.env.STRIPE_SECRET_KEY = 'sk_test_fixture';
  process.env.NEXT_PUBLIC_APP_URL = APP;
  process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://fixture.supabase.invalid';
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'fixture-anon';
  delete process.env.VERCEL_URL;
  delete process.env.VERCEL_BRANCH_URL;
  mockGetUser.mockImplementation(async (jwt: string) =>
    jwt === TOKEN_A
      ? { data: { user: { id: FIXTURE_USER_ID, email: 'agent-3676@fixture.example.test' } }, error: null }
      : { data: { user: null }, error: { message: 'invalid JWT' } }
  );
  mockRpc.mockImplementation(async (fn: string) => (fn === 'billing_purchase_blocked' ? { data: false, error: null } : { data: null, error: null }));
  seed();
  members([member(personalMembership(), '2026-03-01T00:00:00Z')]);
  mockStripeImpl = {
    'prices.list': async () => clone(PRICES),
    'subscriptions.list': async () => clone(EMPTY_LIST),
    'checkout.sessions.list': lists([[fx('sessions-expired-p1'), fx('sessions-expired-p2')]]),
    'checkout.sessions.expire': async (id) => ({ id, status: 'expired' }),
    'checkout.sessions.create': async () => ({ ...clone(S1), id: 'cs_test_created', url: CREATED }),
    'customers.create': async () => ({ id: 'cus_created' }),
  };
});

// ---- C-ROUTE-REFUSE --------------------------------------------------------------

describe('C-ROUTE-REFUSE: each refusal, its status and code, and the Stripe calls made', () => {
  it('fixture check: the default caller (a personal owner, nothing bought) gets a Checkout URL', async () => {
    expect(await call()).toEqual({ status: 200, body: { checkout_url: CREATED } });
    expect(calls('checkout.sessions.create')).toEqual([expectedCreate(S1.id)]);
  });

  it('billing off -> 404 not_available; no token check, no read, no Stripe', async () => {
    process.env.BILLING_ENABLED = 'false';
    expect(await call()).toEqual({ status: 404, body: { code: 'not_available' } });
    expect(mockGetUser).not.toHaveBeenCalled();
    expect(mockServiceLog).toEqual([]);
    expect(stripeOps()).toEqual([]);
  });

  it.each([
    ['no Authorization header', null],
    ['an empty Bearer', ''],
    ['a token that does not verify', 'not-a-real-jwt'],
  ])('%s -> 401 unauthorized; no read, no Stripe', async (_label, token) => {
    expect(await call({ token })).toEqual({ status: 401, body: { code: 'unauthorized' } });
    expect(mockServiceLog).toEqual([]);
    expect(mockMemberLog).toEqual([]);
    expect(stripeOps()).toEqual([]);
  });

  it('mode guard: a test-mode deployment and a non-test personal organization -> 403 mode_refused', async () => {
    seed({}, false);
    expect(await call()).toEqual({ status: 403, body: { code: 'mode_refused' } });
    expect(stripeOps()).toEqual([]);
  });

  it('licence read fails -> 503 try_again (fails closed)', async () => {
    mockDb.failNext['licenses.select'] = { code: 'XX000', message: 'fixture: read failed' };
    expect(await call()).toEqual({ status: 503, body: { code: 'try_again' } });
    expect(stripeOps()).toEqual([]);
  });

  it('brokerage purchase-block read fails -> 503 try_again (fails closed)', async () => {
    mockRpc.mockImplementation(async () => ({ data: null, error: { message: 'fixture: rpc failed' } }));
    expect(await call()).toEqual({ status: 503, body: { code: 'try_again' } });
    expect(stripeOps()).toEqual([]);
  });

  it('licence suspended -> 403 suspended', async () => {
    seed({ licenses: [{ id: 'lic-1', user_id: FIXTURE_USER_ID, status: 'suspended' }] });
    expect(await call()).toEqual({ status: 403, body: { code: 'suspended' } });
    expect(stripeOps()).toEqual([]);
  });

  it('member of a purchase-blocked brokerage -> 403 suspended', async () => {
    mockRpc.mockImplementation(async (fn: string) => ({ data: fn === 'billing_purchase_blocked', error: null }));
    expect(await call()).toEqual({ status: 403, body: { code: 'suspended' } });
    expect(stripeOps()).toEqual([]);
  });

  it('membership read fails -> 503 try_again (never read as "no membership")', async () => {
    mockMemberDb.failNext['organization_members.select'] = { code: 'XX000', message: 'fixture: read failed' };
    expect(await call()).toEqual({ status: 503, body: { code: 'try_again' } });
    expect(stripeOps()).toEqual([]);
  });

  it.each([
    ['a licensed brokerage agent', 'agent'],
    ['a brokerage admin (full portal)', 'admin'],
  ])('%s, who also owns a personal organization -> 403 brokerage_managed', async (_label, role) => {
    members([
      member(brokerageMembership(role), '2026-01-01T00:00:00Z'),
      member(personalMembership(), '2026-03-01T00:00:00Z'),
    ]);
    expect(await call()).toEqual({ status: 403, body: { code: 'brokerage_managed' } });
    expect(stripeOps()).toEqual([]);
  });

  it('C7: a brokerage member with no license assigned -> 403 no_license', async () => {
    members([
      member({ ...brokerageMembership('agent'), license_status: 'unassigned' }, '2026-01-01T00:00:00Z'),
      member(personalMembership(), '2026-03-01T00:00:00Z'),
    ]);
    expect(await call()).toEqual({ status: 403, body: { code: 'no_license' } });
    expect(stripeOps()).toEqual([]);
  });

  it.each([
    ['no membership at all', [] as Row[]],
    ["only a member of somebody else's personal organization", [member(personalMembershipOwnedBy(), '2026-01-01T00:00:00Z')]],
    ['a deactivated brokerage member with no personal organization', [member({ ...brokerageMembership('agent'), license_status: 'expired' }, '2026-01-01T00:00:00Z')]],
  ])('%s -> 403 not_available', async (_label, rows) => {
    members(rows);
    expect(await call()).toEqual({ status: 403, body: { code: 'not_available' } });
    expect(stripeOps()).toEqual([]);
  });

  it('already on the plan (the mirror row is active) -> 409 already_have_plan, no Stripe call', async () => {
    seed({ billing_subscriptions: [mirrorRow(C_KEEP)] });
    expect(await call()).toEqual({ status: 409, body: { code: 'already_have_plan' } });
    expect(stripeOps()).toEqual([]);
  });

  it('already on the plan in Stripe, mirror not written yet -> 409 already_have_plan; listed, nothing created', async () => {
    mockStripeImpl['subscriptions.list'] = async () => ({ ...clone(EMPTY_LIST), data: [clone(C_KEEP)] });
    expect(await call()).toEqual({ status: 409, body: { code: 'already_have_plan' } });
    expect(stripeOps()).toEqual(['prices.list', 'subscriptions.list']);
    expect(calls('checkout.sessions.create')).toEqual([]);
  });

  it('support grant (a non-Stripe Unlimited override) -> 409 already_have_plan, no Stripe call', async () => {
    seed({
      organization_plans: [
        { organization_id: FIXTURE_PERSONAL_ORG_ID, feature_overrides: { unlimited_transactions: { enabled: true, source: 'support' } } },
      ],
    });
    expect(await call()).toEqual({ status: 409, body: { code: 'already_have_plan' } });
    expect(stripeOps()).toEqual([]);
  });

  it('no Agent price on sale -> 503 price_unavailable; prices listed, nothing created', async () => {
    mockStripeImpl['prices.list'] = async () => ({ ...clone(PRICES), data: [] });
    expect(await call()).toEqual({ status: 503, body: { code: 'price_unavailable' } });
    expect(stripeOps()).toEqual(['prices.list']);
  });

  it('Stripe refuses the create (e.g. an idempotency error) -> 502 try_again, one create attempted', async () => {
    mockStripeImpl['checkout.sessions.create'] = async () => {
      throw Object.assign(new Error('Keys for idempotent requests can only be used with the same parameters'), { type: 'StripeIdempotencyError' });
    };
    expect(await call()).toEqual({ status: 502, body: { code: 'try_again' } });
    expect(calls('checkout.sessions.create')).toHaveLength(1);
  });

  it('happy path -> 200 { checkout_url } only, one create, no store', async () => {
    const res = await POST(post());
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(await res.json()).toEqual({ checkout_url: CREATED });
    expect(calls('checkout.sessions.create')).toHaveLength(1);
  });
});

// ---- C4 + S4: the body is never read -------------------------------------------------

describe('C4 / S4: the verified token decides; nothing in the body is used', () => {
  const B = FIXTURE_OTHER_USER_ID;

  it('a body naming user B, a price, an interval and a return URL -> every read is for A, the session is A\'s monthly desktop one', async () => {
    const body = {
      user_id: B,
      userId: B,
      price_id: 'price_attacker',
      interval: 'year',
      success_url: 'https://evil.example/steal',
      return_url: 'https://evil.example/steal',
      origin: 'web',
    };
    expect(await call({ body })).toEqual({ status: 200, body: { checkout_url: CREATED } });
    // Every user filter on either client is A's.
    const userFilters = [...mockMemberLog, ...mockServiceLog].filter(
      (l) => l.method === 'eq' && (l.args[0] === 'user_id' || l.args[0] === 'personal_owner_user_id')
    );
    expect(userFilters.length).toBeGreaterThanOrEqual(5);
    expect(new Set(userFilters.map((l) => l.args[1]))).toEqual(new Set([FIXTURE_USER_ID]));
    expect(mockRpc.mock.calls).toEqual([['billing_purchase_blocked', { p_user: FIXTURE_USER_ID }]]);
    expect(calls('checkout.sessions.create')).toEqual([expectedCreate(S1.id)]);
  });

  it('a body that is not JSON is ignored too (it is never parsed)', async () => {
    expect(await call({ body: '{not json' })).toEqual({ status: 200, body: { checkout_url: CREATED } });
  });
});

// ---- C-OWN-MEMBERSHIP + the Bearer client ------------------------------------------------

describe('C-OWN-MEMBERSHIP: the membership read is the caller\'s own rows, on the caller\'s token', () => {
  /*
   * RLS does NOT filter organization_members by user: policy
   * organization_members_select_public also returns every row of the caller's own
   * organizations (get_user_org_ids). So a co-member's row in the caller's
   * brokerage IS returned to the Bearer client, and the .eq('user_id', ...) on
   * the query is the guard. The other user's row below is in the SAME brokerage
   * as the caller, i.e. a row RLS would return.
   *
   * classifyPortalAccess takes the first brokerage row. Unfiltered, that is the
   * other user's earlier SUSPENDED row, which (being deactivated) falls through
   * to the caller's own personal organization: a licensed brokerage member would
   * be classified as a personal owner and allowed to subscribe.
   */
  const TABLE: Row[] = [
    member({ ...brokerageMembership('agent', 'post', FIXTURE_OTHER_USER_ID), id: 'm-other', license_status: 'suspended' }, '2026-01-01T00:00:00Z'),
    member({ ...brokerageMembership('agent'), id: 'm-caller' }, '2026-02-01T00:00:00Z'),
    member(personalMembership(), '2026-03-01T00:00:00Z'),
  ];

  it('fixture check: both brokerage rows are in the same organization', () => {
    expect(TABLE.slice(0, 2).map((r) => r.organization_id)).toEqual([FIXTURE_BROKERAGE_ORG_ID, FIXTURE_BROKERAGE_ORG_ID]);
  });

  it('caller (active brokerage member who also owns a personal org) -> 403 brokerage_managed, no Stripe', async () => {
    members(TABLE);
    expect(await call()).toEqual({ status: 403, body: { code: 'brokerage_managed' } });
    expect(stripeOps()).toEqual([]);
  });

  it('positive control: the same table classifies the OTHER user on their own row (deactivated)', () => {
    const own = TABLE.filter((r) => r.user_id === FIXTURE_OTHER_USER_ID);
    expect(classifyPortalAccess(own as never, FIXTURE_OTHER_USER_ID)).toMatchObject({ kind: 'floor', via: 'deactivated' });
  });

  it('the read: PORTAL_MEMBERSHIP_SELECT, filtered to the caller, ordered created_at then id, no limit or single', async () => {
    await call();
    const reads = mockMemberLog.filter((l) => l.table === 'organization_members');
    expect(reads.map((l) => [l.method, ...l.args])).toEqual([
      ['from', 'organization_members'],
      ['select', PORTAL_MEMBERSHIP_SELECT],
      ['eq', 'user_id', FIXTURE_USER_ID],
      ['order', 'created_at', { ascending: true }],
      ['order', 'id', { ascending: true }],
    ]);
  });

  it('the read runs on a client carrying the caller\'s token; the service client never reads memberships', async () => {
    await call();
    expect(mockClientOptions.some((o) => o?.global?.headers?.Authorization === `Bearer ${TOKEN_A}`)).toBe(true);
    expect(mockServiceLog.filter((l) => l.table === 'organization_members')).toEqual([]);
    expect(mockMemberLog.filter((l) => l.method === 'from').map((l) => l.table)).toEqual(['organization_members']);
  });
});

// ---- the core, directly -------------------------------------------------------------------

describe('agentContextForUser (the core shared with the website action)', () => {
  const svc = () => ({ rpc: mockRpc, from: (t: string) => mockRecording(mockDb, mockServiceLog)(t) }) as never;
  const run = (rows: Row[] | null) =>
    agentContextForUser({
      userId: FIXTURE_USER_ID,
      email: null,
      access: classifyPortalAccess(rows as never, FIXTURE_USER_ID),
      service: svc(),
      mode: 'test',
    });

  it('personal owner -> a context with the plan view', async () => {
    const ctx = await run([personalMembership()]);
    expect('refusal' in ctx).toBe(false);
    expect(ctx).toMatchObject({ userId: FIXTURE_USER_ID, view: { state: 'none' }, caps: { kind: 'personal', canPurchase: true } });
  });
  it.each([
    ['brokerage member', [brokerageMembership('agent')], 'brokerage_managed'],
    ['unassigned brokerage member', [{ ...brokerageMembership('agent'), license_status: 'unassigned' }], 'no_license'],
    ['no membership', [], 'not_available'],
    ['rows null (read error)', null, 'try_again'],
  ])('%s -> refusal %s, before any billing read', async (_l, rows, code) => {
    expect(await run(rows as Row[] | null)).toEqual({ refusal: code });
    expect(mockServiceLog).toEqual([]);
  });
});

// ---- C-RETURN, S3, S5, C-REUSE-ORIGIN ----------------------------------------------------

describe('C-RETURN / S3: where Checkout sends the browser back', () => {
  it('desktop session returns through /payments/complete with kind=agent; cancel through /payments/cancelled', async () => {
    await call();
    const [params] = calls('checkout.sessions.create')[0];
    expect(params.success_url).toBe(DESKTOP_SUCCESS);
    expect(params.cancel_url).toBe(`${APP}/payments/cancelled?kind=agent`);
    expect(params.metadata.origin).toBe('desktop');
    expect(params.subscription_data.metadata).not.toHaveProperty('origin');
    expect(params.mode).toBe('subscription');
  });

  it('S3: a hostile Host / X-Forwarded-Host -> the fallback base, never the request host', async () => {
    await call({ headers: { host: 'evil.example', 'x-forwarded-host': 'evil.example' } });
    expect(calls('checkout.sessions.create')[0][0].success_url).toBe(DESKTOP_SUCCESS);
  });

  it('S3: the allow-listed branch preview host -> that host', async () => {
    process.env.VERCEL_BRANCH_URL = 'keepr-git-feat-portal-x.vercel.app';
    await call({ headers: { 'x-forwarded-host': 'keepr-git-feat-portal-x.vercel.app' } });
    expect(calls('checkout.sessions.create')[0][0].success_url).toBe(
      'https://keepr-git-feat-portal-x.vercel.app/payments/complete?session={CHECKOUT_SESSION_ID}&kind=agent'
    );
  });
});

describe('S5: the idempotency key carries the origin for the desktop only', () => {
  it('web key is byte-identical to the pinned TEST request; desktop key differs only by the suffix', () => {
    const pinned = fx('cs-S1-open-request').key as string;
    const anchor = pinned.split(':').slice(4).join(':');
    const web = agentIdempotencyKey({ userId: 'USER-3847', mode: 'test', interval: 'month', anchorSessionId: anchor });
    const desktop = agentIdempotencyKey({ userId: 'USER-3847', mode: 'test', interval: 'month', anchorSessionId: anchor, origin: 'desktop' });
    expect(web).toBe(pinned);
    expect(desktop).toBe(`${pinned}:desktop`);
  });

  it('web params are byte-identical to the pinned TEST request; desktop params differ only in origin and return URLs', () => {
    const p = fx('cs-S1-open-request').params;
    const input = {
      customerId: p.customer,
      priceId: p.line_items[0].price,
      userId: p.metadata.user_id,
      organizationId: p.metadata.organization_id,
      interval: 'month' as const,
      returnBase: APP,
    };
    expect(buildSubscriptionCheckoutParams(input)).toEqual(p);
    expect(buildSubscriptionCheckoutParams({ ...input, origin: 'desktop' })).toEqual({
      ...p,
      metadata: { ...p.metadata, origin: 'desktop' },
      success_url: DESKTOP_SUCCESS,
      cancel_url: `${APP}/payments/cancelled?kind=agent`,
    });
  });
});

describe('C-REUSE-ORIGIN: an open session is reused only by the side that opened it', () => {
  // Captured listing while S1 (website, current price) and S0 (old price) were open.
  const OPEN = () => lists([[fx('sessions-open-p1'), fx('sessions-open-p2')]]);
  /** [EDITED] the captured listing with S1 marked as a desktop session. */
  const OPEN_DESKTOP = () => {
    const p2 = fx('sessions-open-p2');
    p2.data = p2.data.map((s: Obj) => (s.id === S1.id ? { ...s, metadata: { ...s.metadata, origin: 'desktop' } } : s));
    return lists([[fx('sessions-open-p1'), p2]]);
  };

  it('desktop click with an open WEBSITE session -> it is expired, a new desktop session created', async () => {
    mockStripeImpl['checkout.sessions.list'] = OPEN();
    expect(await call()).toEqual({ status: 200, body: { checkout_url: CREATED } });
    expect(calls('checkout.sessions.expire').map((a) => a[0]).sort()).toEqual([S0.id, S1.id].sort());
    expect(calls('checkout.sessions.create')).toEqual([expectedCreate(S1.id)]);
  });

  it('positive control: desktop click with an open DESKTOP session -> reused, nothing created', async () => {
    mockStripeImpl['checkout.sessions.list'] = OPEN_DESKTOP();
    expect(await call()).toEqual({ status: 200, body: { checkout_url: S1.url } });
    expect(calls('checkout.sessions.create')).toEqual([]);
    expect(calls('checkout.sessions.expire')).toEqual([[S0.id]]);
  });

  it('website click with an open DESKTOP session -> it is expired, never reused', async () => {
    mockStripeImpl['checkout.sessions.list'] = OPEN_DESKTOP();
    const result = await prepareAgentCheckout({
      stripe: getStripe(),
      mode: 'test',
      customerId: CUS,
      priceId: PRICE.id,
      userId: FIXTURE_USER_ID,
      organizationId: FIXTURE_PERSONAL_ORG_ID,
      interval: 'month',
      returnBase: APP,
    });
    expect(result).toEqual({ url: CREATED });
    expect(calls('checkout.sessions.expire').map((a) => a[0]).sort()).toEqual([S0.id, S1.id].sort());
  });
});

// ---- GET /api/billing/agent-prices -----------------------------------------------------------

describe('GET /api/billing/agent-prices', () => {
  async function prices(opts: { token?: string | null; query?: string } = {}): Promise<{ status: number; body: Obj; res: Response }> {
    const token = opts.token === undefined ? TOKEN_A : opts.token;
    const res = await GET_PRICES(
      new Request(`${APP}/api/billing/agent-prices${opts.query ?? ''}`, { headers: token === null ? {} : { authorization: `Bearer ${token}` } })
    );
    return { status: res.status, body: await res.json(), res };
  }

  it('billing off -> 404 not_available, no token check, no Stripe', async () => {
    process.env.BILLING_ENABLED = 'false';
    expect((await prices()).status).toBe(404);
    expect(mockGetUser).not.toHaveBeenCalled();
    expect(stripeOps()).toEqual([]);
  });

  it.each([[null], ['not-a-real-jwt']])('token %p -> 401 unauthorized, no Stripe', async (token) => {
    const { status, body } = await prices({ token });
    expect([status, body]).toEqual([401, { code: 'unauthorized' }]);
    expect(stripeOps()).toEqual([]);
  });

  it('S1: the captured TEST price -> $19.99, from Stripe by lookup key; booking URL from the server; no store', async () => {
    const { status, body, res } = await prices();
    expect(status).toBe(200);
    expect(body).toEqual({ month: { display: '$19.99', unitAmount: 1999, currency: 'usd' }, bookCallUrl: BOOK_A_CALL_URL });
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(calls('prices.list')).toEqual([[{ lookup_keys: ['agent_month_usd', 'agent_year_usd'], active: true }]]);
  });

  it('S1: [EDITED] the same price at 2499 -> $24.99 (the amount is the server\'s, not a constant)', async () => {
    mockStripeImpl['prices.list'] = async () => ({ ...clone(PRICES), data: [{ ...clone(PRICE), unit_amount: 2499 }] });
    expect((await prices()).body.month).toEqual({ display: '$24.99', unitAmount: 2499, currency: 'usd' });
  });

  it('S4: query parameters are ignored; only the monthly price is offered even when a yearly one exists', async () => {
    mockStripeImpl['prices.list'] = async () => ({
      ...clone(PRICES),
      data: [
        clone(PRICE),
        // [EDITED] a yearly twin of the captured price
        { ...clone(PRICE), id: 'price_year_fixture', lookup_key: 'agent_year_usd', unit_amount: 19900, recurring: { ...PRICE.recurring, interval: 'year' } },
      ],
    });
    const { body } = await prices({ query: '?interval=year&user_id=someone-else&price=1' });
    expect(Object.keys(body).sort()).toEqual(['bookCallUrl', 'month']);
    expect(body.month.display).toBe('$19.99');
  });

  it('no Agent price on sale -> month null', async () => {
    mockStripeImpl['prices.list'] = async () => ({ ...clone(PRICES), data: [] });
    expect((await prices()).body).toEqual({ month: null, bookCallUrl: BOOK_A_CALL_URL });
  });

  it('Stripe fails -> 502 try_again', async () => {
    mockStripeImpl['prices.list'] = async () => {
      throw new Error('fixture: stripe down');
    };
    const { status, body } = await prices();
    expect([status, body]).toEqual([502, { code: 'try_again' }]);
  });
});
