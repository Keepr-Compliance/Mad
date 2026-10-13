/**
 * middleware.ts and a suspended account — BACKLOG-3878 (C1, C1b, R11, R12).
 *
 * The REAL middleware runs against the PostgREST emulator. Suspended is the
 * caller's own `licenses` row with `status = 'suspended'`: the value both
 * suspension writers set (suspend_account_for_dispute and admin_suspend_user,
 * `UPDATE public.licenses SET status = 'suspended'`, prod catalog 2026-10-13).
 * `users.status` is never seeded: the dispute path does not write it.
 *
 * middleware is NOT the only gate: __tests__/suspended-3878/pages.test.tsx
 * invokes the pages with middleware bypassed.
 *
 * @jest-environment node
 */

import {
  ABSENT_COLUMN_ERROR,
  FIXTURE_USER_ID,
  brokerageMembership,
  createPostgrestEmulator,
  personalMembership,
  type Row,
} from '../helpers/postgrestEmulator';

const mockEmulator = createPostgrestEmulator();
const mockGetUser = jest.fn();
let mockLicenceReadFails = false;

function mockFrom(table: string) {
  const chain = mockEmulator.from(table);
  if (mockLicenceReadFails && table === 'licenses') {
    (chain as { then: unknown }).then = (
      onFulfilled: (r: unknown) => unknown,
      onRejected?: (e: unknown) => unknown
    ) => Promise.resolve({ data: null, error: { ...ABSENT_COLUMN_ERROR }, status: 400 }).then(onFulfilled, onRejected);
  }
  return chain;
}

jest.mock('@supabase/ssr', () => ({
  createServerClient: jest.fn(() => ({
    auth: { getUser: mockGetUser },
    from: (table: string) => mockFrom(table),
  })),
}));

import { middleware } from '@/middleware';
import { NextRequest } from 'next/server';
import { IMPERSONATION_COOKIE_NAME } from '@/lib/constants';

const ORIGIN = 'http://localhost:3000';
const TO_BILLING = `${ORIGIN}/dashboard/billing`;
const TO_ACCOUNT = `${ORIGIN}/dashboard/account`;

const SUSPENDED: Row = { user_id: FIXTURE_USER_ID, status: 'suspended' };
const ACTIVE: Row = { user_id: FIXTURE_USER_ID, status: 'active' };

async function verdict(path: string, cookie?: string): Promise<string | null> {
  const req = new NextRequest(`${ORIGIN}${path}`);
  if (cookie) req.cookies.set(IMPERSONATION_COOKIE_NAME, cookie);
  const response = await middleware(req);
  return response.headers.get('location');
}

function given(memberships: Row[], licence: Row | null, options: { licenceReadFails?: boolean } = {}): void {
  mockGetUser.mockResolvedValue({ data: { user: { id: FIXTURE_USER_ID } } });
  mockLicenceReadFails = options.licenceReadFails ?? false;
  mockEmulator.set({
    columnPresent: true,
    rows: { organization_members: memberships, licenses: licence ? [licence] : [] },
  });
}

