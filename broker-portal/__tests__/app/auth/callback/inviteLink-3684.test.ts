/**
 * /auth/callback accepts an invitation only through its link — BACKLOG-3684.
 *
 * The invitation page stores the link's token in the keepr_invite cookie
 * (purpose "invite") before the OAuth redirect. Here:
 *   - cookie present  -> accept_invitation(that token); refusals sign out and
 *     show their /login message; an RPC error never falls through to JIT;
 *   - no cookie, a pending invitation for this account -> signed out with
 *     invite_link_required, nothing written;
 *   - every exit deletes the cookie with the Path it was set with.
 *
 * Only the Supabase server client is mocked; the real signOutLocal and
 * inviteCookie helpers run.
 *
 * @jest-environment node
 */

import {
  FIXTURE_BROKERAGE_ORG_ID,
  FIXTURE_USER_ID,
  brokerageMembership,
  createPostgrestEmulator,
  pendingInvite,
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
const EMAIL = 'invitee-fixture-3684@fixture.example.test';
const TOKEN = 'fixture0token0for0backlog03684';
const SB = 'sb-fixture-auth-token=abc; sb-fixture-auth-token-code-verifier=def';
const WITH_INVITE = `${SB}; keepr_invite=invite.${TOKEN}`;

type Rpcs = Partial<Record<string, { data: unknown; error: unknown }>>;

function signedIn(provider: 'email' | 'azure' = 'email'): void {
  mockExchangeCodeForSession.mockResolvedValue({ error: null });
  mockGetUser.mockResolvedValue({
    data: {
      user: {
        id: FIXTURE_USER_ID,
        email: EMAIL,
        app_metadata: { provider },
        user_metadata: provider === 'azure' ? { custom_claims: { tid: 'fixture-tenant-3684' } } : {},
      },
    },
  });
}

function given(rows: Row[], extra: Record<string, Row[]> = {}): void {
  mockEmulator.set({ columnPresent: true, rows: { organization_members: rows, ...extra } });
}

function rpcs(map: Rpcs): void {
  mockRpc.mockImplementation(async (name: string) => map[name] ?? { data: null, error: null });
}

async function run(cookie: string, url = `${ORIGIN}/auth/callback?code=fixture-code-3684`) {
  const response = await GET(new Request(url, { headers: { cookie } }));
  const setCookies = response.headers.getSetCookie();
  return {
    location: response.headers.get('location') ?? '',
    setCookies,
    deleted: setCookies.filter((c) => /Expires=Thu, 01 Jan 1970/i.test(c)).map((c) => c.split('=')[0]).sort(),
    inviteClear: setCookies.find((c) => c.startsWith('keepr_invite=')) ?? null,
  };
}

function rpcNames(): string[] {
  return mockRpc.mock.calls.map((c) => c[0] as string);
}

beforeEach(() => {
  jest.clearAllMocks();
  mockEmulator.reset();
  mockSignOut.mockResolvedValue({ error: null });
  rpcs({});
});

// J-cookie-used ------------------------------------------------------------
describe('from the invitation link', () => {
  it('accepts exactly the token in the cookie and lands on next', async () => {
    signedIn();
    given([pendingInvite(EMAIL, 'agent')]);
    rpcs({ accept_invitation: { data: { success: true, organization_id: FIXTURE_BROKERAGE_ORG_ID, role: 'agent' }, error: null } });

    const { location } = await run(WITH_INVITE);

    expect(location).toBe(`${ORIGIN}/dashboard`);
    expect(mockRpc).toHaveBeenCalledWith('accept_invitation', { p_token: TOKEN });
    expect(rpcNames()).toEqual(['accept_invitation']);
    expect(mockEmulator.state.writes.map((w) => `${w.table}:${w.op}`)).toEqual(['users:upsert']);
    expect(mockSignOut).not.toHaveBeenCalled();
  });

  it('ignores a cookie the setup page set (purpose setup)', async () => {
    signedIn();
    given([]);
    await run(`${SB}; keepr_invite=setup.${TOKEN}`);
    expect(mockRpc).not.toHaveBeenCalledWith('accept_invitation', expect.anything());
  });

  // J-refusals + J-signout (change A) -------------------------------------
  it.each(['invalid_invite', 'email_mismatch', 'expired', 'already_placed'])(
    'refusal %s -> signed out locally, auth cookies deleted, /login?error=%s',
    async (code) => {
      signedIn();
      given([]);
      rpcs({ accept_invitation: { data: { success: false, error: code }, error: null } });

      const { location, deleted } = await run(WITH_INVITE);

      expect(location).toBe(`${ORIGIN}/login?error=${code}`);
      expect(mockSignOut.mock.calls).toEqual([[{ scope: 'local' }]]);
      expect(deleted).toEqual(['keepr_invite', 'sb-fixture-auth-token', 'sb-fixture-auth-token-code-verifier']);
      expect(mockEmulator.state.writes).toHaveLength(0);
      expect(rpcNames()).toEqual(['accept_invitation']);
    }
  );

  it('an unrecognised refusal -> invite_failed', async () => {
    signedIn();
    given([]);
    rpcs({ accept_invitation: { data: { success: false, error: 'something_new' }, error: null } });
    expect((await run(WITH_INVITE)).location).toBe(`${ORIGIN}/login?error=invite_failed`);
  });

  // Control 14: a failed sign-out still leaves no session on the browser.
  it('a sign-out that fails still deletes the auth cookies on the response', async () => {
    signedIn();
    given([]);
    mockSignOut.mockResolvedValue({ error: new Error('fixture sign-out failure') });
    rpcs({ accept_invitation: { data: { success: false, error: 'email_mismatch' }, error: null } });

    const { location, deleted } = await run(WITH_INVITE);

    expect(location).toBe(`${ORIGIN}/login?error=email_mismatch`);
    expect(deleted).toEqual(['keepr_invite', 'sb-fixture-auth-token', 'sb-fixture-auth-token-code-verifier']);
  });

  // Control 13: an RPC error never falls through to JIT or the floor.
  it('accept_invitation RPC error -> signed out, invite_failed, no JIT', async () => {
    signedIn('azure');
    given([]);
    rpcs({
      accept_invitation: { data: null, error: { message: 'Could not find the function (PGRST202)' } },
      jit_join_organization: { data: { success: true, organization_id: FIXTURE_BROKERAGE_ORG_ID }, error: null },
    });
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    const { location, deleted } = await run(WITH_INVITE);

    expect(location).toBe(`${ORIGIN}/login?error=invite_failed`);
    expect(rpcNames()).toEqual(['accept_invitation']);
    expect(mockSignOut).toHaveBeenCalledTimes(1);
    expect(deleted).toContain('keepr_invite');
    expect(deleted).toContain('sb-fixture-auth-token');
    errorSpy.mockRestore();
  });
});

// J-nowrite ------------------------------------------------------------------
describe('without the invitation link', () => {
  it('a pending invitation for this account -> invite_link_required, nothing written', async () => {
    signedIn('azure');
    given([pendingInvite(EMAIL, 'admin')]);
    rpcs({ caller_has_pending_invite: { data: true, error: null } });

    const { location, deleted } = await run(SB);

    expect(location).toBe(`${ORIGIN}/login?error=invite_link_required`);
    expect(mockEmulator.state.writes).toHaveLength(0);
    expect(rpcNames()).toEqual(['caller_has_pending_invite']);
    expect(mockSignOut.mock.calls).toEqual([[{ scope: 'local' }]]);
    expect(deleted).toEqual(['keepr_invite', 'sb-fixture-auth-token', 'sb-fixture-auth-token-code-verifier']);
  });

  it('no pending invitation -> JIT as before', async () => {
    signedIn('azure');
    given([]);
    rpcs({
      caller_has_pending_invite: { data: false, error: null },
      jit_join_organization: { data: { success: true, organization_id: FIXTURE_BROKERAGE_ORG_ID }, error: null },
    });

    expect((await run(SB)).location).toBe(`${ORIGIN}/dashboard`);
    expect(rpcNames()).toEqual(['caller_has_pending_invite', 'jit_join_organization']);
    expect(mockEmulator.state.writes).toHaveLength(0);
  });

  it('detector RPC error -> continues as today (JIT, then not_authorized)', async () => {
    signedIn('email');
    given([]);
    rpcs({ caller_has_pending_invite: { data: null, error: { message: 'fixture timeout' } } });
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

    expect((await run(SB)).location).toBe(`${ORIGIN}/login?error=not_authorized`);
    expect(mockEmulator.state.writes).toHaveLength(0);
    errorSpy.mockRestore();
    warnSpy.mockRestore();
  });
});

// J-clear (control 15) -------------------------------------------------------
describe('every exit deletes the invite cookie, on Path=/auth', () => {
  const PATH_CLEAR = /^keepr_invite=;.*Path=\/auth(;|$)/;

  it.each<[string, () => void]>([
    ['placed full member (next)', () => given([brokerageMembership('broker')])],
    ['placed agent (floor)', () => given([brokerageMembership('agent')])],
    [
      'placed admin, consent pending',
      () =>
        given([brokerageMembership('admin')], {
          organizations: [{ id: FIXTURE_BROKERAGE_ORG_ID, graph_admin_consent_granted: false, microsoft_tenant_id: 'fixture-tenant-3684' }],
        }),
    ],
    ['accepted', () => { given([]); rpcs({ accept_invitation: { data: { success: true }, error: null } }); }],
    ['refused', () => { given([]); rpcs({ accept_invitation: { data: { success: false, error: 'expired' }, error: null } }); }],
  ])('%s', async (_name, arrange) => {
    signedIn();
    arrange();
    const { inviteClear } = await run(WITH_INVITE);
    expect(inviteClear).toMatch(PATH_CLEAR);
  });

  it('no code in the URL', async () => {
    const { location, inviteClear } = await run(WITH_INVITE, `${ORIGIN}/auth/callback`);
    expect(location).toBe(`${ORIGIN}/login?error=auth_failed`);
    expect(inviteClear).toMatch(PATH_CLEAR);
  });

  it('code exchange fails', async () => {
    mockExchangeCodeForSession.mockResolvedValue({ error: { message: 'fixture' } });
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const { inviteClear } = await run(WITH_INVITE);
    expect(inviteClear).toMatch(PATH_CLEAR);
    errorSpy.mockRestore();
  });

  it('not authorized (no membership, no invite, no JIT)', async () => {
    signedIn('email');
    given([]);
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const { location, inviteClear } = await run(SB);
    expect(location).toBe(`${ORIGIN}/login?error=not_authorized`);
    expect(inviteClear).toMatch(PATH_CLEAR);
    warnSpy.mockRestore();
  });
});
