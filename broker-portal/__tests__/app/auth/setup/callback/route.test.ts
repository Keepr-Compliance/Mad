/**
 * BACKLOG-3096 — where /setup sends a caller once they have been provisioned.
 *
 * THE CONTROL THIS FILE EXISTS FOR:
 *
 *   Until first-user-wins landed, `auto_provision_it_admin` made EVERY caller
 *   an admin, so sending every fresh provision to `/setup/consent` was always
 *   right. It is not any more. The second employee through /setup now joins as
 *   the org's default role, and a plain agent cannot complete a tenant-wide
 *   Microsoft admin-consent grant — the page is a dead end for them. So the
 *   callback must branch on the role the RPC actually returned.
 *
 *   `second caller lands on /download and never sees the consent URL` is that
 *   control. Revert the branch in the route and it goes red.
 *
 * WHY /download AND NOT SOMEWHERE NEW: it is where `middleware.ts` already
 * sends an agent who touches a protected route, so it is that role's existing
 * destination rather than a third one invented here. BACKLOG-3080 owns changing
 * where agents land.
 *
 * The role comes from the RPC's return value, not from a re-query, so these
 * tests drive it through the mocked `rpc` result — the same single read the
 * route makes.
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

jest.mock('@/lib/supabase/server', () => ({
  createClient: jest.fn(async () => ({
    auth: {
      exchangeCodeForSession: mockExchangeCodeForSession,
      getUser: mockGetUser,
      signOut: mockSignOut,
    },
    rpc: mockRpc,
    from: (table: string) => {
      const single = table === 'organizations' ? mockOrgSingle : mockMembershipSingle;
      const chain = {
        select: () => chain,
        eq: () => chain,
        limit: () => chain,
        single,
      };
      return chain;
    },
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

// ---------------------------------------------------------------------------
// Fixtures — every identifier invented; no real tenant, org or domain.
// ---------------------------------------------------------------------------

const ORIGIN = 'http://localhost:3000';
const TENANT_ID = 'fixture-tenant-3096-route';
const ORG_ID = '00000000-0000-4000-8000-00003096a0f0'; // pii-allow-uuid: invented fixture id, not from any live row
const USER_ID = '00000000-0000-4000-8000-000000309670'; // pii-allow-uuid: invented fixture id, not from any live row

function request(): Request {
  return new Request(`${ORIGIN}/auth/setup/callback?code=fixture-oauth-code-3096`);
}

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

/** Nobody has a membership yet, so the route calls the provisioning RPC. */
function noExistingMembership(): void {
  mockMembershipSingle.mockResolvedValue({ data: null });
}

function provisionedAs(role: string): void {
  mockRpc.mockResolvedValue({
    data: { success: true, organization_id: ORG_ID, user_id: USER_ID, role },
    error: null,
  });
}

async function locationOf(): Promise<string> {
  const response = await GET(request());
  return response.headers.get('location') ?? '';
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('/auth/setup/callback — where a freshly provisioned caller lands', () => {
  it('sends a second caller who joined as agent to /download, never to consent', async () => {
    signedInAzureUser();
    noExistingMembership();
    provisionedAs('agent');

    const location = await locationOf();

    expect(location).toBe(`${ORIGIN}/download`);
    // The dead end, stated as its own assertion so a regression names itself.
    expect(location).not.toContain('/setup/consent');
    // And the tenant id must not leak into a URL they were never meant to get.
    expect(location).not.toContain(TENANT_ID);
  });

  it('sends the first caller, who became admin, on to the consent page', async () => {
    signedInAzureUser();
    noExistingMembership();
    provisionedAs('admin');

    const location = await locationOf();

    expect(location).toContain('/setup/consent');
    expect(location).toContain(`tenant=${encodeURIComponent(TENANT_ID)}`);
    expect(location).toContain(`org=${encodeURIComponent(ORG_ID)}`);
  });

  it('sends a caller provisioned as broker to /download too', async () => {
    // An org whose default_member_role is 'broker' can produce this. Recorded
    // as a KNOWN DIVERGENCE rather than a claim it is ideal: middleware.ts
    // lets a broker reach /dashboard, so a broker provisioned here lands
    // somewhere middleware would not have sent them. Harmless — /download is a
    // page, not a trap, and their next protected-route visit goes through
    // middleware normally — but it is the non-admin rule applied literally,
    // and BACKLOG-3080 owns where non-admins land.
    signedInAzureUser();
    noExistingMembership();
    provisionedAs('broker');

    expect(await locationOf()).toBe(`${ORIGIN}/download`);
  });

  it('treats a missing role as non-admin', async () => {
    // Defence in depth: if the migration has not been applied yet, the old
    // function returns no 'role' key at all. Failing closed sends that caller
    // to /download rather than handing them the consent page by default.
    signedInAzureUser();
    noExistingMembership();
    mockRpc.mockResolvedValue({
      data: { success: true, organization_id: ORG_ID, user_id: USER_ID },
      error: null,
    });

    expect(await locationOf()).toBe(`${ORIGIN}/download`);
  });
});

describe('/auth/setup/callback — existing members are unaffected', () => {
  it('sends an existing agent to the dashboard, as before', async () => {
    signedInAzureUser();
    mockMembershipSingle.mockResolvedValue({
      data: { role: 'agent', organization_id: ORG_ID },
    });

    expect(await locationOf()).toBe(`${ORIGIN}/dashboard`);
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

    expect(await locationOf()).toContain('/setup/consent');
  });
});