const OLD_FLAG = process.env.BILLING_ENABLED;
afterAll(() => {
  if (OLD_FLAG === undefined) delete process.env.BILLING_ENABLED;
  else process.env.BILLING_ENABLED = OLD_FLAG;
});
let warnSpy: jest.SpyInstance;
beforeEach(() => {
  jest.clearAllMocks();
  mockEmulator.reset();
  mockLicenceReadFails = false;
  process.env.BILLING_ENABLED = 'true';
  warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => warnSpy.mockRestore());

const PATHS = [
  '/dashboard',
  '/dashboard/account',
  '/dashboard/account/x',
  '/dashboard/support',
  '/dashboard/support/new',
  '/dashboard/supportx',
  '/dashboard/accounts',
  '/dashboard/billing',
  '/dashboard/billing/x',
  '/dashboard/billingx',
  '/dashboard/checklists',
  '/dashboard/checklists/new',
  '/dashboard/my-transactions',
  '/dashboard/my-transactions/abc-123',
  '/dashboard/submissions',
  '/dashboard/submissions/abc-123',
  '/dashboard/users',
  '/dashboard/users/abc-123',
  '/dashboard/settings',
  '/dashboard/settings/scim',
] as const;
type P = (typeof PATHS)[number];

/** Admitted for a suspended account: account + support, and billing for a personal owner while billing is on. */
function expected(landing: string, billing: boolean): Record<P, string | null> {
  const open = new Set<string>([
    '/dashboard/account',
    '/dashboard/account/x',
    '/dashboard/support',
    '/dashboard/support/new',
    ...(billing ? ['/dashboard/billing', '/dashboard/billing/x'] : []),
  ]);
  return Object.fromEntries(PATHS.map((p) => [p, open.has(p) ? null : landing])) as Record<P, string | null>;
}

const SUSPENDED_PERSONAS: [string, Row[], boolean, string, boolean][] = [
  // name, memberships, billing flag, landing, sees billing
  ['personal-org owner, billing on', [personalMembership()], true, TO_BILLING, true],
  ['personal-org owner, billing off', [personalMembership()], false, TO_ACCOUNT, false],
  ['brokerage agent', [brokerageMembership('agent')], true, TO_ACCOUNT, false],
  ['brokerage broker', [brokerageMembership('broker')], true, TO_ACCOUNT, false],
  ['brokerage admin', [brokerageMembership('admin')], true, TO_ACCOUNT, false],
  ['brokerage it_admin', [brokerageMembership('it_admin')], true, TO_ACCOUNT, false],
  ['personal row then brokerage agent', [personalMembership(), brokerageMembership('agent')], true, TO_ACCOUNT, false],
];

describe('C1: a suspended account keeps Billing (personal owner) / My Account / Support', () => {
  it.each(SUSPENDED_PERSONAS)('%s: verdict table', async (_n, rows, billingOn, landing, billing) => {
    const actual: Record<string, string | null> = {};
    for (const path of PATHS) {
      process.env.BILLING_ENABLED = billingOn ? 'true' : 'false';
      given(rows, SUSPENDED);
      actual[path] = await verdict(path);
    }
    expect(actual).toEqual(expected(landing, billing));
  });

  it('C1 control: the same personal owner with an ACTIVE licence opens /dashboard and /dashboard/checklists', async () => {
    given([personalMembership()], ACTIVE);
    expect(await verdict('/dashboard')).toBeNull();
    given([personalMembership()], ACTIVE);
    expect(await verdict('/dashboard/checklists')).toBeNull();
  });

  it('C1 control: a brokerage broker with an ACTIVE licence opens /dashboard/users and /dashboard/submissions', async () => {
    given([brokerageMembership('broker')], ACTIVE);
    expect(await verdict('/dashboard/users')).toBeNull();
    given([brokerageMembership('broker')], ACTIVE);
    expect(await verdict('/dashboard/submissions')).toBeNull();
  });

  it('C1: no licence row at all is not suspended', async () => {
    given([personalMembership()], null);
    expect(await verdict('/dashboard')).toBeNull();
  });

  it('C1: the licence is read alongside the memberships (one request, both tables)', async () => {
    given([personalMembership()], SUSPENDED);
    await verdict('/dashboard');
    expect(mockEmulator.state.selects.map((s) => s.table).sort()).toEqual(['licenses', 'organization_members']);
  });
});

describe('R12: every redirect ends at an admitted path within 2 hops', () => {
  it.each(SUSPENDED_PERSONAS)('%s', async (_n, rows, billingOn) => {
    for (const start of PATHS) {
      let path: string = start;
      let hops = 0;
      for (;;) {
        process.env.BILLING_ENABLED = billingOn ? 'true' : 'false';
        given(rows, SUSPENDED);
        const to = await verdict(path);
        if (to === null) break;
        hops += 1;
        path = new URL(to).pathname;
        if (hops > 2) throw new Error(`${start} did not settle: reached ${path} after ${hops} hops`);
      }
      expect(hops).toBeLessThanOrEqual(1);
      if (!billingOn) expect(path).not.toBe('/dashboard/billing');
    }
  });
});

describe('C1b: a failed licence read lets the request through and logs a static code only', () => {
  it('suspended owner, licence read fails -> /dashboard admitted, one warning with the code, no error object', async () => {
    given([personalMembership()], SUSPENDED, { licenceReadFails: true });
    expect(await verdict('/dashboard')).toBeNull();
    expect(warnSpy).toHaveBeenCalledWith('[middleware] suspended check skipped', { code: 'licence_read_failed' });
    for (const call of warnSpy.mock.calls) {
      expect(JSON.stringify(call)).not.toContain(ABSENT_COLUMN_ERROR.message as string);
    }
  });

  it('the access rule still applies: a floor path above the floor still goes to /dashboard', async () => {
    given([personalMembership()], SUSPENDED, { licenceReadFails: true });
    expect(await verdict('/dashboard/users')).toBe(`${ORIGIN}/dashboard`);
  });
});

describe('R11: a support (impersonation) session is not redirected by the suspended gate', () => {
  it.each(['/dashboard', '/dashboard/submissions', '/dashboard/billing'])('%s with the cookie -> admitted', async (path) => {
    given([brokerageMembership('broker')], SUSPENDED);
    expect(await verdict(path, 'fixture-cookie-value')).toBeNull();
    // The middleware never read the licence (or anything) for it.
    expect(mockEmulator.state.selects).toEqual([]);
  });

  it('control: the same request without the cookie is redirected', async () => {
    given([brokerageMembership('broker')], SUSPENDED);
    expect(await verdict('/dashboard')).toBe(TO_ACCOUNT);
  });
});
