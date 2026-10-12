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
  FIXTURE_USER_ID,
  brokerageMembership,
  createPostgrestEmulator,
  personalMembership,
  type Row,
} from '../../../helpers/postgrestEmulator';

const mockEmulator = createPostgrestEmulator();
const mockGetUser = jest.fn();
let mockReadFails = false;
let mockCookie: string | undefined;
let mockSessionRow: Record<string, unknown> | null = null;
const mockServiceTables: string[] = [];

jest.mock('next/headers', () => ({
  cookies: async () => ({
    get: (name: string) => (name === 'impersonation_session' && mockCookie ? { value: mockCookie } : undefined),
    set: jest.fn(),
  }),
}));

jest.mock('@/lib/supabase/server', () => ({
  createClient: jest.fn(async () => ({
    auth: { getUser: mockGetUser },
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
 * The service client the impersonation helper validates with. A recording
 * stub (the emulator has no `.gt`): serves the one session row for
 * impersonation_sessions and nothing for any other table.
 */
jest.mock('@/lib/supabase/service', () => ({
  createServiceClient: jest.fn(() => ({
    from: (table: string) => {
      mockServiceTables.push(table);
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
}));

import { render, within } from '@testing-library/react';
import BillingRoute from '@/app/dashboard/billing/page';
import { BillingPage } from '@/components/billing/BillingPage';
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
    const el = await BillingRoute();
    return { element: el.type === BillingPage ? 'BillingPage' : String(el.type) };
  } catch (e) {
    if (e instanceof Redirect) return { redirect: e.to };
    if (e instanceof NotFound) return { notFound: true };
    throw e;
  }
}

/** The h2 of every block, in render order. */
async function renderedBlocks(): Promise<string[]> {
  const { container, unmount } = render(await BillingRoute());
  const titles = within(container)
    .getAllByRole('heading', { level: 2 })
    .map((h) => h.textContent ?? '');
  unmount();
  return titles;
}

const sessionTablesRead = () => Array.from(new Set(mockEmulator.state.selects.map((s) => s.table))).sort();

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
    expect(sessionTablesRead()).toEqual(['organization_members']);
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
      ['Your plan', 'Choose a plan', 'Credits', 'Payment method & billing contact', 'Invoices'],
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
    const { container, unmount } = render(await BillingRoute());
    expect(container.textContent).toContain(planLine);
    // No amount of money anywhere on the 3844 page.
    expect(container.textContent).not.toMatch(/\$|USD|\/mo/);
    unmount();
    expect(mockEmulator.state.writes).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// R2 / C4 — a support session is refused even when the browser also holds a
// full-portal session of its own.
// ---------------------------------------------------------------------------

describe('R2: a support session never sees billing', () => {
  it('fixture check: the real helper accepts this session', async () => {
    givenSupportSession();
    expect(await getImpersonationSession()).toMatchObject({ session_id: SESSION_ID, target_user_id: TARGET_USER_ID });
  });

  it('fixture check: the same signed-in admin without the cookie gets the page', async () => {
    given([brokerageMembership('admin')]);
    expect(await run()).toEqual({ element: 'BillingPage' });
    expect(sessionTablesRead()).toEqual(['organization_members']);
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
