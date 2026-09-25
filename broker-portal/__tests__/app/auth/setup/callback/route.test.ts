/**
 * BACKLOG-3096 — where /setup sends a caller once they have been provisioned.
 *
 * ON `toBeNull()` AS THE "ADMIT" ASSERTION: it does distinguish a real admit
 * from a crash, but NOT for the reason first written here. `middleware.ts`
 * catches, sees a protected route, and redirects to `/login` — it does not fall
 * through returning no location. So a thrown middleware is visibly different
 * from an admitted one, and `middleware redirects a crashed session to /login`
 * below pins that down instead of leaving it asserted in a comment.
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

import {
  BROKERAGE_ORG_POST,
  createPostgrestEmulator,
} from '../../../../helpers/postgrestEmulator';

const mockExchangeCodeForSession = jest.fn();
const mockGetUser = jest.fn();
const mockSignOut = jest.fn();
const mockRpc = jest.fn();

/**
 * Table-aware query stub shared by the route's client and middleware's.
 *
 * BACKLOG-3364 replaced the hand-rolled chain that used to sit here. That one
 * ignored every argument and resolved a fixed `.single()` value, which was
 * enough while both readers ended in `.limit(1).single()` — and is true of
 * neither any more: both now embed the organization record and await an ARRAY.
 * It also could not tell a query that named
 * `organizations.personal_owner_user_id` from one that did not, so a reader
 * that named it — fatal against a database that has not had that migration
 * applied — would have passed here. The shared emulator answers 42703 for that,
 * from the responses PR 1 captured off a real PostgREST.
 */
const mockEmulator = createPostgrestEmulator();

// The route builds its client here...
jest.mock('@/lib/supabase/server', () => ({
  createClient: jest.fn(async () => ({
    auth: {
      exchangeCodeForSession: mockExchangeCodeForSession,
      getUser: mockGetUser,
      signOut: mockSignOut,
    },
    rpc: mockRpc,
    from: (table: string) => mockEmulator.from(table),
  })),
}));

// ...and middleware builds its own, straight from @supabase/ssr. Mocking both
// is what lets the real middleware run against the same fixture membership.
jest.mock('@supabase/ssr', () => ({
  createServerClient: jest.fn(() => ({
    auth: { getUser: mockGetUser },
    from: (table: string) => mockEmulator.from(table),
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

/** A membership row in someone else's brokerage — never a personal org. */
function brokerageRow(role: string): Record<string, unknown> {
  return {
    id: `${ORG_ID}-${role}`,
    user_id: USER_ID,
    role,
    organization_id: ORG_ID,
    // BACKLOG-3364: the embedded organization record the query now asks for,
    // transcribed from a real PostgREST response. `personal_owner_user_id` is
    // null here — this is a brokerage.
    organizations: { ...BROKERAGE_ORG_POST, id: ORG_ID },
  };
}

function noExistingMembership(): void {
  mockEmulator.set({ rows: { organization_members: [] } });
}

function existingMembership(role: string): void {
  mockEmulator.set({ rows: { organization_members: [brokerageRow(role)] } });
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
  // Establish the session HERE rather than relying on the caller. Two tests
  // below call this without a preceding callback run, and `jest.clearAllMocks()`
  // clears calls but NOT implementations — so they used to pass only because a
  // previous test's `mockGetUser.mockResolvedValue(...)` leaked into them. Run
  // alone with `-t`, they failed with `/login`. A test that depends on its
  // neighbour reads green until the neighbour is deleted or reordered.
  signedInAzureUser();
  existingMembership(role);
  const response = await middleware(new NextRequest(`${ORIGIN}${path}`));
  return response.headers.get('location');
}

beforeEach(() => {
  jest.clearAllMocks();
  mockEmulator.reset();
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
  it('gives a provisioned agent the floor: /dashboard admitted, an admin path refused', async () => {
    // BACKLOG-3080 (rulings fb4699c8, 893f1660 / 181aaa59): an agent gets the
    // portal floor, not /download. The refusal moves to paths above the floor.
    signedInAzureUser();
    noExistingMembership();
    provisionedAs('agent');

    const fromCallback = await callbackRedirect();
    expect(fromCallback).toBe(`${ORIGIN}/dashboard`);

    // Real middleware.ts, real NextRequest, same membership role.
    expect(await middlewareVerdict('/dashboard', 'agent')).toBeNull();
    expect(await middlewareVerdict('/dashboard/users', 'agent')).toBe(`${ORIGIN}/dashboard`);
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

  it('redirects a crashed session to /login — so null really does mean admitted', async () => {
    // The control on the control, stated correctly. If middleware throws it
    // does NOT return a null location: the catch block (BACKLOG-1486) sees a
    // protected route, builds `new URL('/login', request.url)` — no
    // `redirectTo`, unlike the unauthenticated branch above it — clears the
    // Supabase cookies and redirects. That is what makes `toBeNull()` above a
    // real admit rather than "nothing happened", and it is exactly what the two
    // order-dependent tests printed when they ran alone without a session.
    mockGetUser.mockRejectedValue(new Error('fixture: session lookup failed'));
    const response = await middleware(new NextRequest(`${ORIGIN}/dashboard`));
    expect(response.headers.get('location')).toBe(`${ORIGIN}/login`);
  });
});

describe('/auth/setup/callback — existing members are unaffected', () => {
  it('sends an existing agent to the dashboard, as before', async () => {
    signedInAzureUser();
    existingMembership('agent');

    expect(await callbackRedirect()).toBe(`${ORIGIN}/dashboard`);
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it('still routes an existing admin without consent to the consent page', async () => {
    // Guards the canGrantAdminConsent() extraction: this branch used to spell
    // the role check inline, and must not have narrowed.
    signedInAzureUser();
    mockEmulator.set({
      rows: {
        organization_members: [brokerageRow('it_admin')],
        organizations: [
          {
            id: ORG_ID,
            graph_admin_consent_granted: false,
            microsoft_tenant_id: TENANT_ID,
          },
        ],
      },
    });

    expect(await callbackRedirect()).toContain('/setup/consent');
  });
});
