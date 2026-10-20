/**
 * middleware.ts and a SUSPENDED BROKERAGE — BACKLOG-3853 PR-2B (C-1, C-2, C-7, C-8).
 *
 * A suspended brokerage is `org_deals.status = 'suspended'`, read through
 * `org_billing_suspended(p_org)` (migration 20261018230000, GRANT authenticated;
 * returns a boolean). It never touches anybody's licence: _billing_suspend_org
 * leaves every member's licences row 'active' (measured on keepr-test, plan
 * 2cafe0ef §5). So every persona below has an ACTIVE licence, and the 3878 flag
 * (licenses.status) is false for all of them — the most likely wrong build reuses
 * that flag and sees nothing here.
 *
 * Who keeps what (plan 2cafe0ef §1.1, founder 1e164f56 Q2 = b):
 *   broker / admin / it_admin -> Billing (while billing is on), Support, My Account; land on
 *                                Billing, or My Account when billing is off.
 *   agent (floor via brokerage) -> /dashboard, My Transactions (Q7 a), Support, My Account;
 *                                Checklists is gone (a43c3e85); lands on /dashboard.
 *   personal owner, unlicensed, deactivated, unknown -> unchanged, and NO rpc is made.
 *
 * @jest-environment node
 */

import {
  FIXTURE_BROKERAGE_ORG_ID,
  FIXTURE_USER_ID,
  brokerageMembership,
  createPostgrestEmulator,
  personalMembership,
  type Row,
} from '../helpers/postgrestEmulator';

const mockEmulator = createPostgrestEmulator();
const mockGetUser = jest.fn();
const mockRpc = jest.fn();

jest.mock('@supabase/ssr', () => ({
  createServerClient: jest.fn(() => ({
    auth: { getUser: mockGetUser },
    from: (table: string) => mockEmulator.from(table),
    rpc: (...a: unknown[]) => mockRpc(...a),
  })),
}));

import { middleware } from '@/middleware';
import { NextRequest } from 'next/server';

const ORIGIN = 'http://localhost:3000';
const ACTIVE: Row = { user_id: FIXTURE_USER_ID, status: 'active' };
const LICENCE_SUSPENDED: Row = { user_id: FIXTURE_USER_ID, status: 'suspended' };

type OrgState = 'suspended' | 'active' | 'rpc_error' | 'rpc_throws';

async function verdict(path: string): Promise<string | null> {
  const response = await middleware(new NextRequest(`${ORIGIN}${path}`));
  const to = response.headers.get('location');
  return to ? new URL(to).pathname : null;
}

