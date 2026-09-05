/**
 * BACKLOG-3096 — where /setup sends a caller once they have been provisioned.
 *
 * THE CONTROL THIS FILE EXISTS FOR:
 *
 *   Until first-user-wins landed, `auto_provision_it_admin` made EVERY caller
 *   an admin, so sending every fresh provision to `/setup/consent` was always
 *   right. It is not any more. The second employee through /setup now joins as
 *   the org's default role, and a plain agent cannot complete a tenant-wide
 *   Microsoft admin-consent grant — the page is a dead end for them.
 *
 * WHY THE CALLBACK SENDS EVERY NON-ADMIN TO /dashboard AND NOTHING ELSE:
 *
 *   `middleware.ts` already owns role → destination for every protected
 *   request. If the callback owned a second copy of that table, the two would
 *   drift — and they already would have: an earlier version of this branch
 *   sent every non-admin to /download, which is correct for an agent and wrong
 *   for a broker, whom middleware admits to /dashboard.
 *
 *   So these tests assert BOTH HOPS: the callback's redirect, and then what
 *   the REAL `middleware.ts` does with it. Driving the second hop through the
 *   actual middleware — not a restatement of its rules — is what stops this
 *   suite passing against a callback that hardcodes a per-role destination.
 *   A callback that shortcut straight to /download would fail hop 1 while the
 *   final destination still looked right.
 *
 * @jest-environment node
 */

// ---------------------------------------------------------------------------
// Mock setup -- must be before imports
// ---------------------------------------------------------------------------

const mockExchangeCodeForSession = jest.fn();
const mockGetUser = jest.fn();
const mockSignOut = jest.fn();
const mockRpc = jest.fn();
const mockMembershipSingle = jest.fn();
const mockOrgSingle = jest.fn();

/** Table-aware query chain shared by the route's client and middleware's. */
function queryChain(table: string) {
  const single = table === 'organizations' ? mockOrgSingle : mockMembershipSingle;
  const chain = {
    select: () => chain,
    eq: () => chain,
    limit: () => chain,
    single,
  };
  return chain;
}

// The route builds its client here...
jest.mock('@/lib/supabase/server', () => ({
  createClient: jest.fn(async () => ({
    auth: {
      exchangeCodeForSession: mockExchangeCodeForSession,
      getUser: mockGetUser,
      signOut: mockSignOut,
    },
    rpc: mockRpc,
    from: queryChain,
  })),
}));

// ...and middleware builds its own, straight from @supabase/ssr. Mocking both
// is what lets the real middleware run against the same fixture membership.
jest.mock('@supabase/ssr', () => ({
  createServerClient: jest.fn(() => ({
    auth: { getUser: mockGetUser },
    from: queryChain,
  })),
}));

jest.mock('@/lib/auth/helpers', () => ({
  extractEmail: () => 'setup-caller@fixture-3096.example.test',
  orgNameFromEmail: () => 'Fixture Org 3096',
}));

// ---------------------------------------------------------------------------
// Imports
// ---------------------------------------------------------------------------

import { GET } from '@/app/auth/setup/callback/route';
import { middleware } from '@/middleware';
import { NextRequest } from 'next/server';

// ---------------------------------------------------------------------------
// Fixtures — every identifier invented; no real tenant, org or domain.
// ---------------------------------------------------------------------------

const ORIGIN = 'http://localhost:3000';
const TENANT_ID = 'fixture-tenant-3096-route';
const ORG_ID = '00000000-0000-4000-8000-00003096a0f0'; // pii-allow-uuid: invented fixture id, not from any live row
const USER_ID = '00000000-0000-4000-8000-000000309670'; // pii-allow-uuid: invented fixture id, not from any live row

/** Signed in through Azure, tenant present — the happy path up to the branch. */
function signedInAzureUser(): void {
  mockExchangeCodeForSession.mockResolvedValue({ error: null });
  mockGetUser.mockResolvedValue({
    data: {
      user: {
        id: USER_ID,
        app_metadata: { provider: 'azure' },
        user_metadata: { custom_claims: { tid: TENANT_ID } },
      },
    },
  });
}

function noExistingMembership(): void {
  mockMembershipSingle.mockResolvedValue({ data: null });
}

function provisionedAs(role: string | undefined): void {
  const data: Record<string, unknown> = {
    success: true,
    organization_id: ORG_ID,
    user_id: USER_ID,
  };
  if (role !== undefined) data.role = role;
  mockRpc.mockResolvedValue({ data, error: null });
}

/** HOP 1 — what the callback itself decides. */
async function callbackRedirect(): Promise<string> {
  const response = await GET(
    new Request(`${ORIGIN}/auth/setup/callback?code=fixture-oauth-code-3096`)
  );
  return response.headers.get('location') ?? '';
}

/**
 * HOP 2 — what the REAL middleware does with that redirect, for a user holding
 * `role`. Returns the redirect location, or null when middleware admits the
 * request through to the page it asked for.
 */
