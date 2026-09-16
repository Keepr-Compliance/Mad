/**
 * /auth/callback and a personal organization — BACKLOG-3364.
 *
 * ---------------------------------------------------------------------------
 * The bug this file is about is a DEAD END, not a wrong page.
 * ---------------------------------------------------------------------------
 * The membership read at the top of this route is the first thing that happens
 * after sign-in, and the branch below it returns `/download` for role `agent`.
 * A solo user now holds exactly such a row — in their own organization — so
 * without this change the route returns before it has looked at
 * `organization_members` for a pending invite at all. A brokerage could invite
 * a solo agent, the agent could sign in, and the invite would never be claimed:
 * no error, no retry, just the download page, forever. That is BACKLOG-3359's
 * whole path closing the day personal organizations ship.
 *
 * The second failure runs the other way: if the query names
 * `organizations.personal_owner_user_id` while production has not had the
 * migration applied, PostgREST answers 400 / 42703 with `data: null` and no
 * throw. Every brokerage member then falls past BOTH role branches into the
 * invite lookup, then JIT, and ends at `signOut()` with `not_authorized`. A
 * working portal stops admitting anyone, and every test about solo users still
 * passes. The pre-migration cases below are what stands between that and a
 * deploy.
 *
 * The stub answers 42703 the way the database does; its responses were captured
 * by PR 1 from a real PostgREST (supabase/tests/backlog-3364/fixtures/).
 *
 * @jest-environment node
 */

import {
  FIXTURE_BROKERAGE_ORG_ID,
  FIXTURE_USER_ID,
  PERSONAL_COLUMN,
  brokerageMembership,
  createPostgrestEmulator,
  pendingInvite,
  personalMembership,
  type Row,
} from '../../../helpers/postgrestEmulator';

const mockEmulator = createPostgrestEmulator();
const mockGetUser = jest.fn();
const mockExchangeCodeForSession = jest.fn();
const mockSignOut = jest.fn();
const mockRpc = jest.fn();

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

import { GET } from '@/app/auth/callback/route';

const ORIGIN = 'http://localhost:3000';
const EMAIL = 'solo-fixture-3364@fixture.example.test';

/** Signed in with a plain email account — no Azure tenant, no Workspace domain. */
function signedIn(overrides: Record<string, unknown> = {}): void {
  mockExchangeCodeForSession.mockResolvedValue({ error: null });
  mockGetUser.mockResolvedValue({
    data: {
      user: {
        id: FIXTURE_USER_ID,
        email: EMAIL,
        app_metadata: { provider: 'email' },
        user_metadata: {},
        ...overrides,
      },
    },
  });
}

function given(rows: Row[], columnPresent = true): void {
  mockEmulator.set({ columnPresent, rows: { organization_members: rows } });
}

async function callbackRedirect(): Promise<string> {
  const response = await GET(new Request(`${ORIGIN}/auth/callback?code=fixture-code-3364`));
  return response.headers.get('location') ?? '';
}

beforeEach(() => {
  jest.clearAllMocks();
  mockEmulator.reset();
  mockRpc.mockResolvedValue({ data: null, error: null });
});

// ---------------------------------------------------------------------------
// 1. The door this item exists to keep open.
// ---------------------------------------------------------------------------

