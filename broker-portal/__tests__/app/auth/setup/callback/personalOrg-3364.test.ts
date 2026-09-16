/**
 * /auth/setup/callback and a personal organization — BACKLOG-3364.
 *
 * ---------------------------------------------------------------------------
 * The membership check here is a gate on provisioning, not on routing.
 * ---------------------------------------------------------------------------
 * `if (membership) return /dashboard` exists to stop someone who already
 * belongs to a brokerage from provisioning a second one. A solo user now holds
 * a membership — in their own organization — so read as a placement it closes
 * /setup to exactly the person it was built for: the solo agent who starts a
 * brokerage. They would land on /dashboard with no organization to run,
 * `auto_provision_it_admin` never called, and nothing on screen saying why.
 *
 * And the opposite failure: naming `organizations.personal_owner_user_id`
 * against a database without it returns 400 / 42703, `data: null`, no throw —
 * so a real brokerage admin reads as unplaced and /setup tries to provision
 * them a SECOND organization. The pre-migration cases below are that control.
 *
 * Companion to route.test.ts, which owns the BACKLOG-3096 role → destination
 * rules. This file owns only what a personal organization changes.
 *
 * @jest-environment node
 */

import {
  BROKERAGE_ORG_POST,
  PERSONAL_COLUMN,
  PERSONAL_ORG,
  createPostgrestEmulator,
} from '../../../../helpers/postgrestEmulator';

const mockExchangeCodeForSession = jest.fn();
const mockGetUser = jest.fn();
const mockSignOut = jest.fn();
const mockRpc = jest.fn();
const mockEmulator = createPostgrestEmulator();

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

import { GET } from '@/app/auth/setup/callback/route';

const ORIGIN = 'http://localhost:3000';
const TENANT_ID = 'fixture-tenant-3364-setup';
const ORG_ID = '00000000-0000-4000-8000-0000003364b1'; // pii-allow-uuid: invented fixture id
const PERSONAL_ORG_ID = '00000000-0000-4000-8000-0000003364e1'; // pii-allow-uuid: invented fixture id
const NEW_ORG_ID = '00000000-0000-4000-8000-0000003364c1'; // pii-allow-uuid: invented fixture id
const USER_ID = '00000000-0000-4000-8000-000000336471'; // pii-allow-uuid: invented fixture id

function signedInAzureUser(): void {
  mockExchangeCodeForSession.mockResolvedValue({ error: null });
  mockGetUser.mockResolvedValue({
    data: {
      user: {
        id: USER_ID,
        email: 'setup-caller-3364@fixture.example.test',
        app_metadata: { provider: 'azure' },
        user_metadata: { custom_claims: { tid: TENANT_ID } },
      },
    },
  });
}

/** A membership in someone else's brokerage. `phase` picks the embed shape. */
function brokerageRow(role: string, phase: 'pre' | 'post' = 'post'): Record<string, unknown> {
  const organizations =
    phase === 'post'
      ? { ...BROKERAGE_ORG_POST, id: ORG_ID }
      : // Pre-migration: the same record with the key simply absent, which is
        // what a database without the column returns for `organizations(*)`.
        (() => {
          const { [PERSONAL_COLUMN]: _omitted, ...rest } = BROKERAGE_ORG_POST;
          return { ...rest, id: ORG_ID };
        })();
  return { id: `${ORG_ID}-${role}`, user_id: USER_ID, role, organization_id: ORG_ID, organizations };
}

/** The row BACKLOG-3364 creates for a solo user: their own organization. */
function personalRow(): Record<string, unknown> {
  return {
    id: `${PERSONAL_ORG_ID}-agent`,
    user_id: USER_ID,
    role: 'agent',
    organization_id: PERSONAL_ORG_ID,
    organizations: { ...PERSONAL_ORG, id: PERSONAL_ORG_ID, [PERSONAL_COLUMN]: USER_ID },
  };
}

