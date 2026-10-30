/**
 * /auth/callback JIT after BACKLOG-4012.
 *
 * W1: a brokerage still finishing billing setup -> signed out locally,
 *     /login?error=billing_setup_pending (the function's answer AND the member trigger's
 *     P0001 'billing_setup_incomplete').
 * W2: the JIT identifier comes from the identity THIS sign-in used (newest updated_at in
 *     user.identities) and from its identity_data.custom_claims, not from
 *     app_metadata.provider (the FIRST provider) or a top-level user_metadata.hd.
 *
 * Identity shapes are transcribed: Google identity_data from production auth.identities
 * (member-name-3991/fixtures.ts GOOGLE_METADATA: hd only inside custom_claims), Azure from
 * keepr-test (AZURE_METADATA). Only the Supabase server client is mocked.
 *
 * @jest-environment node
 */

import { FIXTURE_USER_ID, createPostgrestEmulator } from '../helpers/postgrestEmulator';
import { AZURE_METADATA, GOOGLE_METADATA } from '../member-name-3991/fixtures';

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
const EMAIL = 'joiner-4012@fixture.example.test';
const SB = 'sb-fixture-auth-token=abc';
const OLD = '2026-07-01T09:00:00Z';
const NOW = '2026-10-20T12:00:00Z';

type Identity = { provider: string; updated_at: string; identity_data: Record<string, unknown> };

const azure = (at: string): Identity => ({ provider: 'azure', updated_at: at, identity_data: AZURE_METADATA });
const google = (at: string): Identity => ({ provider: 'google', updated_at: at, identity_data: GOOGLE_METADATA });
const email = (at: string): Identity => ({ provider: 'email', updated_at: at, identity_data: { email: EMAIL, sub: FIXTURE_USER_ID } });

function signedIn(firstProvider: string, identities: Identity[], user_metadata: Record<string, unknown> = {}): void {
  mockExchangeCodeForSession.mockResolvedValue({ data: { session: { provider_token: null } }, error: null });
  mockGetUser.mockResolvedValue({
    data: { user: { id: FIXTURE_USER_ID, email: EMAIL, app_metadata: { provider: firstProvider }, user_metadata, identities } },
  });
}

function jitReplies(reply: { data: unknown; error: unknown }): void {
  mockRpc.mockImplementation(async (name: string) => (name === 'jit_join_organization' ? reply : { data: null, error: null }));
}

function jitCalls(): unknown[] {
  return mockRpc.mock.calls.filter((c) => c[0] === 'jit_join_organization').map((c) => c[1]);
}

async function location(): Promise<string> {
  const response = await GET(new Request(`${ORIGIN}/auth/callback?code=fixture-code-4012`, { headers: { cookie: SB } }));
  return response.headers.get('location') ?? '';
}

beforeEach(() => {
  jest.clearAllMocks();
  mockEmulator.reset();
  mockEmulator.set({ columnPresent: true, rows: { organization_members: [] } });
  mockSignOut.mockResolvedValue({ error: null });
  jitReplies({ data: { success: false, error: 'org_not_found' }, error: null });
});

describe('W1 brokerage still finishing billing setup', () => {
  it("jit_join_organization answers billing_setup_pending -> signed out, /login?error=billing_setup_pending", async () => {
    signedIn('azure', [azure(NOW)]);
    jitReplies({ data: { success: false, error: 'billing_setup_pending' }, error: null });
    expect(await location()).toBe(`${ORIGIN}/login?error=billing_setup_pending`);
    expect(mockSignOut.mock.calls).toEqual([[{ scope: 'local' }]]);
  });

  it("the member trigger's P0001 billing_setup_incomplete -> the same", async () => {
    signedIn('azure', [azure(NOW)]);
    jitReplies({ data: null, error: { code: 'P0001', message: 'billing_setup_incomplete', details: null, hint: 'x' } });
    expect(await location()).toBe(`${ORIGIN}/login?error=billing_setup_pending`);
    expect(mockSignOut.mock.calls).toEqual([[{ scope: 'local' }]]);
  });

  it('another P0001 is not mistaken for it', async () => {
    signedIn('azure', [azure(NOW)]);
    jitReplies({ data: null, error: { code: 'P0001', message: 'seat_limit_reached' } });
    expect(await location()).toBe(`${ORIGIN}/login?error=org_not_setup`);
  });

  it('reauth_required (stale sign-in) shows the existing org_not_setup message', async () => {
    signedIn('azure', [azure(NOW)]);
    jitReplies({ data: { success: false, error: 'reauth_required' }, error: null });
    expect(await location()).toBe(`${ORIGIN}/login?error=org_not_setup`);
  });
});

describe('W2 the identity this sign-in used', () => {
  it('Google Workspace: hd from identity_data.custom_claims reaches the RPC as google_workspace', async () => {
    signedIn('google', [google(NOW)], GOOGLE_METADATA);
    await location();
    expect(jitCalls()).toEqual([{ p_provider_type: 'google_workspace', p_identifier: 'fixture-workspace.example.test' }]);
  });

  it('a top-level hd with no custom_claims.hd is not used', async () => {
    signedIn('google', [{ provider: 'google', updated_at: NOW, identity_data: { hd: 'fixture-workspace.example.test' } }], {
      hd: 'fixture-workspace.example.test',
    });
    await location();
    expect(jitCalls()).toEqual([]);
  });

  it('a consumer Google domain never JIT-joins', async () => {
    signedIn('google', [{ provider: 'google', updated_at: NOW, identity_data: { custom_claims: { hd: 'Gmail.com' } } }]);
    await location();
    expect(jitCalls()).toEqual([]);
  });

  it('first provider email, Microsoft linked later and used now -> azure_ad with that tenant', async () => {
    signedIn('email', [email(OLD), azure(NOW)]);
    await location();
    expect(jitCalls()).toEqual([{ p_provider_type: 'azure_ad', p_identifier: 'fixture-tenant-3991' }]);
  });

  it('first provider azure, this sign-in by password -> no JIT', async () => {
    signedIn('azure', [azure(OLD), email(NOW)], { custom_claims: { tid: 'fixture-tenant-3991' } });
    await location();
    expect(jitCalls()).toEqual([]);
    expect(await location()).toBe(`${ORIGIN}/login?error=not_authorized`);
  });

  it('Microsoft first, Google used now -> google_workspace, not the old tenant', async () => {
    signedIn('azure', [azure(OLD), google(NOW)], AZURE_METADATA);
    await location();
    expect(jitCalls()).toEqual([{ p_provider_type: 'google_workspace', p_identifier: 'fixture-workspace.example.test' }]);
  });
});