describe('a solo user holding only a personal organization', () => {
  it('reaches the pending-invite branch and the invite is claimed', async () => {
    signedIn();
    given([personalMembership(), pendingInvite(EMAIL, 'agent')]);

    const location = await callbackRedirect();

    // The invite was linked: the users row was upserted and the membership
    // row updated to carry this user.
    const writes = mockEmulator.state.writes;
    expect(writes.map((w) => `${w.table}:${w.op}`)).toEqual([
      'users:upsert',
      'organization_members:update',
    ]);
    expect(writes[1].values).toMatchObject({
      user_id: FIXTURE_USER_ID,
      license_status: 'active',
      invitation_token: null,
    });
    // An invited agent belongs on the desktop download page — but only AFTER
    // the invite was claimed, which is the whole difference.
    expect(location).toBe(`${ORIGIN}/download`);
    expect(mockSignOut).not.toHaveBeenCalled();
  });

  it('sends an invited broker on to the dashboard once linked', async () => {
    signedIn();
    given([personalMembership(), pendingInvite(EMAIL, 'broker')]);

    expect(await callbackRedirect()).toBe(`${ORIGIN}/dashboard`);
    expect(mockEmulator.state.writes).toHaveLength(2);
  });

  it('reaches the JIT branch when the account carries a Microsoft tenant', async () => {
    signedIn({
      app_metadata: { provider: 'azure' },
      user_metadata: { custom_claims: { tid: 'fixture-tenant-3364' } },
    });
    given([personalMembership()]);
    mockRpc.mockResolvedValue({
      data: { success: true, organization_id: FIXTURE_BROKERAGE_ORG_ID, role: 'admin' },
      error: null,
    });

    const location = await callbackRedirect();

    expect(mockRpc).toHaveBeenCalledWith('jit_join_organization', {
      p_provider_type: 'azure_ad',
      p_identifier: 'fixture-tenant-3364',
    });
    expect(location).toBe(`${ORIGIN}/dashboard`);
  });

  it('with no invite and no JIT path, ends exactly where a user with no row ends', async () => {
    signedIn();
    given([personalMembership()]);
    const withPersonalRow = await callbackRedirect();
    const signOutCallsWithPersonalRow = mockSignOut.mock.calls.length;

    jest.clearAllMocks();
    signedIn();
    given([]);
    const withNoRowAtAll = await callbackRedirect();

    // BACKLOG-3080 owns changing this destination. This item must not move it.
    expect(withPersonalRow).toBe(`${ORIGIN}/login?error=not_authorized`);
    expect(withPersonalRow).toBe(withNoRowAtAll);
    expect(signOutCallsWithPersonalRow).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 2. Brokerage routing is untouched.
// ---------------------------------------------------------------------------

describe('brokerage membership still decides the destination', () => {
  it('sends a brokerage agent to /download without touching the invite branch', async () => {
    signedIn();
    given([brokerageMembership('agent'), pendingInvite(EMAIL, 'broker')]);

    expect(await callbackRedirect()).toBe(`${ORIGIN}/download`);
    // The invite must NOT be claimed: this user is already placed.
    expect(mockEmulator.state.writes).toHaveLength(0);
  });

  it('sends a brokerage broker to the dashboard', async () => {
    signedIn();
    given([brokerageMembership('broker')]);
    expect(await callbackRedirect()).toBe(`${ORIGIN}/dashboard`);
  });

  it('still routes an admin whose org has not granted consent to the consent page', async () => {
    signedIn();
    mockEmulator.set({
      columnPresent: true,
      rows: {
        organization_members: [brokerageMembership('admin')],
        organizations: [
          {
            id: FIXTURE_BROKERAGE_ORG_ID,
            graph_admin_consent_granted: false,
            microsoft_tenant_id: 'fixture-tenant-3364',
          },
        ],
      },
    });

    const location = await callbackRedirect();
    expect(location).toContain('/setup/consent');
    expect(location).toContain(`org=${encodeURIComponent(FIXTURE_BROKERAGE_ORG_ID)}`);
  });

  it('prefers the brokerage row when a personal row is returned first', async () => {
    signedIn();
    given([personalMembership(), brokerageMembership('broker')]);
    expect(await callbackRedirect()).toBe(`${ORIGIN}/dashboard`);
  });
});

// ---------------------------------------------------------------------------
// 3. A database that has NOT had the migration applied.
// ---------------------------------------------------------------------------

describe('against a database without the column', () => {
  it('still sends a brokerage broker to the dashboard, never to signOut', async () => {
    signedIn();
    given([brokerageMembership('broker', 'pre')], false);

    expect(await callbackRedirect()).toBe(`${ORIGIN}/dashboard`);
    expect(mockSignOut).not.toHaveBeenCalled();
  });

  it('still sends a brokerage agent to /download and claims no invite', async () => {
    signedIn();
    given([brokerageMembership('agent', 'pre'), pendingInvite(EMAIL, 'broker')], false);

    expect(await callbackRedirect()).toBe(`${ORIGIN}/download`);
    expect(mockEmulator.state.writes).toHaveLength(0);
  });

  it('never names the column in any query it sends', async () => {
    signedIn();
    given([brokerageMembership('agent', 'pre')], false);
    await callbackRedirect();

    expect(mockEmulator.state.selects.length).toBeGreaterThan(0);
    for (const s of mockEmulator.state.selects) {
      expect(s.columns).not.toContain(PERSONAL_COLUMN);
    }
  });
});