function given(rows: Record<string, unknown>[], columnPresent = true): void {
  mockEmulator.set({ columnPresent, rows: { organization_members: rows } });
}

function provisionedAs(role: string): void {
  mockRpc.mockResolvedValue({
    data: { success: true, organization_id: NEW_ORG_ID, user_id: USER_ID, role },
    error: null,
  });
}

async function callbackRedirect(): Promise<string> {
  const response = await GET(
    new Request(`${ORIGIN}/auth/setup/callback?code=fixture-oauth-code-3364`)
  );
  return response.headers.get('location') ?? '';
}

beforeEach(() => {
  jest.clearAllMocks();
  mockEmulator.reset();
});

describe('a solo user holding only a personal organization can still set up a brokerage', () => {
  it('calls auto_provision_it_admin instead of returning to the dashboard', async () => {
    signedInAzureUser();
    given([personalRow()]);
    provisionedAs('admin');

    const location = await callbackRedirect();

    expect(mockRpc).toHaveBeenCalledWith(
      'auto_provision_it_admin',
      expect.objectContaining({ p_tenant_id: TENANT_ID })
    );
    // First caller becomes admin, so on to the tenant-wide consent grant.
    expect(location).toContain('/setup/consent');
    expect(location).toContain(`org=${encodeURIComponent(NEW_ORG_ID)}`);
  });

  it('provisions identically to a user who has no membership row at all', async () => {
    signedInAzureUser();
    given([personalRow()]);
    provisionedAs('agent');
    const withPersonalRow = await callbackRedirect();
    const rpcCallsWithPersonalRow = mockRpc.mock.calls.length;

    jest.clearAllMocks();
    mockEmulator.reset();
    signedInAzureUser();
    given([]);
    provisionedAs('agent');
    const withNoRowAtAll = await callbackRedirect();

    expect(rpcCallsWithPersonalRow).toBe(1);
    expect(withPersonalRow).toBe(`${ORIGIN}/dashboard`);
    expect(withPersonalRow).toBe(withNoRowAtAll);
  });
});

describe('a brokerage membership still means already placed', () => {
  it.each(['agent', 'broker'])('sends an existing %s to the dashboard without provisioning', async (role) => {
    signedInAzureUser();
    given([brokerageRow(role)]);

    expect(await callbackRedirect()).toBe(`${ORIGIN}/dashboard`);
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it('prefers the brokerage row when a personal row is returned first', async () => {
    signedInAzureUser();
    given([personalRow(), brokerageRow('broker')]);

    expect(await callbackRedirect()).toBe(`${ORIGIN}/dashboard`);
    expect(mockRpc).not.toHaveBeenCalled();
  });
});

describe('against a database without the column', () => {
  it('does not try to provision a second organization for a placed admin', async () => {
    signedInAzureUser();
    mockEmulator.set({
      columnPresent: false,
      rows: {
        organization_members: [brokerageRow('it_admin', 'pre')],
        organizations: [
          { id: ORG_ID, graph_admin_consent_granted: false, microsoft_tenant_id: TENANT_ID },
        ],
      },
    });

    const location = await callbackRedirect();

    expect(mockRpc).not.toHaveBeenCalled();
    expect(location).toContain('/setup/consent');
    expect(location).toContain(`org=${encodeURIComponent(ORG_ID)}`);
  });

  it('still sends an existing agent to the dashboard', async () => {
    signedInAzureUser();
    given([brokerageRow('agent', 'pre')], false);

    expect(await callbackRedirect()).toBe(`${ORIGIN}/dashboard`);
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it('never names the column in any query it sends', async () => {
    signedInAzureUser();
    given([brokerageRow('agent', 'pre')], false);
    await callbackRedirect();

    expect(mockEmulator.state.selects.length).toBeGreaterThan(0);
    for (const s of mockEmulator.state.selects) {
      expect(s.columns).not.toContain(PERSONAL_COLUMN);
    }
  });
});
