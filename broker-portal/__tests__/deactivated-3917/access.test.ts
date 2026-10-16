/**
 * BACKLOG-3917: a brokerage membership whose `license_status` does not grant
 * access — classifier, middleware redirects and the OAuth callback.
 *
 * Rows are the transcribed brokerage / personal fixture rows
 * (helpers/postgrestEmulator.ts) with `license_status` as its writers leave
 * it: 'suspended' (lib/actions/deactivateUser.ts, directory-sync), 'pending'
 * (inviteUser, admin_invite_user — unlinked in prod, kept for the sweep),
 * 'expired' (no writer; the CHECK admits it). The licence row is
 * `licenses.status = 'suspended'`, as BACKLOG-3878's tests use it.
 *
 * @jest-environment node
 */

import {
  FIXTURE_BROKERAGE_ORG_ID,
  FIXTURE_PERSONAL_ORG_ID,
  FIXTURE_USER_ID,
  brokerageMembership,
  createPostgrestEmulator,
  pendingInvite,
  personalMembership,
  personalMembershipOwnedBy,
  type Row,
} from '../helpers/postgrestEmulator';

const mockEmulator = createPostgrestEmulator();
const mockGetUser = jest.fn();
const mockExchangeCodeForSession = jest.fn();
const mockRpc = jest.fn();
const mockSignOut = jest.fn();

jest.mock('@supabase/ssr', () => ({
  createServerClient: jest.fn(() => ({
    auth: { getUser: mockGetUser },
    from: (table: string) => mockEmulator.from(table),
  })),
}));
jest.mock('@/lib/supabase/server', () => ({
  createClient: jest.fn(async () => ({
    auth: { exchangeCodeForSession: mockExchangeCodeForSession, getUser: mockGetUser, signOut: mockSignOut },
    rpc: mockRpc,
    from: (table: string) => mockEmulator.from(table),
  })),
}));

import { NextRequest } from 'next/server';
import { middleware } from '@/middleware';
import { GET as callback } from '@/app/auth/callback/route';
import { IMPERSONATION_COOKIE_NAME } from '@/lib/constants';
import {
  PORTAL_GRANTING_LICENSE_STATUSES,
  PORTAL_MEMBERSHIP_SELECT,
  classifyPortalAccess,
  type PortalMembershipRow,
  mayOpenDashboardPath,
  memberStatusGrantsAccess,
} from '@/lib/auth/membership';

const ORIGIN = 'http://localhost:3000';
const EMAIL = 'deactivated-3917@fixture.example.test';

/**
 * The fixture builders return the loose `Row`; every one of them sets `role` and
 * `organization_id` (postgrestEmulator.ts), which is what PortalMembershipRow
 * requires. The single cast lives here so each call site stays honest.
 */
const classify = (rows: Row[], userId: string) => classifyPortalAccess(rows as unknown as PortalMembershipRow[], userId);

const withStatus = (row: Row, status: unknown): Row => ({ ...row, license_status: status });
const suspendedAdmin = () => withStatus(brokerageMembership('admin'), 'suspended');
const SUSPENDED_LICENCE: Row = { user_id: FIXTURE_USER_ID, status: 'suspended' };

function given(memberships: Row[], licence: Row | null = null): void {
  mockGetUser.mockResolvedValue({
    data: { user: { id: FIXTURE_USER_ID, email: EMAIL, app_metadata: { provider: 'azure' }, user_metadata: { custom_claims: { tid: 'fixture-tenant-3917' } } } },
  });
  mockEmulator.set({
    columnPresent: true,
    rows: { organization_members: memberships, licenses: licence ? [licence] : [] },
  });
}

async function hop(path: string, cookie?: string): Promise<string | null> {
  const req = new NextRequest(`${ORIGIN}${path}`);
  if (cookie) req.cookies.set(IMPERSONATION_COOKIE_NAME, cookie);
  const location = (await middleware(req)).headers.get('location');
  return location ? new URL(location).pathname : null;
}

/** Follow middleware redirects; returns the landing path and the hop count. */
async function land(path: string): Promise<{ at: string; hops: number }> {
  let at = path;
  for (let hops = 0; hops <= 3; hops++) {
    const next = await hop(at);
    if (next === null) return { at, hops };
    at = next;
  }
  throw new Error(`redirect loop from ${path}`);
}