async function middlewareVerdict(path: string, role: string): Promise<string | null> {
  mockMembershipSingle.mockResolvedValue({ data: { role, organization_id: ORG_ID } });
  const response = await middleware(new NextRequest(`${ORIGIN}${path}`));
  return response.headers.get('location');
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('/auth/setup/callback — hop 1: the callback names one destination', () => {
  it('sends a second caller who joined as agent to /dashboard, never to consent', async () => {
    signedInAzureUser();
    noExistingMembership();
    provisionedAs('agent');

    const location = await callbackRedirect();

    // The callback must NOT shortcut to /download. That is middleware's call,
    // and a callback that made it here would be a second routing authority.
    expect(location).toBe(`${ORIGIN}/dashboard`);
    expect(location).not.toContain('/download');
    expect(location).not.toContain('/setup/consent');
    // And the tenant id must not leak into a URL they were never meant to get.
    expect(location).not.toContain(TENANT_ID);
  });

  it('sends a caller provisioned as broker to /dashboard as well', async () => {
    signedInAzureUser();
    noExistingMembership();
    provisionedAs('broker');

    const location = await callbackRedirect();

    expect(location).toBe(`${ORIGIN}/dashboard`);
    expect(location).not.toContain('/download');
  });

  it('sends the first caller, who became admin, on to the consent page', async () => {
    signedInAzureUser();
    noExistingMembership();
    provisionedAs('admin');

    const location = await callbackRedirect();

    expect(location).toContain('/setup/consent');
    expect(location).toContain(`tenant=${encodeURIComponent(TENANT_ID)}`);
    expect(location).toContain(`org=${encodeURIComponent(ORG_ID)}`);
  });

  it('treats a missing role as non-admin', async () => {
    // Defence in depth: if the migration has not been applied yet, the old
    // function returns no 'role' key at all. Failing closed sends that caller
    // to /dashboard rather than handing them the consent page by default.
    signedInAzureUser();
    noExistingMembership();
    provisionedAs(undefined);

    expect(await callbackRedirect()).toBe(`${ORIGIN}/dashboard`);
  });

  it('never emits the consent URL unless the returned role is admin', async () => {
    // The whole point of BACKLOG-3096, stated once over every role the RPC can
    // return plus the failure shapes. Enumerated, not sampled.
    for (const role of ['agent', 'broker', 'it_admin', 'admin', undefined, null, '']) {
      jest.clearAllMocks();
      signedInAzureUser();
      noExistingMembership();
      provisionedAs(role as string | undefined);

      const location = await callbackRedirect();
      const isAdminRole = role === 'admin' || role === 'it_admin';

      expect(location.includes('/setup/consent')).toBe(isAdminRole);
    }
  });
});

describe('hop 2: middleware is the only role → destination authority', () => {
  it('bounces a provisioned agent from /dashboard to /download', async () => {
    signedInAzureUser();
    noExistingMembership();
    provisionedAs('agent');

    const fromCallback = await callbackRedirect();
    expect(fromCallback).toBe(`${ORIGIN}/dashboard`);

    // Real middleware.ts, real NextRequest, same membership role.
    const final = await middlewareVerdict('/dashboard', 'agent');
    expect(final).toBe(`${ORIGIN}/download`);
  });

  it('admits a provisioned broker to /dashboard', async () => {
    signedInAzureUser();
    noExistingMembership();
    provisionedAs('broker');

    const fromCallback = await callbackRedirect();
    expect(fromCallback).toBe(`${ORIGIN}/dashboard`);

    // No redirect: middleware lets a broker through to the page.
    expect(await middlewareVerdict('/dashboard', 'broker')).toBeNull();
  });

  it('admits an it_admin to /dashboard too', async () => {
    expect(await middlewareVerdict('/dashboard', 'it_admin')).toBeNull();
  });

  it('admits an admin to /dashboard', async () => {
    expect(await middlewareVerdict('/dashboard', 'admin')).toBeNull();
  });
});

describe('/auth/setup/callback — existing members are unaffected', () => {
  it('sends an existing agent to the dashboard, as before', async () => {
    signedInAzureUser();
    mockMembershipSingle.mockResolvedValue({
      data: { role: 'agent', organization_id: ORG_ID },
    });

    expect(await callbackRedirect()).toBe(`${ORIGIN}/dashboard`);
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it('still routes an existing admin without consent to the consent page', async () => {
    // Guards the canGrantAdminConsent() extraction: this branch used to spell
    // the role check inline, and must not have narrowed.
    signedInAzureUser();
    mockMembershipSingle.mockResolvedValue({
      data: { role: 'it_admin', organization_id: ORG_ID },
    });
    mockOrgSingle.mockResolvedValue({
      data: { graph_admin_consent_granted: false, microsoft_tenant_id: TENANT_ID },
    });

    expect(await callbackRedirect()).toContain('/setup/consent');
  });
});
