/**
 * middleware.ts and the brokerage's billing-only login — BACKLOG-4007 PR-4 (C-A1).
 *
 * The billing-only login is a member with license 'unassigned' (classifyPortalAccess: floor via
 * 'unlicensed') linked from the live billing contact. The database answers "is the caller that
 * person?" through org_billing_contact_login(p_org) (migration 20261020180000; keepr-test result
 * shape: a bare boolean, C_A1_* in supabase/tests/backlog-4007-pr4). On top of the floor it may
 * open /dashboard/billing and nothing else.
 *
 * Most likely wrong build: Billing opened for ANY unlicensed member (the RPC never asked, or its
 * answer ignored). The "unlicensed, not the billing contact" rows below catch it.
 *
 * @jest-environment node
 */

import {
  FIXTURE_BROKERAGE_ORG_ID,
  FIXTURE_USER_ID,
  brokerageMembership,
  createPostgrestEmulator,
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
const ACTIVE_LICENCE: Row = { user_id: FIXTURE_USER_ID, status: 'active' };

type Answer = 'yes' | 'no' | 'rpc_error' | 'rpc_throws';

function member(role: string, license_status: string): Row {
  return { ...brokerageMembership(role), license_status };
}

function given(rows: Row[], answer: Answer): void {
  mockGetUser.mockResolvedValue({ data: { user: { id: FIXTURE_USER_ID } } });
  mockEmulator.set({ columnPresent: true, rows: { organization_members: rows, licenses: [ACTIVE_LICENCE] } });
  mockRpc.mockImplementation(async (fn: string, args: { p_org?: string }) => {
    if (fn === 'org_billing_suspended') return { data: false, error: null };
    if (fn !== 'org_billing_contact_login') return { data: null, error: { code: 'PGRST202', message: 'unexpected rpc' } };
    if (answer === 'rpc_throws') throw new TypeError('fetch failed');
    if (answer === 'rpc_error') return { data: null, error: { code: '57014', message: 'canceling statement due to statement timeout' } };
    return { data: answer === 'yes' && args.p_org === FIXTURE_BROKERAGE_ORG_ID, error: null };
  });
}

async function verdict(path: string): Promise<string | null> {
  const response = await middleware(new NextRequest(`${ORIGIN}${path}`));
  const to = response.headers.get('location');
  return to ? new URL(to).pathname : null;
}

const PATHS = [
  '/dashboard',
  '/dashboard/account',
  '/dashboard/support',
  '/dashboard/billing',
  '/dashboard/billing/x',
  '/dashboard/billingx',
  '/dashboard/checklists',
  '/dashboard/my-transactions',
  '/dashboard/submissions',
  '/dashboard/users',
  '/dashboard/settings',
  '/dashboard/setup',
] as const;

const FLOOR_OPEN = ['/dashboard', '/dashboard/account', '/dashboard/support'];

function table(open: string[]): Record<string, string | null> {
  const set = new Set(open);
  return Object.fromEntries(PATHS.map((p) => [p, set.has(p) ? null : '/dashboard']));
}

async function sweep(): Promise<Record<string, string | null>> {
  const out: Record<string, string | null> = {};
  for (const p of PATHS) out[p] = await verdict(p);
  return out;
}

const contactCalls = () => mockRpc.mock.calls.filter((c) => c[0] === 'org_billing_contact_login');

let warnSpy: jest.SpyInstance;
beforeEach(() => {
  jest.clearAllMocks();
  mockEmulator.reset();
  warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => warnSpy.mockRestore());

describe('billing-only login (unlicensed + linked billing contact)', () => {
  it('opens the floor plus Billing, and nothing else', async () => {
    given([member('agent', 'unassigned')], 'yes');
    expect(await sweep()).toEqual(table([...FLOOR_OPEN, '/dashboard/billing', '/dashboard/billing/x']));
  });

  it('asks the database only on a Billing path, for this brokerage', async () => {
    given([member('agent', 'unassigned')], 'yes');
    await verdict('/dashboard/users');
    await verdict('/dashboard/account');
    expect(contactCalls()).toHaveLength(0);
    await verdict('/dashboard/billing');
    expect(contactCalls()).toEqual([['org_billing_contact_login', { p_org: FIXTURE_BROKERAGE_ORG_ID }]]);
  });
});

describe('everyone the database does not name keeps their old answer', () => {
  it.each<[string, Answer]>([
    ['not the billing contact', 'no'],
    ['the read fails', 'rpc_error'],
    ['the read throws', 'rpc_throws'],
  ])('unlicensed member, %s: floor only (fail closed)', async (_label, answer) => {
    given([member('agent', 'unassigned')], answer);
    expect(await sweep()).toEqual(table(FLOOR_OPEN));
  });

  it('an agent (floor via brokerage) is never asked, even if the database would say yes', async () => {
    given([member('agent', 'active')], 'yes');
    const v = await sweep();
    expect(v['/dashboard/billing']).toBe('/dashboard');
    expect(contactCalls()).toHaveLength(0);
  });

  it('a deactivated member is never asked', async () => {
    given([member('agent', 'suspended')], 'yes');
    expect(await verdict('/dashboard/billing')).toBe('/dashboard');
    expect(contactCalls()).toHaveLength(0);
  });

  it('a full-portal admin opens Billing without the question', async () => {
    given([member('admin', 'active')], 'no');
    expect(await verdict('/dashboard/billing')).toBeNull();
    expect(contactCalls()).toHaveLength(0);
  });
});
