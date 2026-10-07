/**
 * /auth/callback and the portal floor — BACKLOG-3080 (C-callback).
 *
 * The order is: brokerage membership -> pending invite -> JIT -> personal-org
 * OWNER -> floor -> otherwise sign this browser out. Each case below pins one
 * step of that order, and every sign-out is asserted with its arguments.
 *
 * @jest-environment node
 */

import {
  FIXTURE_BROKERAGE_ORG_ID,
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
const EMAIL = 'floor-fixture-3080@fixture.example.test';
const TENANT = 'fixture-tenant-3080';
const DASHBOARD = `${ORIGIN}/dashboard`;
const LOCAL = { scope: 'local' };

type Provider = 'email' | 'azure' | 'google';

function signedIn(provider: Provider = 'email'): void {
  mockExchangeCodeForSession.mockResolvedValue({ error: null });
  const user_metadata =
    provider === 'azure'
      ? { custom_claims: { tid: TENANT } }
      : provider === 'google'
        ? { hd: 'fixture-workspace.example.test' }
        : {};
  mockGetUser.mockResolvedValue({
    data: {
      user: { id: FIXTURE_USER_ID, email: EMAIL, app_metadata: { provider }, user_metadata },
    },
  });
}

function given(rows: Row[]): void {
  mockEmulator.set({ columnPresent: true, rows: { organization_members: rows } });
}

/** jit_join_organization's two failure payloads, as the callback reads them. */
function jitFails(error: 'org_not_setup' | 'jit_disabled'): void {
  mockRpc.mockResolvedValue({ data: { success: false, error }, error: null });
}

async function callbackRedirect(): Promise<string> {
  const response = await GET(new Request(`${ORIGIN}/auth/callback?code=fixture-code-3080`));
  return response.headers.get('location') ?? '';
}

beforeEach(() => {
  jest.clearAllMocks();
  mockEmulator.reset();
  mockRpc.mockResolvedValue({ data: null, error: null });
});

// (a) The owner is admitted even when JIT fails, and JIT still ran first.
describe('(a) personal-org owner whose JIT join fails', () => {
  it.each(['org_not_setup', 'jit_disabled'] as const)(
    'Azure tenant, JIT %s -> /dashboard, no sign-out, JIT called',
    async (error) => {
      signedIn('azure');
      given([personalMembership()]);
      jitFails(error);

      expect(await callbackRedirect()).toBe(DASHBOARD);
      expect(mockSignOut).not.toHaveBeenCalled();
      expect(mockRpc).toHaveBeenCalledWith('jit_join_organization', {
        p_provider_type: 'azure_ad',
        p_identifier: TENANT,
      });
    }
  );

  it('no JIT identifier (email sign-in) -> /dashboard, no sign-out', async () => {
    signedIn('email');
    given([personalMembership()]);

    expect(await callbackRedirect()).toBe(DASHBOARD);
    expect(mockSignOut).not.toHaveBeenCalled();
    expect(mockRpc).not.toHaveBeenCalled();
  });
});

// (b) No membership: signed out with LOCAL scope, error code kept.
describe('(b) no membership', () => {
  it.each([
    ['org_not_setup', 'org_not_setup'],
    ['jit_disabled', 'jit_disabled'],
  ] as const)('Azure tenant, JIT %s -> /login?error=%s, one local sign-out', async (error, code) => {
    signedIn('azure');
    given([]);
    jitFails(error);

    expect(await callbackRedirect()).toBe(`${ORIGIN}/login?error=${code}`);
    expect(mockSignOut).toHaveBeenCalledTimes(1);
    expect(mockSignOut).toHaveBeenCalledWith(LOCAL);
  });

  it('Google Workspace, JIT RPC errors -> org_not_setup, one local sign-out', async () => {
    signedIn('google');
    given([]);
    mockRpc.mockResolvedValue({ data: null, error: { message: 'fixture rpc error' } });
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    expect(await callbackRedirect()).toBe(`${ORIGIN}/login?error=org_not_setup`);
    expect(mockSignOut).toHaveBeenCalledTimes(1);
    expect(mockSignOut).toHaveBeenCalledWith(LOCAL);
    errorSpy.mockRestore();
  });

  it('no JIT identifier -> /login?error=not_authorized, one local sign-out', async () => {
    signedIn('email');
    given([]);
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

    expect(await callbackRedirect()).toBe(`${ORIGIN}/login?error=not_authorized`);
    expect(mockSignOut).toHaveBeenCalledTimes(1);
    expect(mockSignOut).toHaveBeenCalledWith(LOCAL);
    warnSpy.mockRestore();
  });
});

// (c) The invite branch runs BEFORE the owner is admitted.
describe('(c) personal-org owner with a pending invite', () => {
  it('claims the invite for the session user, lands on /dashboard, never calls JIT', async () => {
    signedIn('azure');
    given([personalMembership(), pendingInvite(EMAIL, 'agent')]);

    expect(await callbackRedirect()).toBe(DASHBOARD);
    const writes = mockEmulator.state.writes;
    expect(writes.map((w) => `${w.table}:${w.op}`)).toEqual([
      'users:upsert',
      'organization_members:update',
    ]);
    expect(writes[1].values).toMatchObject({ user_id: FIXTURE_USER_ID, license_status: 'active' });
    expect(mockRpc).not.toHaveBeenCalled();
    expect(mockSignOut).not.toHaveBeenCalled();
  });
});

// (d) A member who is not the owner is not a portal user.
describe('(d) member of a personal org somebody else owns', () => {
  it('no invite, no JIT -> signed out locally with not_authorized', async () => {
    signedIn('email');
    given([personalMembershipOwnedBy()]);
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

    expect(await callbackRedirect()).toBe(`${ORIGIN}/login?error=not_authorized`);
    expect(mockSignOut).toHaveBeenCalledTimes(1);
    expect(mockSignOut).toHaveBeenCalledWith(LOCAL);
    warnSpy.mockRestore();
  });
});

// (e) JIT success decides before the owner check is needed.
describe('(e) personal-org owner whose JIT join succeeds', () => {
  it('calls JIT and lands on /dashboard', async () => {
    signedIn('azure');
    given([personalMembership()]);
    mockRpc.mockResolvedValue({
      data: { success: true, organization_id: FIXTURE_BROKERAGE_ORG_ID, role: 'agent' },
      error: null,
    });

    expect(await callbackRedirect()).toBe(DASHBOARD);
    expect(mockRpc).toHaveBeenCalledTimes(1);
    expect(mockSignOut).not.toHaveBeenCalled();
  });
});

// (f) A brokerage agent never reaches the invite branch.
describe('(f) brokerage agent', () => {
  it('-> /dashboard, no invite lookup, no JIT, no sign-out', async () => {
    signedIn('azure');
    given([brokerageMembership('agent'), pendingInvite(EMAIL, 'broker')]);

    expect(await callbackRedirect()).toBe(DASHBOARD);
    expect(mockEmulator.state.writes).toHaveLength(0);
    expect(
      mockEmulator.state.selects.filter((s) => s.table === 'organization_members')
    ).toHaveLength(1);
    expect(mockRpc).not.toHaveBeenCalled();
    expect(mockSignOut).not.toHaveBeenCalled();
  });

  it('two brokerage rows [agent, broker] -> /dashboard (middleware floors it)', async () => {
    signedIn('email');
    given([brokerageMembership('agent'), { ...brokerageMembership('broker'), id: 'second-row' }]);
    expect(await callbackRedirect()).toBe(DASHBOARD);
    expect(mockSignOut).not.toHaveBeenCalled();
  });
});