function given(memberships: Row[], org: OrgState, licence: Row = ACTIVE): void {
  mockGetUser.mockResolvedValue({ data: { user: { id: FIXTURE_USER_ID } } });
  mockEmulator.set({ columnPresent: true, rows: { organization_members: memberships, licenses: [licence] } });
  mockRpc.mockImplementation(async (fn: string, args: { p_org?: string }) => {
    if (fn !== 'org_billing_suspended') return { data: null, error: { code: 'PGRST202', message: 'unexpected rpc' } };
    if (org === 'rpc_throws') throw new TypeError('fetch failed');
    if (org === 'rpc_error') return { data: null, error: { code: '57014', message: 'canceling statement due to statement timeout' } };
    return { data: org === 'suspended' && args.p_org === FIXTURE_BROKERAGE_ORG_ID, error: null };
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

function table(open: string[], landing: string): Record<string, string | null> {
  const set = new Set(open);
  return Object.fromEntries(PATHS.map((p) => [p, set.has(p) ? null : landing]));
}

const FULL_OPEN_BILLING_ON = ['/dashboard/billing', '/dashboard/billing/x', '/dashboard/support', '/dashboard/support/new', '/dashboard/account', '/dashboard/account/x'];
const FULL_OPEN_BILLING_OFF = ['/dashboard/support', '/dashboard/support/new', '/dashboard/account', '/dashboard/account/x'];
const AGENT_OPEN = [
  '/dashboard',
  '/dashboard/account',
  '/dashboard/account/x',
  '/dashboard/support',
  '/dashboard/support/new',
  '/dashboard/my-transactions',
  '/dashboard/my-transactions/abc-123',
];

async function sweep(rows: Row[], org: OrgState, billingOn: boolean): Promise<Record<string, string | null>> {
  const actual: Record<string, string | null> = {};
  for (const path of PATHS) {
    process.env.BILLING_ENABLED = billingOn ? 'true' : 'false';
    given(rows, org);
    actual[path] = await verdict(path);
  }
  return actual;
}

describe('C-2: suspended brokerage, every dashboard path x role x billing flag', () => {
  it.each(['broker', 'admin', 'it_admin'])('%s, billing on -> Billing / Support / My Account; land on Billing', async (role) => {
    expect(await sweep([brokerageMembership(role)], 'suspended', true)).toEqual(table(FULL_OPEN_BILLING_ON, '/dashboard/billing'));
  });

  it.each(['broker', 'admin', 'it_admin'])('%s, billing off -> Support / My Account; land on My Account', async (role) => {
    expect(await sweep([brokerageMembership(role)], 'suspended', false)).toEqual(table(FULL_OPEN_BILLING_OFF, '/dashboard/account'));
  });

  it.each([true, false])('C-7 agent (billing %s) keeps /dashboard and My Transactions, loses Checklists', async (billingOn) => {
    expect(await sweep([brokerageMembership('agent')], 'suspended', billingOn)).toEqual(table(AGENT_OPEN, '/dashboard'));
  });

  it('a personal row first, then the brokerage admin row: the brokerage rule applies', async () => {
    expect(await sweep([personalMembership(), brokerageMembership('admin')], 'suspended', true)).toEqual(
      table(FULL_OPEN_BILLING_ON, '/dashboard/billing')
    );
  });

  it('the rpc is asked about the brokerage the portal routes on, once per request', async () => {
    given([brokerageMembership('broker')], 'suspended');
    await verdict('/dashboard/submissions');
    expect(mockRpc.mock.calls).toEqual([['org_billing_suspended', { p_org: FIXTURE_BROKERAGE_ORG_ID }]]);
  });
});

describe('C-1: the licence is active; only the brokerage is suspended', () => {
  it('control: the same broker with the brokerage ACTIVE opens Submissions and Users', async () => {
    given([brokerageMembership('broker')], 'active');
    expect(await verdict('/dashboard/submissions')).toBeNull();
    given([brokerageMembership('broker')], 'active');
    expect(await verdict('/dashboard/users')).toBeNull();
    given([brokerageMembership('agent')], 'active');
    expect(await verdict('/dashboard/checklists')).toBeNull();
  });

  it('broker on a suspended brokerage: /dashboard/submissions -> Billing', async () => {
    given([brokerageMembership('broker')], 'suspended');
    expect(await verdict('/dashboard/submissions')).toBe('/dashboard/billing');
  });

  it('licence suspended AND brokerage suspended: the licence rule wins (My Account), no brokerage read', async () => {
    given([brokerageMembership('broker')], 'suspended', LICENCE_SUSPENDED);
    expect(await verdict('/dashboard/billing')).toBe('/dashboard/account');
    expect(mockRpc).not.toHaveBeenCalled();
  });
});

describe('C-2: no regression, and no rpc, for everyone else', () => {
  const cases: [string, Row[]][] = [
    ['personal owner', [personalMembership()]],
    ['unlicensed brokerage member', [{ ...brokerageMembership('agent'), license_status: 'unassigned' }]],
    ['deactivated brokerage member', [{ ...brokerageMembership('agent'), license_status: 'suspended' }]],
  ];
  it.each(cases)('%s: no org_billing_suspended call', async (_n, rows) => {
    given(rows, 'suspended');
    await verdict('/dashboard');
    await verdict('/dashboard/support');
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it('personal owner on /dashboard and /dashboard/checklists: admitted as before', async () => {
    given([personalMembership()], 'suspended');
    expect(await verdict('/dashboard')).toBeNull();
    given([personalMembership()], 'suspended');
    expect(await verdict('/dashboard/checklists')).toBeNull();
  });
});

describe('every redirect settles in one hop (landing is always admitted)', () => {
  const personas: [string, Row[]][] = [
    ['broker', [brokerageMembership('broker')]],
    ['admin', [brokerageMembership('admin')]],
    ['it_admin', [brokerageMembership('it_admin')]],
    ['agent', [brokerageMembership('agent')]],
  ];
  it.each(personas)('%s', async (_n, rows) => {
    for (const billingOn of [true, false]) {
      for (const start of PATHS) {
        let path: string = start;
        let hops = 0;
        for (;;) {
          process.env.BILLING_ENABLED = billingOn ? 'true' : 'false';
          given(rows, 'suspended');
          const to = await verdict(path);
          if (to === null) break;
          hops += 1;
          path = to;
          if (hops > 2) throw new Error(`${start} did not settle (billing ${billingOn}): ${path}`);
        }
        expect(hops).toBeLessThanOrEqual(1);
        if (!billingOn) expect(path).not.toBe('/dashboard/billing');
      }
    }
  });
});

describe('C-8: a failed brokerage read lets the request through and logs a static code only', () => {
  it.each(['rpc_error', 'rpc_throws'] as const)('%s -> /dashboard/submissions admitted, one static warning', async (mode) => {
    given([brokerageMembership('broker')], mode);
    expect(await verdict('/dashboard/submissions')).toBeNull();
    expect(warnSpy).toHaveBeenCalledWith('[middleware] brokerage suspension check skipped', { code: 'org_suspension_read_failed' });
    for (const call of warnSpy.mock.calls) {
      expect(JSON.stringify(call)).not.toContain('statement timeout');
      expect(JSON.stringify(call)).not.toContain('fetch failed');
    }
  });
});
