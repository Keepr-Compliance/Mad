/**
 * /dashboard/billing — BACKLOG-3844 (SR R1, R2; controls C4, C5).
 *
 * The page is the gate. Middleware lets any request with an impersonation
 * cookie through without reading membership (middleware.ts), and the sidebar
 * entry is presentation only, so this file invokes the REAL page directly.
 *
 * NOTHING BELOW THE SUPABASE CLIENTS IS MOCKED. In particular the real
 * getImpersonationSession runs: a support session here is a cookie signed with
 * the real signCookieValue, in the shape app/auth/impersonate/route.ts writes,
 * validated against an impersonation_sessions row. The session client is the
 * transcribed PostgREST emulator the BACKLOG-3080 suites use.
 */

import {
  FIXTURE_PERSONAL_ORG_ID,
  FIXTURE_USER_ID,
  brokerageMembership,
  createPostgrestEmulator,
  personalMembership,
  type Row,
} from '../../../helpers/postgrestEmulator';

const mockEmulator = createPostgrestEmulator();
const mockGetUser = jest.fn();
// BACKLOG-3848: get_credit_balance on the SESSION client (recorded with its args).
const mockSessionRpc = jest.fn();
let mockReadFails = false;
let mockCookie: string | undefined;
let mockSessionRow: Record<string, unknown> | null = null;
const mockServiceTables: string[] = [];
// Assigned in beforeEach; the service mock reads it lazily.
let mockBillingDb: BillingDb;

jest.mock('next/headers', () => ({
  cookies: async () => ({
    get: (name: string) => (name === 'impersonation_session' && mockCookie ? { value: mockCookie } : undefined),
    set: jest.fn(),
  }),
}));

jest.mock('@/lib/supabase/server', () => ({
  createClient: jest.fn(async () => ({
    auth: { getUser: mockGetUser },
    rpc: (...a: unknown[]) => mockSessionRpc(...a),
    from: (table: string) => {
      const chain = mockEmulator.from(table);
      if (mockReadFails && table === 'organization_members') {
        (chain as { then: unknown }).then = (ok: (r: unknown) => unknown, ko?: (e: unknown) => unknown) =>
          Promise.resolve({ data: null, error: { code: 'PGRST000', message: 'fixture' }, status: 503 }).then(ok, ko);
      }
      return chain;
    },
  })),
}));

/**
 * The service client. impersonation_sessions: a recording stub (the emulator
 * has no `.gt`) serving the one session row. Every other table (the 3847
 * Agent plan reads, only after the page admitted the caller) goes to an
 * argument-applying BillingDb.
 */
const mockServiceRpc = jest.fn(async () => ({ data: 999, error: null }));
jest.mock('@/lib/supabase/service', () => ({
  createServiceClient: jest.fn(() => ({
    rpc: (...a: unknown[]) => mockServiceRpc(...(a as [])),
    from: (table: string) => {
      mockServiceTables.push(table);
      if (table !== 'impersonation_sessions') return mockBillingDb.from(table);
      const q: Record<string, unknown> = {};
      for (const m of ['select', 'eq', 'in', 'gt', 'order', 'limit']) q[m] = jest.fn(() => q);
      q.single = jest.fn(async () =>
        table === 'impersonation_sessions' && mockSessionRow
          ? { data: mockSessionRow, error: null }
          : { data: null, error: { code: 'PGRST116', message: 'fixture: no rows' } }
      );
      q.maybeSingle = q.single;
      return q;
    },
  })),
}));

// BACKLOG-3847: the Agent prices, from the TEST lookup-key list (fixtures/stripe/p3847).
const mockPricesList = jest.fn();
// BACKLOG-3848: every Stripe method the page may reach, each a resolving recorder, so a
// call the page must never make (customers.create) RUNS and is counted instead of
// throwing a TypeError that the fail-soft reads would swallow.
const mockStripe = {
  customersRetrieve: jest.fn(),
  customersCreate: jest.fn(),
  customersUpdate: jest.fn(),
  subscriptionsRetrieve: jest.fn(),
  invoicesList: jest.fn(),
  chargesList: jest.fn(),
  paymentMethodsRetrieve: jest.fn(),
};
jest.mock('stripe', () => ({
  __esModule: true,
  default: jest.fn().mockImplementation(() => ({
    prices: { list: (...a: unknown[]) => mockPricesList(...a) },
    customers: {
      retrieve: (...a: unknown[]) => mockStripe.customersRetrieve(...a),
      create: (...a: unknown[]) => mockStripe.customersCreate(...a),
      update: (...a: unknown[]) => mockStripe.customersUpdate(...a),
    },
    subscriptions: { retrieve: (...a: unknown[]) => mockStripe.subscriptionsRetrieve(...a) },
    invoices: { list: (...a: unknown[]) => mockStripe.invoicesList(...a) },
    charges: { list: (...a: unknown[]) => mockStripe.chargesList(...a) },
    paymentMethods: { retrieve: (...a: unknown[]) => mockStripe.paymentMethodsRetrieve(...a) },
  })),
}));
// The page renders the Agent plan buttons; their server actions are not under test here.
jest.mock('@/lib/actions/agentPlan', () => ({
  startAgentCheckout: jest.fn(),
  endAgentPlanAtPeriodEnd: jest.fn(),
  keepAgentPlan: jest.fn(),
  confirmAgentCheckout: jest.fn(async () => ({ ok: true })),
  endAgentPlanNow: jest.fn(),
}));
// BACKLOG-3848 card and contact buttons; their server actions are tested in billingCard.test.ts.
jest.mock('@/lib/actions/billingCard', () => ({
  startCardUpdate: jest.fn(),
  confirmCardUpdate: jest.fn(async () => ({ ok: true })),
  updateBillingContact: jest.fn(),
}));
jest.mock('next/cache', () => ({ revalidatePath: jest.fn() }));

class Redirect extends Error {
  constructor(public readonly to: string) {
    super('NEXT_REDIRECT');
  }
}
class NotFound extends Error {
  constructor() {
    super('NEXT_NOT_FOUND');
  }
}
jest.mock('next/navigation', () => ({
  redirect: (to: string) => {
    throw new Redirect(to);
  },
  notFound: () => {
    throw new NotFound();
  },
  useRouter: () => ({ refresh: jest.fn() }),
}));

