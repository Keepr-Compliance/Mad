/**
 * BACKLOG-3684 — /auth/setup/callback with and without the invitation link.
 *
 * With the keepr_invite cookie that /setup?token= set (purpose "setup"), an
 * unplaced caller's invitation is accepted through accept_invitation(token,
 * tenant). Without it, auto_provision_it_admin runs as before (after file B it
 * accepts nothing). Refusals go through rejectSetup; every exit deletes the
 * cookie on Path=/auth.
 *
 * @jest-environment node
 */

import { createPostgrestEmulator } from '../../../../helpers/postgrestEmulator';

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

jest.mock('@/lib/auth/helpers', () => ({
  extractEmail: () => 'setup-invitee@fixture-3684.example.test',
}));

import { GET } from '@/app/auth/setup/callback/route';

const ORIGIN = 'http://localhost:3000';
const TENANT_ID = 'fixture-tenant-3684';
const ORG_ID = '00000000-0000-4000-8000-00003684a0f0'; // pii-allow-uuid: invented fixture id
const USER_ID = '00000000-0000-4000-8000-000000368470'; // pii-allow-uuid: invented fixture id
const TOKEN = 'fixture0setup0token03684';
const SB = 'sb-fixture-auth-token=abc';
const PATH_CLEAR = /^keepr_invite=;.*Path=\/auth(;|$)/;

async function run(cookie: string) {
  const response = await GET(new Request(`${ORIGIN}/auth/setup/callback?code=fixture-code-3684`, { headers: { cookie } }));
  const setCookies = response.headers.getSetCookie();
  return {
    location: response.headers.get('location') ?? '',
    inviteClear: setCookies.find((c) => c.startsWith('keepr_invite=')) ?? null,
    sbCleared: setCookies.some((c) => c.startsWith('sb-fixture-auth-token=;')),
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockEmulator.reset();
  mockEmulator.set({ rows: { organization_members: [] } });
  mockSignOut.mockResolvedValue({ error: null });
  mockExchangeCodeForSession.mockResolvedValue({ error: null });
  mockGetUser.mockResolvedValue({
    data: { user: { id: USER_ID, app_metadata: { provider: 'azure' }, user_metadata: { custom_claims: { tid: TENANT_ID } } } },
  });
  mockRpc.mockResolvedValue({ data: { success: true, organization_id: ORG_ID, user_id: USER_ID, role: 'admin' }, error: null });
});

describe('with the link (/setup?token=)', () => {
  it('accepts exactly that invitation with the tenant, then the consent page', async () => {
    const { location, inviteClear } = await run(`${SB}; keepr_invite=setup.${TOKEN}`);
    expect(mockRpc.mock.calls).toEqual([['accept_invitation', { p_token: TOKEN, p_tenant_id: TENANT_ID }]]);
    expect(location).toContain('/setup/consent');
    expect(inviteClear).toMatch(PATH_CLEAR);
  });

  it.each(['invalid_invite', 'email_mismatch', 'expired', 'already_placed', 'tenant_in_use', 'tenant_mismatch'])(
    'refusal %s -> rejectSetup with its own code',
    async (code) => {
      mockRpc.mockResolvedValue({ data: { success: false, error: code }, error: null });
      const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
      const { location, inviteClear, sbCleared } = await run(`${SB}; keepr_invite=setup.${TOKEN}`);
      expect(location).toBe(`${ORIGIN}/setup?error=${code}`);
      expect(mockSignOut.mock.calls).toEqual([[{ scope: 'local' }]]);
      expect(sbCleared).toBe(true);
      expect(inviteClear).toMatch(PATH_CLEAR);
      errorSpy.mockRestore();
    }
  );

  it('an RPC error (identity mismatch raises 42501) -> provision_failed', async () => {
    mockRpc.mockResolvedValue({ data: null, error: { message: 'tenant does not match the signed-in identity', code: '42501' } });
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const { location } = await run(`${SB}; keepr_invite=setup.${TOKEN}`);
    expect(location).toBe(`${ORIGIN}/setup?error=provision_failed`);
    errorSpy.mockRestore();
  });
});

describe('without the link', () => {
  it('calls auto_provision_it_admin as before (no token sent anywhere)', async () => {
    mockRpc.mockResolvedValue({ data: { success: false, error: 'no_invite' }, error: null });
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const { location, inviteClear } = await run(SB);
    expect(mockRpc.mock.calls).toEqual([['auto_provision_it_admin', { p_tenant_id: TENANT_ID, p_org_name: '', p_org_slug: '' }]]);
    expect(location).toBe(`${ORIGIN}/setup?error=no_invite`);
    expect(inviteClear).toMatch(PATH_CLEAR);
    errorSpy.mockRestore();
  });

  it('ignores a cookie the invitation page set (purpose invite)', async () => {
    await run(`${SB}; keepr_invite=invite.${TOKEN}`);
    expect(mockRpc.mock.calls[0][0]).toBe('auto_provision_it_admin');
  });
});