let warn: jest.SpyInstance;
beforeEach(() => {
  jest.clearAllMocks();
  mockEmulator.reset();
  warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => warn.mockRestore());

// ---------------------------------------------------------------------------
// Classifier
// ---------------------------------------------------------------------------

describe('the allow-list', () => {
  it('is exactly [active]', () => {
    expect([...PORTAL_GRANTING_LICENSE_STATUSES]).toEqual(['active']);
  });

  it('the portal select reads license_status', () => {
    expect(PORTAL_MEMBERSHIP_SELECT.split(',').map((c) => c.trim())).toContain('license_status');
  });

  // Sweep: every value the CHECK admits, plus the shapes a bad read produces.
  it.each([
    ['active', true],
    ['suspended', false],
    ['expired', false],
    ['pending', false],
    ['unassigned', false],
    ['Active', false],
    [' active', false],
    ['', false],
    [null, false],
    [undefined, false],
  ])('memberStatusGrantsAccess(%p) = %p', (status, expected) => {
    expect(memberStatusGrantsAccess(status as string | null | undefined)).toBe(expected);
  });
});

describe('classifyPortalAccess', () => {
  const ROLES = ['admin', 'it_admin', 'broker', 'agent'];
  const REFUSING = ['suspended', 'expired', 'pending', null];

  it.each(ROLES.flatMap((role) => REFUSING.map((s) => [role, s] as const)))(
    'brokerage %s with status %p -> floor/deactivated',
    (role, status) => {
      expect(classify([withStatus(brokerageMembership(role), status)], FIXTURE_USER_ID)).toEqual({
        kind: 'floor',
        via: 'deactivated',
        role,
        organizationId: FIXTURE_BROKERAGE_ORG_ID,
      });
    }
  );

  it('a row with no license_status key at all -> floor/deactivated (fail closed)', () => {
    const { license_status: _drop, ...row } = brokerageMembership('admin');
    expect(classify([row as Row], FIXTURE_USER_ID)).toMatchObject({ kind: 'floor', via: 'deactivated' });
  });

  it.each(['admin', 'it_admin', 'broker'])('twin: an active brokerage %s is still full', (role) => {
    expect(classify([brokerageMembership(role)], FIXTURE_USER_ID)).toMatchObject({ kind: 'full', role });
  });

  it('twin: an active brokerage agent is still floor/brokerage', () => {
    expect(classify([brokerageMembership('agent')], FIXTURE_USER_ID)).toMatchObject({
      kind: 'floor',
      via: 'brokerage',
    });
  });

  // BACKLOG-3851 (C1). Founder ruling: a DEACTIVATED member (suspended /
  // expired) who owns a personal row is back on individual pay-as-you-go.
  // Every other non-granting status never falls through. Whole objects, both
  // row orders: a classifier that says personal_owner but scopes to the
  // brokerage org must fail here.
  const ORDERS = [
    ['personal row first', (b: Row) => [personalMembership(), b]],
    ['personal row last', (b: Row) => [b, personalMembership()]],
  ] as const;

  it.each(
    ['suspended', 'expired'].flatMap((status) => ORDERS.map(([order, rows]) => [status, order, rows] as const))
  )('C1: %s admin who owns a personal row (%s) -> floor/personal_owner on the personal org', (status, _order, rows) => {
    expect(classify(rows(withStatus(brokerageMembership('admin'), status)), FIXTURE_USER_ID)).toEqual({
      kind: 'floor',
      via: 'personal_owner',
      role: 'agent',
      organizationId: FIXTURE_PERSONAL_ORG_ID,
    });
  });

  it.each(ORDERS)('C1: unassigned admin who owns a personal row (%s) -> floor/unlicensed, never personal', (_o, rows) => {
    expect(classify(rows(withStatus(brokerageMembership('admin'), 'unassigned')), FIXTURE_USER_ID)).toEqual({
      kind: 'floor',
      via: 'unlicensed',
      role: 'admin',
      organizationId: FIXTURE_BROKERAGE_ORG_ID,
    });
  });

  it.each(
    ['pending', 'bogus', null].flatMap((status) => ORDERS.map(([order, rows]) => [status, order, rows] as const))
  )('C1: %p admin who owns a personal row (%s) -> floor/deactivated, never personal', (status, _order, rows) => {
    expect(classify(rows(withStatus(brokerageMembership('admin'), status)), FIXTURE_USER_ID)).toEqual({
      kind: 'floor',
      via: 'deactivated',
      role: 'admin',
      organizationId: FIXTURE_BROKERAGE_ORG_ID,
    });
  });

  it.each(['admin', 'agent'])('C1: unassigned %s alone -> floor/unlicensed', (role) => {
    expect(classify([withStatus(brokerageMembership(role), 'unassigned')], FIXTURE_USER_ID)).toEqual({
      kind: 'floor',
      via: 'unlicensed',
      role,
      organizationId: FIXTURE_BROKERAGE_ORG_ID,
    });
  });

  it("C1: suspended admin in somebody ELSE's personal org -> floor/deactivated (owner equality)", () => {
    expect(classify([suspendedAdmin(), personalMembershipOwnedBy()], FIXTURE_USER_ID)).toEqual({
      kind: 'floor',
      via: 'deactivated',
      role: 'admin',
      organizationId: FIXTURE_BROKERAGE_ORG_ID,
    });
  });

  it('twin: the personal-org owner alone is still floor/personal_owner', () => {
    expect(classify([personalMembership()], FIXTURE_USER_ID)).toMatchObject({ via: 'personal_owner' });
  });
});

describe.each([
  ['a deactivated member', () => classify([suspendedAdmin()], FIXTURE_USER_ID)],
  ['a member with no license assigned (BACKLOG-3851)', () => classify([withStatus(brokerageMembership('admin'), 'unassigned'), personalMembership()], FIXTURE_USER_ID)],
])('mayOpenDashboardPath for %s', (_label, make) => {
  const access = make();
  it.each(['/dashboard', '/dashboard/account', '/dashboard/support', '/dashboard/support/new', '/dashboard/support/t-1'])(
    'opens %s',
    (path) => expect(mayOpenDashboardPath(access, path)).toBe(true)
  );
  it.each([
    '/dashboard/submissions',
    '/dashboard/submissions/s-1',
    '/dashboard/my-transactions',
    '/dashboard/my-transactions/s-1',
    '/dashboard/billing',
    '/dashboard/checklists',
    '/dashboard/checklists/new',
    '/dashboard/users',
    '/dashboard/settings',
    '/dashboard/settings/scim',
    '/dashboard/accountx',
  ])('refuses %s', (path) => expect(mayOpenDashboardPath(access, path)).toBe(false));
});

// ---------------------------------------------------------------------------
// Middleware (R8): <= 2 hops, deterministic landing
// ---------------------------------------------------------------------------

describe('middleware', () => {
  const REFUSED = [
    '/dashboard/submissions',
    '/dashboard/billing',
    '/dashboard/my-transactions',
    '/dashboard/checklists',
    '/dashboard/users',
    '/dashboard/settings',
  ];

  it.each(REFUSED)('deactivated admin GET %s -> /dashboard in one hop', async (path) => {
    given([suspendedAdmin()]);
    expect(await land(path)).toEqual({ at: '/dashboard', hops: 1 });
  });

  // BACKLOG-3851: back on pay-as-you-go, they open what a solo user opens
  // (Billing, their own Checklists page; each page keeps its own gate) and
  // nothing of the brokerage.
  const SOLO_OPEN = ['/dashboard/billing', '/dashboard/checklists'];
  it.each(REFUSED.filter((p) => !SOLO_OPEN.includes(p)))(
    'deactivated admin who owns a personal org GET %s -> /dashboard',
    async (path) => {
      process.env.BILLING_ENABLED = 'true';
      given([personalMembership(), suspendedAdmin()]);
      expect(await land(path)).toEqual({ at: '/dashboard', hops: 1 });
      delete process.env.BILLING_ENABLED;
    }
  );
  it.each(SOLO_OPEN)('deactivated admin who owns a personal org GET %s is admitted (BACKLOG-3851)', async (path) => {
    process.env.BILLING_ENABLED = 'true';
    for (const rows of [[personalMembership(), suspendedAdmin()], [suspendedAdmin(), personalMembership()]]) {
      given(rows);
      expect(await hop(path)).toBeNull();
    }
    delete process.env.BILLING_ENABLED;
  });

  it.each(REFUSED)('unassigned admin who owns a personal org GET %s -> /dashboard (BACKLOG-3851)', async (path) => {
    process.env.BILLING_ENABLED = 'true';
    given([withStatus(brokerageMembership('admin'), 'unassigned'), personalMembership()]);
    expect(await land(path)).toEqual({ at: '/dashboard', hops: 1 });
    delete process.env.BILLING_ENABLED;
  });

  it.each(['/dashboard', '/dashboard/account', '/dashboard/support'])('deactivated admin GET %s is admitted', async (path) => {
    given([suspendedAdmin()]);
    expect(await hop(path)).toBeNull();
  });

  it.each([...REFUSED, '/dashboard'])(
    'deactivated AND licence-suspended GET %s -> /dashboard/account, whatever the row order',
    async (path) => {
      for (const rows of [[suspendedAdmin(), personalMembership()], [personalMembership(), suspendedAdmin()]]) {
        given(rows, SUSPENDED_LICENCE);
        expect(await land(path)).toEqual({ at: '/dashboard/account', hops: 1 });
      }
    }
  );

  it.each(REFUSED)('twin: an active admin GET %s is admitted', async (path) => {
    given([brokerageMembership('admin')]);
    expect(await hop(path)).toBeNull();
  });

  it('impersonating: the cookie path is unchanged (no membership read, no redirect)', async () => {
    given([suspendedAdmin()]);
    expect(await hop('/dashboard/submissions', 'signed.cookie.value')).toBeNull();
    expect(mockEmulator.state.selects.filter((s) => s.table === 'organization_members')).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// OAuth callback: a deactivated member is placed — no invite link, no JIT
// ---------------------------------------------------------------------------

describe('OAuth callback', () => {
  it.each([
    ['suspended admin', () => [suspendedAdmin(), pendingInvite(EMAIL, 'broker')]],
    ['suspended admin who owns a personal org', () => [personalMembership(), suspendedAdmin(), pendingInvite(EMAIL, 'broker')]],
  ])('%s -> /dashboard, no invite claimed, no JIT call, no sign-out', async (_label, rows) => {
    mockExchangeCodeForSession.mockResolvedValue({ error: null });
    given(rows());
    const response = await callback(new Request(`${ORIGIN}/auth/callback?code=fixture-code-3917`));
    expect(response.headers.get('location')).toBe(`${ORIGIN}/dashboard`);
    expect(mockEmulator.state.writes).toEqual([]);
    expect(mockRpc).not.toHaveBeenCalled();
    expect(mockSignOut).not.toHaveBeenCalled();
  });

  // BACKLOG-3851 (C2): the classifier now routes a reverted member as
  // personal_owner; the callback still treats the brokerage row as a placement.
  // With an invite link cookie and an Azure tenant: no accept_invitation, no
  // JIT, no pending-invite probe, no write.
  it.each([
    ['suspended admin who owns a personal org', () => [personalMembership(), suspendedAdmin()]],
    ['expired agent who owns a personal org', () => [withStatus(brokerageMembership('agent'), 'expired'), personalMembership()]],
    ['unassigned agent who owns a personal org', () => [withStatus(brokerageMembership('agent'), 'unassigned'), personalMembership()]],
  ])('C2: %s with an invite link cookie -> /dashboard, no RPC at all', async (_label, rows) => {
    mockExchangeCodeForSession.mockResolvedValue({ error: null });
    given(rows());
    const response = await callback(
      new Request(`${ORIGIN}/auth/callback?code=fixture-code-3851`, {
        headers: { cookie: 'keepr_invite=invite.fixture0token0for0backlog03851' },
      })
    );
    expect(response.headers.get('location')).toBe(`${ORIGIN}/dashboard`);
    expect(mockRpc).not.toHaveBeenCalled();
    expect(mockEmulator.state.writes).toEqual([]);
    expect(mockSignOut).not.toHaveBeenCalled();
  });
});