import fs from 'fs';
import path from 'path';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { confirmAgentCheckout, startAgentCheckout } from '@/lib/actions/agentPlan';
import { BillingDb, eqValue } from '../../../helpers/billingDb';
import { mirrorState } from '@/lib/billing/sync';
import BillingRoute from '@/app/dashboard/billing/page';
import { BillingPage } from '@/components/billing/BillingPage';
import { BOOK_A_CALL_URL } from '@/lib/billing/bookCall';
import { getImpersonationSession } from '@/lib/impersonation';
import { signCookieValue } from '@/lib/cookie-signing';

const second = (row: Row): Row => ({ ...row, id: `${row.id as string}-second` });

/** pii-allow-uuid: invented, not from any live row. */
const SESSION_ID = '00000000-3844-4000-8000-000000000001';
/** pii-allow-uuid: invented, not from any live row. */
const TARGET_USER_ID = '00000000-3844-4000-8000-000000000002';
/** pii-allow-uuid: invented, not from any live row. */
const STAFF_ADMIN_ID = '00000000-3844-4000-8000-000000000003';

const inOneHour = () => new Date(Date.now() + 60 * 60 * 1000).toISOString();

/**
 * A support session as app/auth/impersonate/route.ts writes it: the same
 * seven fields, signed with the real signer, and the row the helper selects
 * (`id, target_user_id, status, session_expires_at`).
 */
function givenSupportSession(): void {
  const expires = inOneHour();
  mockCookie = signCookieValue(
    JSON.stringify({
      session_id: SESSION_ID,
      target_user_id: TARGET_USER_ID,
      admin_user_id: STAFF_ADMIN_ID,
      target_email: 'target-3844@fixture.example.test',
      target_name: 'Target Fixture',
      expires_at: expires,
      started_at: new Date().toISOString(),
    })
  );
  mockSessionRow = { id: SESSION_ID, target_user_id: TARGET_USER_ID, status: 'active', session_expires_at: expires };
}

function given(memberships: Row[], readFails = false): void {
  mockGetUser.mockResolvedValue({
    data: { user: { id: FIXTURE_USER_ID, email: 'billing-fixture-3844@fixture.example.test', user_metadata: {} } },
  });
  mockReadFails = readFails;
  mockEmulator.set({ columnPresent: true, rows: { organization_members: memberships } });
}

type Outcome = { redirect: string } | { notFound: true } | { element: string };
async function run(): Promise<Outcome> {
  try {
    const el = await BillingRoute({});
    return { element: el.type === BillingPage ? 'BillingPage' : String(el.type) };
  } catch (e) {
    if (e instanceof Redirect) return { redirect: e.to };
    if (e instanceof NotFound) return { notFound: true };
    throw e;
  }
}

/** The h2 of every block, in render order. */
async function renderedBlocks(): Promise<string[]> {
  const { container, unmount } = render(await BillingRoute({}));
  const titles = within(container)
    .getAllByRole('heading', { level: 2 })
    .map((h) => h.textContent ?? '');
  unmount();
  return titles;
}

const sessionTablesRead = () => Array.from(new Set(mockEmulator.state.selects.map((s) => s.table))).sort();

const FX3847 = path.join(__dirname, '../../../fixtures/stripe/p3847');
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const fx3847 = (n: string): any => JSON.parse(fs.readFileSync(path.join(FX3847, `${n}.json`), 'utf8'));
const PRICES_LIST = fx3847('prices-list-lookup');
const FX3848 = path.join(__dirname, '../../../fixtures/stripe/p3848');
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const fx3848 = (n: string): any => JSON.parse(fs.readFileSync(path.join(FX3848, `${n}.json`), 'utf8'));
const stripeCalls = () => Object.values(mockStripe).reduce((n, f) => n + f.mock.calls.length, 0);

const OLD_FLAG = process.env.BILLING_ENABLED;
const OLD_SECRET = process.env.IMPERSONATION_COOKIE_SECRET;

beforeAll(() => {
  process.env.IMPERSONATION_COOKIE_SECRET = 'fixture-secret-3844';
});
afterAll(() => {
  if (OLD_SECRET === undefined) delete process.env.IMPERSONATION_COOKIE_SECRET;
  else process.env.IMPERSONATION_COOKIE_SECRET = OLD_SECRET;
  if (OLD_FLAG === undefined) delete process.env.BILLING_ENABLED;
  else process.env.BILLING_ENABLED = OLD_FLAG;
});
beforeEach(() => {
  jest.clearAllMocks();
  mockEmulator.reset();
  mockReadFails = false;
  mockCookie = undefined;
  mockSessionRow = null;
  mockServiceTables.length = 0;
  process.env.BILLING_ENABLED = 'true';
  process.env.STRIPE_SECRET_KEY = 'sk_test_fixture';
  mockBillingDb = new BillingDb({ organizations: [{ id: FIXTURE_PERSONAL_ORG_ID, personal_owner_user_id: FIXTURE_USER_ID, is_test: true }] });
  mockPricesList.mockResolvedValue(PRICES_LIST);
  mockSessionRpc.mockResolvedValue({ data: 0, error: null });
  mockStripe.customersCreate.mockResolvedValue({ id: 'cus_EDITED_created', object: 'customer' });
  mockStripe.customersRetrieve.mockResolvedValue(fx3848('cus-expand-pm'));
  mockStripe.subscriptionsRetrieve.mockResolvedValue(fx3848('sub-pastdue-expand-pm'));
  mockStripe.invoicesList.mockResolvedValue(fx3848('invoices-list-after-pay'));
  mockStripe.chargesList.mockResolvedValue(fx3848('charges-list-after-pay'));
  mockStripe.paymentMethodsRetrieve.mockResolvedValue(fx3848('pm-good'));
});

// ---------------------------------------------------------------------------
// R1 — who the page admits (flag on, no support session)
// ---------------------------------------------------------------------------

