/**
 * BACKLOG-3962 PR4a, /auth/callback after JIT (R1): existing_account and domain_managed have
 * their own /login codes; domain_managed replaces only the generic JIT outcomes; the owner of a
 * personal organization still gets the floor.
 *
 * RPC payloads are transcribed from the database on keepr-test
 * (supabase/tests/backlog-3962/results-pr4a-2026-11-12.txt: jit_join_organization answered
 * {"error": "existing_account", "success": false}; caller_domain_managed answered
 * {"domain": ..., "blocked": true, "organization_name": ...} and {"blocked": false}).
 *
 * @jest-environment node
 */

import { FIXTURE_USER_ID, createPostgrestEmulator, personalMembership } from '../helpers/postgrestEmulator';

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
const EMAIL = 'joiner-3962p4@a-3962p4.example.test';
const TENANT = 'fixture-tenant-3962p4';

const BLOCKED = { domain: 'a-3962p4.example.test', blocked: true, organization_name: 'Fixture Brokerage A' };
const NOT_BLOCKED = { blocked: false };

function signedIn(provider: 'azure' | 'email' = 'azure'): void {
  mockExchangeCodeForSession.mockResolvedValue({ data: { session: { provider_token: null } }, error: null });
  const identity_data = provider === 'azure' ? { custom_claims: { tid: TENANT } } : { email: EMAIL };
  mockGetUser.mockResolvedValue({
    data: {
      user: {
        id: FIXTURE_USER_ID,
        email: EMAIL,
        app_metadata: { provider },
        user_metadata: {},
        identities: [{ provider, updated_at: '2026-11-12T12:00:00Z', identity_data }],
      },
    },
  });
}

function replies(jit: unknown, managed: unknown): void {
  mockRpc.mockImplementation(async (name: string) => {
    if (name === 'jit_join_organization') return { data: jit, error: null };
    if (name === 'caller_domain_managed') return { data: managed, error: null };
    return { data: null, error: null };
  });
}

const called = (name: string) => mockRpc.mock.calls.filter((c) => c[0] === name).length;

async function location(): Promise<string> {
  const response = await GET(new Request(`${ORIGIN}/auth/callback?code=fixture-code-3962p4`));
  return response.headers.get('location') ?? '';
}

beforeEach(() => {
  jest.clearAllMocks();
  mockEmulator.reset();
  mockEmulator.set({ columnPresent: true, rows: { organization_members: [] } });
  mockSignOut.mockResolvedValue({ error: null });
});

describe('R1 own /login codes', () => {
  it('existing_account -> signed out, /login?error=existing_account (not org_not_setup)', async () => {
    signedIn();
    replies({ error: 'existing_account', success: false }, NOT_BLOCKED);
    expect(await location()).toBe(`${ORIGIN}/login?error=existing_account`);
    expect(mockSignOut).toHaveBeenCalledWith({ scope: 'local' });
  });

  it('already_placed -> /login?error=already_placed', async () => {
    signedIn();
    replies({ error: 'already_placed', success: false }, NOT_BLOCKED);
    expect(await location()).toBe(`${ORIGIN}/login?error=already_placed`);
  });

  it('domain_not_verified -> org_not_setup (no new message)', async () => {
    signedIn();
    replies({ error: 'domain_not_verified', success: false }, NOT_BLOCKED);
    expect(await location()).toBe(`${ORIGIN}/login?error=org_not_setup`);
  });

  it('blocked domain, JIT generic refusal -> /login?error=domain_managed', async () => {
    signedIn();
    replies({ error: 'domain_not_verified', success: false }, BLOCKED);
    expect(await location()).toBe(`${ORIGIN}/login?error=domain_managed`);
    expect(mockSignOut).toHaveBeenCalledWith({ scope: 'local' });
  });

  it('blocked domain, email sign-in (no JIT target) -> domain_managed instead of not_authorized', async () => {
    signedIn('email');
    replies(null, BLOCKED);
    expect(await location()).toBe(`${ORIGIN}/login?error=domain_managed`);
    expect(called('jit_join_organization')).toBe(0);
  });
});

describe('precedence', () => {
  it.each(['existing_account', 'already_placed', 'billing_setup_pending'])(
    '%s keeps its own code over domain_managed',
    async (code) => {
      signedIn();
      replies({ error: code, success: false }, BLOCKED);
      expect(await location()).toBe(`${ORIGIN}/login?error=${code}`);
    }
  );

  it('jit_disabled on a blocked domain -> domain_managed', async () => {
    signedIn();
    replies({ error: 'jit_disabled', success: false }, BLOCKED);
    expect(await location()).toBe(`${ORIGIN}/login?error=domain_managed`);
  });

  it('personal-organization owner keeps the floor and is never asked', async () => {
    signedIn();
    mockEmulator.set({ columnPresent: true, rows: { organization_members: [personalMembership()] } });
    replies({ error: 'existing_account', success: false }, BLOCKED);
    expect(await location()).toBe(`${ORIGIN}/dashboard`);
    expect(called('caller_domain_managed')).toBe(0);
    expect(mockSignOut).not.toHaveBeenCalled();
  });

  it('a JIT join goes to next and never asks caller_domain_managed', async () => {
    signedIn();
    replies({ success: true, organization_id: 'fixture-org', role: 'agent', already_member: false }, BLOCKED);
    expect(await location()).toBe(`${ORIGIN}/dashboard`);
    expect(called('caller_domain_managed')).toBe(0);
  });
});
