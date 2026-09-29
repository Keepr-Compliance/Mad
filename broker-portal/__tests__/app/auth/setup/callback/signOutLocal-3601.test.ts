/**
 * BACKLOG-3601 — the /auth/setup/callback exits that end a session end ONLY
 * this browser's session, and keep their redirects.
 *
 * Only the Supabase server client and the email helpers are mocked. The real
 * `lib/auth/signOutLocal.ts` runs, so the argument asserted below is the one
 * the helper actually passes (the guard test fails if any test mocks it).
 *
 * @jest-environment node
 */

import { BROKERAGE_ORG_POST, createPostgrestEmulator } from '../../../../helpers/postgrestEmulator';

const mockExchangeCodeForSession = jest.fn();
const mockGetUser = jest.fn();
const mockSignOut = jest.fn();
const mockRpc = jest.fn();
const mockExtractEmail = jest.fn();
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
  extractEmail: (...args: unknown[]) => mockExtractEmail(...args),
  orgNameFromEmail: () => 'Fixture Org 3601',
}));

import { GET } from '@/app/auth/setup/callback/route';

const ORIGIN = 'http://localhost:3000';
const TENANT_ID = 'fixture-tenant-3601';
// Microsoft's published tenant id for personal (consumer) accounts; the route blocks it.
const CONSUMER_TENANT_ID = '9188040d-6c67-4c5b-b112-36a304b66dad'; // pii-allow-uuid: Microsoft's public consumer-tenant constant, copied from the route under test
const ORG_ID = '00000000-0000-4000-8000-00003601a0f0'; // pii-allow-uuid: invented fixture id
const USER_ID = '00000000-0000-4000-8000-000000360170'; // pii-allow-uuid: invented fixture id
const COOKIE = 'sb-fixture-auth-token=abc; sb-fixture-auth-token-code-verifier=def; theme=dark';

function signedIn(overrides: { provider?: string; tid?: string | null } = {}): void {
  const provider = overrides.provider ?? 'azure';
  const tid = overrides.tid === undefined ? TENANT_ID : overrides.tid;
  mockExchangeCodeForSession.mockResolvedValue({ error: null });
  mockGetUser.mockResolvedValue({
    data: {
      user: {
        id: USER_ID,
        app_metadata: { provider },
        user_metadata: tid === null ? {} : { custom_claims: { tid } },
      },
    },
  });
}

async function run(url = `${ORIGIN}/auth/setup/callback?code=fixture-code-3601`) {
  const response = await GET(new Request(url, { headers: { cookie: COOKIE } }));
  return {
    location: response.headers.get('location') ?? '',
    cleared: response.headers
      .getSetCookie()
      .map((c) => c.split('=')[0])
      .sort(),
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockEmulator.reset();
  mockEmulator.set({ rows: { organization_members: [] } });
  mockSignOut.mockResolvedValue({ error: null });
  mockExtractEmail.mockReturnValue('setup-caller@fixture-3601.example.test');
  mockRpc.mockResolvedValue({
    data: { success: true, organization_id: ORG_ID, user_id: USER_ID, role: 'admin' },
    error: null,
  });
});

const EXITS: Array<[string, () => void, string]> = [
  ['azure_only (not an Azure sign-in)', () => signedIn({ provider: 'google' }), 'azure_only'],
  ['no_tenant (no tid claim)', () => signedIn({ tid: null }), 'no_tenant'],
  ['consumer_account (personal Microsoft tenant)', () => signedIn({ tid: CONSUMER_TENANT_ID }), 'consumer_account'],
  [
    'no_email (no usable email)',
    () => {
      signedIn();
      mockExtractEmail.mockReturnValue(null);
    },
    'no_email',
  ],
  [
    'provision_failed (RPC error)',
    () => {
      signedIn();
      mockRpc.mockResolvedValue({ data: null, error: { message: 'fixture rpc failure' } });
    },
    'provision_failed',
  ],
  [
    'provision_failed (RPC returned success: false)',
    () => {
      signedIn();
      mockRpc.mockResolvedValue({ data: { success: false, error: 'fixture' }, error: null });
    },
    'provision_failed',
  ],
];

describe('/auth/setup/callback — rejecting exits sign out this browser only', () => {
  it.each(EXITS)('%s', async (_name, arrange, code) => {
    arrange();
    const { location, cleared } = await run();

    expect(location).toBe(`${ORIGIN}/setup?error=${code}`);
    expect(mockSignOut.mock.calls).toEqual([[{ scope: 'local' }]]);
    expect(cleared).toEqual(['sb-fixture-auth-token', 'sb-fixture-auth-token-code-verifier']);
  });

  it('still redirects when the sign-out itself fails', async () => {
    signedIn({ provider: 'google' });
    mockSignOut.mockRejectedValue(new Error('fixture network failure'));
    const { location } = await run();
    expect(location).toBe(`${ORIGIN}/setup?error=azure_only`);
  });
});

describe('/auth/setup/callback — exits that never signed out still do not', () => {
  it('no code: auth_failed, no sign-out', async () => {
    const { location } = await run(`${ORIGIN}/auth/setup/callback`);
    expect(location).toBe(`${ORIGIN}/setup?error=auth_failed`);
    expect(mockSignOut.mock.calls).toEqual([]);
  });

  it('code exchange error: auth_failed, no sign-out', async () => {
    mockExchangeCodeForSession.mockResolvedValue({ error: { message: 'fixture exchange failure' } });
    const { location } = await run();
    expect(location).toBe(`${ORIGIN}/setup?error=auth_failed`);
    expect(mockSignOut.mock.calls).toEqual([]);
  });

  it('no user after exchange: auth_failed, no sign-out', async () => {
    mockExchangeCodeForSession.mockResolvedValue({ error: null });
    mockGetUser.mockResolvedValue({ data: { user: null } });
    const { location } = await run();
    expect(location).toBe(`${ORIGIN}/setup?error=auth_failed`);
    expect(mockSignOut.mock.calls).toEqual([]);
  });

  it('existing brokerage member: /dashboard, no sign-out', async () => {
    signedIn();
    mockEmulator.set({
      rows: {
        organization_members: [
          {
            id: `${ORG_ID}-agent`,
            user_id: USER_ID,
            role: 'agent',
            organization_id: ORG_ID,
            organizations: { ...BROKERAGE_ORG_POST, id: ORG_ID },
          },
        ],
      },
    });
    const { location } = await run();
    expect(location).toBe(`${ORIGIN}/dashboard`);
    expect(mockRpc).not.toHaveBeenCalled();
    expect(mockSignOut.mock.calls).toEqual([]);
  });
});