describe('R1: the page refuses on its own', () => {
  it.each([
    ['brokerage agent', [brokerageMembership('agent')], false],
    ['[agent, broker] (two brokerage rows)', [brokerageMembership('agent'), second(brokerageMembership('broker'))], false],
    ['[brokerage agent, personal-org owner]', [brokerageMembership('agent'), personalMembership()], false],
    ['membership read failed (admin rows)', [brokerageMembership('admin')], true],
    ['no membership', [], false],
  ] as [string, Row[], boolean][])('%s -> 404, nothing but the membership read, no write', async (_n, rows, readFails) => {
    given(rows, readFails);
    expect(await run()).toEqual({ notFound: true });
    expect(sessionTablesRead()).toEqual(['licenses', 'organization_members']);
    expect(mockEmulator.state.writes).toEqual([]);
  });

  it('not signed in -> /login', async () => {
    given([]);
    mockGetUser.mockResolvedValue({ data: { user: null } });
    expect(await run()).toEqual({ redirect: '/login' });
  });

  // Exact block titles, transcribed from the step-0 truth table rows 1 and 11
  // (every organization in 3844 has no billing deal yet: Managed by Keepr).
  it.each([
    [
      'personal-org owner',
      [personalMembership()],
      // BACKLOG-3848: pay as you go reads "Receipts".
      ['Your plan', 'Choose a plan', 'Credits', 'Payment method & billing contact', 'Receipts'],
      'Solo, pay as you go',
    ],
    ['brokerage broker', [brokerageMembership('broker')], ['Your plan', 'Seats & licenses'], 'Managed by Keepr'],
    ['brokerage admin', [brokerageMembership('admin')], ['Your plan', 'Seats & licenses'], 'Managed by Keepr'],
    ['brokerage it_admin', [brokerageMembership('it_admin')], ['Your plan', 'Seats & licenses'], 'Managed by Keepr'],
  ] as [string, Row[], string[], string][])('%s -> rendered with exactly its blocks', async (_n, rows, blocks, planLine) => {
    given(rows);
    expect(await run()).toEqual({ element: 'BillingPage' });
    given(rows);
    expect(await renderedBlocks()).toEqual(blocks);
    given(rows);
    const { container, unmount } = render(await BillingRoute({}));
    expect(container.textContent).toContain(planLine);
    if (rows[0] === undefined || (rows[0] as Row).role !== 'agent') {
      // No amount of money anywhere on an organization page (3844).
      expect(container.textContent).not.toMatch(/\$|USD|\/mo/);
    } else {
      // BACKLOG-3847: the only amount is the Stripe Price's ($19.99 TEST).
      expect(container.textContent).toContain('$19.99');
    }
    unmount();
    expect(mockEmulator.state.writes).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// R2 / C4 — a support session is refused even when the browser also holds a
// full-portal session of its own.
// ---------------------------------------------------------------------------

describe('BACKLOG-3878: a suspended brokerage member is sent to My Account by the page itself', () => {
  // Session-side licence row: the value both suspension writers set.
  it.each(['broker', 'admin', 'it_admin'])('suspended %s -> /dashboard/account, no billing read', async (role) => {
    given([brokerageMembership(role)]);
    mockEmulator.set({ rows: { organization_members: [brokerageMembership(role)], licenses: [{ user_id: FIXTURE_USER_ID, status: 'suspended' }] } });
    await expect(BillingRoute({})).rejects.toEqual(new Redirect('/dashboard/account'));
    expect(stripeCalls()).toBe(0);
  });

  it('control: the same broker, licence active -> the organization page renders', async () => {
    given([brokerageMembership('broker')]);
    mockEmulator.set({ rows: { organization_members: [brokerageMembership('broker')], licenses: [{ user_id: FIXTURE_USER_ID, status: 'active' }] } });
    const el = await BillingRoute({});
    expect(el).toBeTruthy();
  });
});

describe('R2: a support session never sees billing', () => {
  it('fixture check: the real helper accepts this session', async () => {
    givenSupportSession();
    expect(await getImpersonationSession()).toMatchObject({ session_id: SESSION_ID, target_user_id: TARGET_USER_ID });
  });

  it('fixture check: the same signed-in admin without the cookie gets the page', async () => {
    given([brokerageMembership('admin')]);
    expect(await run()).toEqual({ element: 'BillingPage' });
    expect(sessionTablesRead()).toEqual(['licenses', 'organization_members']);
  });

  it.each([
    ['a full-portal admin', [brokerageMembership('admin')]],
    ['a personal-org owner', [personalMembership()]],
  ] as [string, Row[]][])('support session + %s signed in -> 404, no membership or billing read', async (_n, rows) => {
    given(rows);
    givenSupportSession();
    expect(await run()).toEqual({ notFound: true });
    expect(mockEmulator.state.selects).toEqual([]);
    expect(mockServiceTables).toEqual(['impersonation_sessions']);
    expect(mockEmulator.state.writes).toEqual([]);
  });

  // A cookie the helper rejects is no session at all: the page's own access
  // check decides, which is why that check is the gate (middleware passed it).
  it.each([
    ['brokerage agent', [brokerageMembership('agent')], { notFound: true }],
    ['brokerage admin', [brokerageMembership('admin')], { element: 'BillingPage' }],
  ] as [string, Row[], Outcome][])('an unsigned impersonation cookie + %s -> the access rule decides', async (_n, rows, outcome) => {
    given(rows);
    mockCookie = JSON.stringify({ session_id: SESSION_ID, target_user_id: TARGET_USER_ID });
    expect(await run()).toEqual(outcome);
    expect(mockServiceTables).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// C5 — the flag: only the exact string 'true' opens the page, for anyone.
// ---------------------------------------------------------------------------

describe('C5: BILLING_ENABLED', () => {
  const FLAG_VALUES: [string, string | undefined, boolean][] = [
    ['unset', undefined, false],
    ["'false'", 'false', false],
    ["'1'", '1', false],
    ["'TRUE'", 'TRUE', false],
    ["''", '', false],
    ["'true'", 'true', true],
  ];
  const PEOPLE: [string, Row[]][] = [
    ['brokerage admin', [brokerageMembership('admin')]],
    ['personal-org owner', [personalMembership()]],
  ];
  const cases = FLAG_VALUES.flatMap(([label, value, open]) =>
    PEOPLE.map(([who, rows]) => [label, who, value, open, rows] as const)
  );

  it.each(cases)('flag %s, %s -> open %s', async (_label, _who, value, open, rows) => {
    if (value === undefined) delete process.env.BILLING_ENABLED;
    else process.env.BILLING_ENABLED = value;
    given([...rows]);
    if (open) {
      expect(await run()).toEqual({ element: 'BillingPage' });
    } else {
      expect(await run()).toEqual({ notFound: true });
      // Off is decided before anything is read.
      expect(mockEmulator.state.selects).toEqual([]);
      expect(mockServiceTables).toEqual([]);
    }
  });

  it('NEXT_PUBLIC_BILLING_ENABLED alone does not open the page: 404, nothing read', async () => {
    const old = process.env.NEXT_PUBLIC_BILLING_ENABLED;
    try {
      process.env.NEXT_PUBLIC_BILLING_ENABLED = 'true';
      delete process.env.BILLING_ENABLED;
      given([brokerageMembership('admin')]);
      expect(await run()).toEqual({ notFound: true });
      expect(mockEmulator.state.selects).toEqual([]);
      expect(mockServiceTables).toEqual([]);
    } finally {
      if (old === undefined) delete process.env.NEXT_PUBLIC_BILLING_ENABLED;
      else process.env.NEXT_PUBLIC_BILLING_ENABLED = old;
    }
  });

  it('flag off beats a support session: 404 before the session is read', async () => {
    process.env.BILLING_ENABLED = 'false';
    given([brokerageMembership('admin')]);
    givenSupportSession();
    expect(await run()).toEqual({ notFound: true });
    expect(mockServiceTables).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// BACKLOG-3847 — blocks 1 and 2 from the Agent plan view. Mirror rows are
// mirrorState() of real TEST re-fetches (fixtures/stripe/p3847).
// ---------------------------------------------------------------------------

describe('3847: personal plan blocks', () => {
  function seedSub(name: string, over: Record<string, unknown> = {}): void {
    const sub = fx3847(name);
    mockBillingDb.rows('billing_subscriptions').push({
      stripe_mode: 'test',
      user_id: FIXTURE_USER_ID,
      stripe_subscription_id: sub.id,
      ...mirrorState(sub),
      ...over,
    });
  }
  function seedOverride(o: unknown): void {
    mockBillingDb.rows('organization_plans').push({
      organization_id: FIXTURE_PERSONAL_ORG_ID,
      feature_overrides: { unlimited_transactions: o },
    });
  }
  async function text(params?: Record<string, string>): Promise<{ text: string; titles: string[]; buttons: string[] }> {
    given([personalMembership()]);
    const el = await BillingRoute(params ? { searchParams: Promise.resolve(params) } : {});
    const { container, unmount } = render(el);
    const out = {
      text: container.textContent ?? '',
      titles: within(container).getAllByRole('heading', { level: 2 }).map((h) => h.textContent ?? ''),
      buttons: within(container).queryAllByRole('button').map((b) => b.textContent ?? ''),
    };
    unmount();
    return out;
  }
  const day = (sec: number) =>
    new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' }).format(new Date(sec * 1000));

  it('3848: back from the card page (?card=updated&session_id=) -> confirmCardUpdate(session id) runs once, status line shown', async () => {
    const { confirmCardUpdate } = jest.requireMock('@/lib/actions/billingCard') as { confirmCardUpdate: jest.Mock };
    const r = await text({ card: 'updated', session_id: 'cs_test_FIXTURE' });
    expect(confirmCardUpdate).toHaveBeenCalledWith('cs_test_FIXTURE');
    expect(confirmCardUpdate).toHaveBeenCalledTimes(1);
    expect(r.text).toMatch(/Saving your new card|Your card is updated/);
  });

  it('3848: ?card=cancelled -> "Your card was not changed.", nothing confirmed', async () => {
    const { confirmCardUpdate } = jest.requireMock('@/lib/actions/billingCard') as { confirmCardUpdate: jest.Mock };
    const r = await text({ card: 'cancelled' });
    expect(r.text).toContain('Your card was not changed.');
    expect(confirmCardUpdate).not.toHaveBeenCalled();
  });

  it('C-ST: active + cancel_at_period_end (canceled_at set by Stripe) -> "Cancels <date>", Keep my plan, no plan choice', async () => {
    const sub = fx3847('sub-C-cancel-at-period-end');
    expect([sub.status, sub.cancel_at_period_end, typeof sub.canceled_at]).toEqual(['active', true, 'number']);
    seedSub('sub-C-cancel-at-period-end');
    const r = await text();
    expect(r.text).toContain(`Cancels ${day(sub.current_period_end)}`);
    expect(r.text).toContain('Access until');
    expect(r.buttons).toEqual(['Keep my plan', 'Edit contact']); // + block 5 Edit contact (BACKLOG-3848)
    expect(r.titles).not.toContain('Choose a plan');
  });

  it('active plan -> Renews on <date>, Cancel plan, no plan choice', async () => {
    const sub = fx3847('sub-C-keep');
    seedSub('sub-C-keep');
    const r = await text();
    expect(r.text).toContain('Renews on');
    expect(r.text).toContain(day(sub.current_period_end));
    expect(r.buttons).toEqual(['Cancel plan', 'Edit contact']); // + block 5 Edit contact (BACKLOG-3848)
    expect(r.titles).toEqual(['Your plan', 'Credits', 'Payment method & billing contact', 'Invoices']);
  });

  it('Book a Call links to the onboarding booking page, in a new tab', async () => {
    given([personalMembership()]);
    const { container, unmount } = render(await BillingRoute({}));
    const link = within(container).getByRole('link', { name: 'Book a Call' });
    expect(link.getAttribute('href')).toBe(BOOK_A_CALL_URL);
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toBe('noopener noreferrer');
    unmount();
  });

  it('pay as you go: exactly one Subscribe button on the page (the Agent card), none in Your plan, and no Subscribe again', async () => {
    given([personalMembership()]);
    const { container, unmount } = render(await BillingRoute({}));
    const subs = within(container).queryAllByRole('button').filter((b) => (b.textContent ?? '').startsWith('Subscribe —'));
    expect(subs).toHaveLength(1);
    expect(within(container.querySelector('[data-billing-block="plan"]') as HTMLElement).queryAllByRole('button')).toHaveLength(0);
    expect(container.querySelector('[data-plan="agent"]')?.contains(subs[0])).toBe(true);
    unmount();
  });

  it('payment did not go through: block 1 has Subscribe again next to the note, plus the Agent card Subscribe', async () => {
    seedSub('sub-A-incomplete');
    given([personalMembership()]);
    const { container, unmount } = render(await BillingRoute({}));
    const plan = container.querySelector('[data-billing-block="plan"]') as HTMLElement;
    const again = within(plan).getAllByRole('button');
    expect(again.map((b) => b.textContent)).toEqual(['Subscribe again — $19.99/month']);
    expect(plan.querySelector('[role="status"]')?.parentElement?.contains(again[0])).toBe(true);
    const all = within(container).queryAllByRole('button').filter((b) => (b.textContent ?? '').startsWith('Subscribe'));
    expect(all.map((b) => b.textContent)).toEqual(['Subscribe again — $19.99/month', 'Subscribe — $19.99/month']);
    (startAgentCheckout as jest.Mock).mockClear();
    fireEvent.click(again[0]);
    await waitFor(() => expect(startAgentCheckout).toHaveBeenCalledWith('month'));
    unmount();
  });

  it('back from Checkout with an incomplete subscription: Your plan has no Subscribe again (the return panel owns that moment)', async () => {
    seedSub('sub-A-incomplete');
    given([personalMembership()]);
    const { container, unmount } = render(
      await BillingRoute({ searchParams: Promise.resolve({ checkout: 'success', session_id: 'cs_test_x' }) })
    );
    await screen.findByText((t) => t.includes('Finishing your subscription') || t.includes("Your last payment didn't go through"));
    const plan = container.querySelector('[data-billing-block="plan"]') as HTMLElement;
    expect(plan).not.toBeNull();
    expect(within(plan).queryAllByRole('button').filter((b) => (b.textContent ?? '').startsWith('Subscribe again'))).toHaveLength(0);
    unmount();
  });

  it('a half-made (incomplete) subscription reads as no plan: Subscribe is offered', async () => {
    seedSub('sub-A-incomplete');
    const r = await text();
    expect(r.titles).toContain('Choose a plan');
    expect(r.buttons).toContain('Subscribe — $19.99/month');
  });

  it.each([
    ['prod shape {enabled:true}', { enabled: true }, 'Unlimited exports, provided by Keepr.'],
    ['past paid_through, no source', { enabled: true, paid_through: '2026-01-01T00:00:00Z' }, 'Contact support'],
  ])('R4 page: support grant %s -> no Subscribe, %s', async (_n, override, line) => {
    seedOverride(override);
    const r = await text();
    expect(r.text).toContain(line);
    expect(r.buttons.filter((b) => b.startsWith('Subscribe'))).toEqual([]);
    expect(r.titles).not.toContain('Choose a plan');
  });

  it('a stripe-sourced override with no mirror row is not a support grant: Subscribe offered', async () => {
    seedOverride({ enabled: true, paid_through: '2026-12-01T00:00:00Z', source: 'stripe' });
    expect((await text()).titles).toContain('Choose a plan');
  });

  it('C-PRICE: the amount is the Stripe Price unit_amount, annual only when agent_year_usd exists [EDITED: amounts/year]', async () => {
    const month = { ...PRICES_LIST.data[0], unit_amount: 2499 };
    mockPricesList.mockResolvedValue({ ...PRICES_LIST, data: [month] });
    let r = await text();
    expect(r.buttons).toEqual(['Subscribe — $24.99/month', 'Edit contact']); // + block 5 Edit contact (BACKLOG-3848)
    expect(r.text).not.toMatch(/year/i);

    const year = { ...month, id: 'price_EDITED_year', unit_amount: 19900, lookup_key: 'agent_year_usd', recurring: { ...month.recurring, interval: 'year' } };
    mockPricesList.mockResolvedValue({ ...PRICES_LIST, data: [month, year] });
    r = await text();
    expect(r.buttons).toContain('Subscribe yearly — $199.00/year');
  });

  it('prices unavailable -> the page renders and nothing can be bought', async () => {
    mockPricesList.mockRejectedValue(new Error('stripe down'));
    const r = await text();
    expect(r.text).toContain('Not available right now.');
    expect(r.buttons.filter((b) => b.startsWith('Subscribe'))).toEqual([]);
  });

  it('back from Checkout before the webhook -> "Finishing your subscription…"; cancelled -> nothing charged', async () => {
    expect((await text({ checkout: 'success', session_id: 'cs_test_x' })).text).toContain('Finishing your subscription');
    expect((await text({ checkout: 'cancelled' })).text).toContain('Nothing was charged.');
  });

  // Founder decision (BACKLOG-3847, 2026-10-12): an incomplete subscription is a payment that did not go through.
  const INCOMPLETE_NOTE = "Your last payment didn't go through. You haven't been charged. Subscribe again to try another card.";
  const CONFIRMING = 'Your payment is being confirmed';

  it('C-INC-NOTE: an incomplete mirror row -> "Your last payment didn\'t go through", never "being confirmed"; Subscribe still offered', async () => {
    expect(fx3847('sub-A-incomplete').status).toBe('incomplete');
    seedSub('sub-A-incomplete');
    const r = await text();
    expect(r.text).toContain(INCOMPLETE_NOTE);
    expect(r.text).not.toContain(CONFIRMING);
    expect(r.text).toContain('Solo, pay as you go');
    expect(r.titles).toContain('Choose a plan');
    expect(r.buttons.some((b) => b.startsWith('Subscribe'))).toBe(true);
  });

  it('C-INC-NOTE control: no incomplete row -> no note', async () => {
    seedSub('sub-A-incomplete', { status: 'incomplete_expired' }); // [EDITED status] the row after the session expired
    expect((await text()).text).not.toContain(INCOMPLETE_NOTE);
  });

  async function returnFails(): Promise<string> {
    (confirmAgentCheckout as jest.Mock).mockResolvedValueOnce({ error: 'refused' });
    given([personalMembership()]);
    const { container, unmount } = render(
      await BillingRoute({ searchParams: Promise.resolve({ checkout: 'success', session_id: 'cs_test_x' }) })
    );
    await screen.findByText((t) => t.includes(CONFIRMING) || t.includes(INCOMPLETE_NOTE));
    const out = container.textContent ?? '';
    unmount();
    return out;
  }

  it('C-INC-NOTE (return): back from Checkout, confirm refused, subscription incomplete -> the new note, not "being confirmed"', async () => {
    seedSub('sub-A-incomplete');
    const t = await returnFails();
    expect(t).toContain(INCOMPLETE_NOTE);
    expect(t).not.toContain(CONFIRMING);
  });

  it('C-INC-NOTE (return) control: confirm refused, no incomplete row -> "being confirmed" is unchanged', async () => {
    const t = await returnFails();
    expect(t).toContain(CONFIRMING);
    expect(t).not.toContain(INCOMPLETE_NOTE);
  });

  it('the plan reads are keyed to the signed-in user and the deployment mode', async () => {
    await text();
    const subRead = mockBillingDb.callsTo('billing_subscriptions', 'select')[0];
    expect(eqValue(subRead, 'user_id')).toBe(FIXTURE_USER_ID);
    expect(eqValue(subRead, 'stripe_mode')).toBe('test');
    expect(mockBillingDb.calls.filter((c) => c.op !== 'select')).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// BACKLOG-3848 — blocks 4–6 and the payment-failed banner (read only).
// Stripe objects: fixtures/stripe/p3848 (TEST producers, README).
// ---------------------------------------------------------------------------

describe('3848: credits, payment & contact, receipts / invoices', () => {
  const SIGN_IN = 'billing-fixture-3844@fixture.example.test';
  const CUS = fx3848('cus-expand-pm');
  const SUB = fx3848('sub-pastdue-expand-pm');

  function seedCustomer(over: Record<string, unknown> = {}): void {
    mockBillingDb.rows('stripe_customers').push({
      user_id: FIXTURE_USER_ID,
      stripe_customer_id: CUS.id,
      stripe_mode: 'test',
      default_payment_method_id: null,
      ...over,
    });
  }
  /** Mirror row from the TEST re-fetch, as the webhook writes it (mirrorState). */
  function seedMirror(sub: Record<string, unknown>): void {
    mockBillingDb.rows('billing_subscriptions').push({
      stripe_mode: 'test',
      user_id: FIXTURE_USER_ID,
      stripe_subscription_id: sub.id,
      ...mirrorState(sub as never),
    });
  }
  async function page(rows: Row[] = [personalMembership()]) {
    given(rows);
    const { container, unmount } = render(await BillingRoute({}));
    const block = (id: string) => container.querySelector(`[data-billing-block="${id}"]`) as HTMLElement | null;
    const out = {
      text: container.textContent ?? '',
      credits: block('credits')?.textContent ?? null,
      payment: block('payment')?.textContent ?? null,
      paymentButtonClasses: block('payment') ? within(block('payment')!).queryAllByRole('button').map((b) => b.className) : [],
      paymentButtons: block('payment') ? within(block('payment')!).queryAllByRole('button').map((b) => b.textContent) : [],
      planButtons: block('plan') ? within(block('plan')!).queryAllByRole('button').map((b) => b.textContent) : [],
      planText: block('plan')?.textContent ?? null,
      invoiceRows: Array.from(container.querySelectorAll('[data-billing-row]')).map((r) => r.getAttribute('data-billing-row')),
      invoiceText: block('invoices')?.textContent ?? null,
      invoiceTitle: block('invoices')?.querySelector('h2')?.textContent ?? null,
      links: Array.from(block('invoices')?.querySelectorAll('a') ?? []).map((a) => [a.textContent, a.getAttribute('target')]),
      banner: container.querySelector('[data-billing-banner]') as HTMLElement | null,
    };
    const banner = out.banner
      ? { text: out.banner.querySelector('p')?.textContent ?? '', buttons: within(out.banner).queryAllByRole('button').map((b) => b.textContent) }
      : null;
    unmount();
    return { ...out, banner };
  }
  const day = (sec: number) =>
    new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' }).format(new Date(sec * 1000));

  it.each([
    ['brokerage broker', brokerageMembership('broker')],
    ['brokerage admin', brokerageMembership('admin')],
    ['brokerage it_admin', brokerageMembership('it_admin')],
  ] as [string, Row][])(
    'C-ITADMIN-PAYLOAD: %s -> no credit, card, contact or invoice read and none of it on the page',
    async (_n, row) => {
      seedCustomer();
      const r = await page([row]);
      expect(mockSessionRpc).not.toHaveBeenCalled();
      expect(mockServiceRpc).not.toHaveBeenCalled();
      expect(stripeCalls()).toBe(0);
      expect(mockBillingDb.callsTo('stripe_customers', 'select')).toEqual([]);
      expect(r.text).not.toMatch(/credit|••••|Export unlock|Agent plan ·|Receipts sent to|Invoices sent to/);
      expect(r.banner).toBeNull();
    }
  );

  it('C-READ-NOCREATE (R11): pay as you go, no customer row -> zero Stripe customer calls, "No card saved", no Update card, contact = sign-in email', async () => {
    const r = await page();
    expect(mockStripe.customersCreate).not.toHaveBeenCalled();
    expect(stripeCalls()).toBe(0);
    expect(r.payment).toContain('No card saved. A card is saved at your first purchase in the Keepr app.');
    // No customer -> no Update card (the first card is saved at the first purchase); Edit contact stays.
    expect(r.paymentButtons).toEqual(['Edit contact']);
    expect(r.payment).toContain(`Receipts sent to${SIGN_IN}`);
    expect(r.invoiceTitle).toBe('Receipts');
    expect(r.invoiceText).toContain('No payments yet.');
    expect(mockBillingDb.calls.filter((c) => c.op !== 'select')).toEqual([]);
  });

  it('C-CREDITS: get_credit_balance on the session client with no argument; the service client is never used for it', async () => {
    mockSessionRpc.mockResolvedValue({ data: 7, error: null });
    const r = await page();
    expect(mockSessionRpc.mock.calls).toEqual([['get_credit_balance']]);
    expect(mockServiceRpc).not.toHaveBeenCalled();
    expect(r.credits).toContain('7credits available');
    expect(r.credits).toContain('Buy credits in the Keepr desktop app, at its export paywall. Bulk buying on the website comes later.');
  });

  it('credits read fails -> "Credits are unavailable right now.", the rest of the page renders', async () => {
    mockSessionRpc.mockResolvedValue({ data: null, error: { code: 'PGRST000', message: 'fixture' } });
    seedCustomer();
    const r = await page();
    expect(r.credits).toContain('Credits are unavailable right now.');
    expect(r.payment).toContain('Visa •••• 4242');
  });

  it('C-ROWS-INVOICE (R10) on the page: 2 invoices + 5 charges -> 3 rows (no row per renewal retry), card and contact from the customer', async () => {
    seedCustomer();
    mockSessionRpc.mockResolvedValue({ data: 1, error: null });
    const r = await page();
    const payg = fx3848('charges-list-after-pay').data.find((c: { invoice: unknown }) => !c.invoice);
    const invIds = fx3848('invoices-list-after-pay').data.map((i: { id: string }) => i.id);
    expect([...r.invoiceRows].sort()).toEqual([...invIds, payg.id].sort());
    expect([...r.links].sort()).toEqual([
      ['Receipt', '_blank'],
      ['View', '_blank'],
      ['View', '_blank'],
    ]);
    expect(r.invoiceText).toContain('Export unlock$14.99Paid');
    expect(r.credits).toContain('1credit available');
    const pm = fx3848('pm-good');
    expect(r.payment).toContain('Saved at your last purchase');
    expect(r.payment).toContain(`Visa •••• 4242`);
    expect(r.payment).toContain(`Expires${String(pm.card.exp_month).padStart(2, '0')} / ${pm.card.exp_year}`);
    expect(r.payment).toContain(`Name${CUS.name}`);
    expect(r.payment).toContain(`Receipts sent to${CUS.email}`);
    expect(r.paymentButtons).toEqual(['Update card', 'Edit contact']);
    // Pay as you go: no subscription read.
    expect(mockStripe.subscriptionsRetrieve).not.toHaveBeenCalled();
    expect(mockStripe.customersCreate).not.toHaveBeenCalled();
    expect(mockStripe.customersUpdate).not.toHaveBeenCalled();
  });

  it('3848: Edit contact uses the same button design (class string) as Update card in the payment block', async () => {
    seedCustomer();
    mockSessionRpc.mockResolvedValue({ data: 1, error: null });
    const r = await page();
    expect(r.paymentButtons).toEqual(['Update card', 'Edit contact']);
    const [updateCard, editContact] = r.paymentButtonClasses;
    expect(updateCard).toContain('border-gray-300');
    expect(editContact).toBe(updateCard);
  });

  it('invoices read fails -> "Your payment history is unavailable right now.", card still shown', async () => {
    seedCustomer();
    mockStripe.invoicesList.mockRejectedValue(new Error('stripe down'));
    const r = await page();
    expect(r.invoiceText).toContain('Your payment history is unavailable right now.');
    expect(r.payment).toContain('Visa •••• 4242');
  });

  it('C-BANNER: payment failed -> banner names the failing subscription card, amount and date, with Update card; row "Payment failed"', async () => {
    seedCustomer();
    seedMirror(SUB);
    mockStripe.invoicesList.mockResolvedValue(fx3848('invoices-list-pastdue'));
    mockStripe.chargesList.mockResolvedValue(fx3848('charges-list-pastdue'));
    const open = fx3848('invoices-list-pastdue').data.find((i: { status: string }) => i.status === 'open');
    const r = await page();
    expect(r.banner).toEqual({
      text: `Your card payment failed. We could not charge Visa •••• 0341 for $19.99 on ${day(open.created)}. Unlimited exports are off from the first failed charge and come back when it is paid.`,
      buttons: ['Update card'],
    });
    // "Update your card below." points at a real button in block 5 (BACKLOG-3848), and End plan now is offered.
    expect(r.planText).toContain('Update your card below.');
    expect(r.planButtons).toEqual(['End plan now']);
    expect(mockStripe.subscriptionsRetrieve.mock.calls[0][0]).toBe(SUB.id);
    expect(r.payment).toContain(`Last charge failed on ${day(open.created)}`);
    expect(r.payment).toContain('Visa •••• 0341Charge failed');
    expect(r.payment).toContain('Invoices sent to');
    expect(r.paymentButtons).toEqual(['Update card', 'Edit contact']);
    expect(r.invoiceTitle).toBe('Invoices');
    expect(r.invoiceText).toContain('Payment failed');
    expect(r.credits).toContain('Usable now, while Unlimited exports are off');
    expect(r.credits).toContain('credits saved');
    expect(r.credits).toContain('Each export in the Keepr app uses one credit until your payment goes through.');
  });

  it('C-END-UNPAID (SR RC4): an unpaid subscription [EDITED status unpaid] -> no End plan now; the support note instead', async () => {
    seedCustomer();
    seedMirror({ ...SUB, status: 'unpaid' });
    mockStripe.invoicesList.mockResolvedValue(fx3848('invoices-list-pastdue'));
    mockStripe.chargesList.mockResolvedValue(fx3848('charges-list-pastdue'));
    const r = await page();
    expect(r.planButtons).toEqual([]);
    expect(r.planText).toContain('To end this plan or settle the unpaid bill, please contact support.');
  });

  it('banner control: an active plan -> no banner, "Charged automatically each month"', async () => {
    seedCustomer();
    seedMirror(fx3847('sub-C-keep'));
    const r = await page();
    expect(r.banner).toBeNull();
    expect(r.payment).toContain('Charged automatically each month');
  });

  // -------------------------------------------------------------------------
  // BACKLOG-3878 C4 — the suspended page. The licence row is the value both
  // suspension writers set (`UPDATE public.licenses SET status = 'suspended'`
  // in suspend_account_for_dispute and admin_suspend_user); the dispute row
  // carries the columns suspend_account_for_dispute inserts (ids synthetic).
  // -------------------------------------------------------------------------
  function suspend(dispute = false): void {
    mockBillingDb.rows('licenses').push({ id: 'lic-SEEDED', user_id: FIXTURE_USER_ID, status: 'suspended' });
    if (dispute) {
      mockBillingDb.rows('account_suspensions').push({
        id: 'susp-SEEDED',
        user_id: FIXTURE_USER_ID,
        event_type: 'suspended',
        reason: 'chargeback',
        stripe_dispute_id: 'dp_FX3878',
        stripe_payment_intent_id: 'pi_FX3878',
        previous_license_status: 'active',
        acted_by: null,
        created_at: '2026-10-13T00:00:00+00:00',
      });
    }
  }
  const SUSPENDED_HREF = '/dashboard/support/new?preset=billing-suspended';
  async function suspendedPage() {
    given([personalMembership()]);
    const { container, unmount } = render(await BillingRoute({}));
    const plan = container.querySelector('[data-billing-block="plan"]') as HTMLElement;
    const out = {
      banner: container.querySelector('[data-billing-banner]')?.getAttribute('data-billing-banner') ?? null,
      bannerText: container.querySelector('[data-billing-banner] p')?.textContent ?? '',
      planText: plan.textContent ?? '',
      planButtons: within(plan).queryAllByRole('button').map((b) => b.textContent),
      supportHrefs: Array.from(container.querySelectorAll('[data-billing-action="contact_support"]')).map((a) => a.getAttribute('href')),
      choose: (container.querySelector('[data-billing-block="choose_plan"]') as HTMLElement | null)?.textContent ?? null,
      enabledButtons: within(container).queryAllByRole('button').filter((b) => !(b as HTMLButtonElement).disabled).map((b) => b.textContent),
    };
    unmount();
    return out;
  }

  it('C4 control: the same Agent plan, licence active -> Cancel plan offered, no suspended banner', async () => {
    seedCustomer();
    seedMirror(fx3847('sub-C-keep'));
    const r = await suspendedPage();
    expect(r.banner).toBeNull();
    expect(r.planButtons).toContain('Cancel plan');
  });

  it('C4 suspended Agent (admin suspension) -> banner without "chargeback", renewal paused, Update card + Contact support only', async () => {
    seedCustomer();
    seedMirror(fx3847('sub-C-keep'));
    suspend();
    const r = await suspendedPage();
    expect(r.banner).toBe('suspended');
    expect(r.bannerText).toMatch(/^Your account is suspended\. You can still see your plan/);
    expect(r.bannerText).not.toContain('chargeback');
    expect(r.planText).toContain('Suspended');
    expect(r.planText).toContain('Unlimited exports · renewal paused');
    expect(r.planText).toContain('Off while suspended');
    expect(r.planText).toContain('Paused while your account is suspended. You are not charged.');
    expect(r.planText).toContain('Blocked · "License Suspended — contact support"');
    expect(r.planButtons).toEqual(['Update card']);
    expect(r.supportHrefs.length).toBeGreaterThanOrEqual(2);
    for (const href of r.supportHrefs) expect(href).toBe(SUSPENDED_HREF);
    expect(r.enabledButtons).not.toContain('Cancel plan');
    expect(r.enabledButtons).not.toContain('Keep my plan');
    expect(r.enabledButtons).not.toContain('End plan now');
  });

  it('C4 dispute suspension -> "Your account is suspended after a chargeback."', async () => {
    seedCustomer();
    seedMirror(fx3847('sub-C-keep'));
    suspend(true);
    const r = await suspendedPage();
    expect(r.bannerText).toMatch(/^Your account is suspended after a chargeback\./);
  });

  it('C4 suspended + payment failed -> the suspended banner only, no End plan now', async () => {
    seedCustomer();
    seedMirror(SUB);
    mockStripe.invoicesList.mockResolvedValue(fx3848('invoices-list-pastdue'));
    mockStripe.chargesList.mockResolvedValue(fx3848('charges-list-pastdue'));
    suspend();
    const r = await suspendedPage();
    expect(r.banner).toBe('suspended');
    expect(r.planButtons).toEqual(['Update card']);
    expect(r.enabledButtons).not.toContain('End plan now');
  });

  it('C4 suspended solo (pay as you go) -> plan cards shown, every purchase disabled, paused copy', async () => {
    suspend();
    const r = await suspendedPage();
    expect(r.banner).toBe('suspended');
    expect(r.choose).toContain('Purchases are paused until support reinstates your account.');
    expect(r.planText).toContain('Suspended');
    expect(r.enabledButtons.filter((t) => /Subscribe|Book a Call/.test(t ?? ''))).toEqual([]);
    expect(startAgentCheckout).not.toHaveBeenCalled();
  });

  it('C4 the disputed per-export payment reads "Disputed" in Receipts (TEST fixture p3878)', async () => {
    seedCustomer();
    suspend(true);
    mockStripe.invoicesList.mockResolvedValue({ object: 'list', data: [], has_more: false, url: '/v1/invoices' });
    mockStripe.chargesList.mockResolvedValue(JSON.parse(fs.readFileSync(path.join(__dirname, '../../../fixtures/stripe/p3878/charges-list-disputed.json'), 'utf8')));
    const r = await page();
    expect(r.invoiceText).toContain('Export unlock');
    expect(r.invoiceText).toContain('Disputed');
    expect(r.invoiceText).not.toContain('Paid');
  });

  it('C4 solo control: licence active -> Subscribe is enabled', async () => {
    const r = await suspendedPage();
    expect(r.choose).not.toContain('Purchases are paused');
    expect(r.enabledButtons.some((t) => /^Subscribe/.test(t ?? ''))).toBe(true);
  });

  it('suspended (licenses row) -> credits kept copy, "Card on file"', async () => {
    seedCustomer();
    seedMirror(fx3847('sub-C-keep'));
    mockBillingDb.rows('licenses').push({ id: 'lic-SEEDED', user_id: FIXTURE_USER_ID, status: 'suspended' });
    const r = await page();
    expect(r.credits).toContain('Credits cannot be used or bought while your account is suspended. They are kept.');
    expect(r.payment).toContain('Card on file');
  });
});
