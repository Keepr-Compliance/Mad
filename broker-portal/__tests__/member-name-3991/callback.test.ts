/**
 * BACKLOG-3991 C25 / C26 / C30: /auth/callback sends the identity provider's names
 * to sync_profile_names_from_idp exactly once, on the USER client, BEFORE any branch
 * decides where the user lands, and a failure there never changes the landing.
 *
 * The user client (lib/supabase/server) and the service client (lib/supabase/service)
 * are distinct mocks, so a build that calls the function on a service client (where
 * auth.uid() is NULL and nothing is ever written) is red.
 *
 * @jest-environment node
 */

import {
  FIXTURE_BROKERAGE_ORG_ID,
  FIXTURE_USER_ID,
  brokerageMembership,
  createPostgrestEmulator,
  personalMembership,
  type Row,
} from '../helpers/postgrestEmulator';
import { AZURE_METADATA, FIXTURE_TOKEN, spyConsole } from './fixtures';

const mockEmulator = createPostgrestEmulator();
const mockGetUser = jest.fn();
const mockExchangeCodeForSession = jest.fn();
const mockSignOut = jest.fn();
const mockUserRpc = jest.fn();
const mockServiceRpc = jest.fn();
const mockOrder: string[] = [];

jest.mock('@/lib/supabase/server', () => ({
  createClient: jest.fn(async () => ({
    auth: { exchangeCodeForSession: mockExchangeCodeForSession, getUser: mockGetUser, signOut: mockSignOut },
    rpc: (...args: unknown[]) => {
      mockOrder.push(`rpc:${args[0] as string}`);
      return mockUserRpc(...args);
    },
    from: (table: string) => {
      mockOrder.push(`from:${table}`);
      return mockEmulator.from(table);
    },
  })),
}));
jest.mock('@/lib/supabase/service', () => ({
  createServiceClient: jest.fn(() => ({ rpc: mockServiceRpc, from: (t: string) => mockEmulator.from(t) })),
}));

import { GET } from '@/app/auth/callback/route';

const ORIGIN = 'http://localhost:3000';
const EMAIL = 'agent-3991@fixture.example.test';
const TOKEN = 'fixture0token0for0backlog03991';
const SYNC = 'sync_profile_names_from_idp';
const NAMES = { p_first: 'Avery', p_last: 'Stone', p_display: 'Avery Stone' };

type Branch = 'full' | 'brokerage-placed' | 'accept' | 'jit' | 'floor' | 'refusal';

function arrange(branch: Branch, syncReply: () => Promise<unknown> = async () => ({ data: { success: true, updated: true }, error: null })) {
  mockExchangeCodeForSession.mockResolvedValue({ data: { session: { provider_token: FIXTURE_TOKEN } }, error: null });
  const provider = branch === 'jit' ? 'azure' : 'azure';
  const user_metadata =
    branch === 'jit' ? AZURE_METADATA : { ...AZURE_METADATA, custom_claims: { ...(AZURE_METADATA.custom_claims as object), tid: undefined } };
  mockGetUser.mockResolvedValue({
    data: { user: { id: FIXTURE_USER_ID, email: EMAIL, app_metadata: { provider }, user_metadata } },
  });
  const rows: Record<Branch, Row[]> = {
    full: [brokerageMembership('broker')],
    'brokerage-placed': [brokerageMembership('agent')],
    accept: [],
    jit: [],
    floor: [personalMembership()],
    refusal: [],
  };
  mockEmulator.set({ columnPresent: true, rows: { organization_members: rows[branch], users: [{ id: FIXTURE_USER_ID, email: EMAIL }] } });
  mockUserRpc.mockImplementation(async (name: string) => {
    if (name === SYNC) return syncReply();
    if (name === 'accept_invitation')
      return { data: { success: true, organization_id: FIXTURE_BROKERAGE_ORG_ID, role: 'agent', license_status: 'unassigned' }, error: null };
    if (name === 'jit_join_organization')
      return branch === 'jit'
        ? { data: { success: true, organization_id: FIXTURE_BROKERAGE_ORG_ID, role: 'agent' }, error: null }
        : { data: { success: false, error: 'org_not_setup' }, error: null };
    return { data: null, error: null };
  });
}

async function land(branch: Branch): Promise<string> {
  const headers = branch === 'accept' ? { cookie: `keepr_invite=invite.${TOKEN}` } : undefined;
  const res = await GET(new Request(`${ORIGIN}/auth/callback?code=fixture-code-3991`, { headers }));
  return res.headers.get('location') ?? '';
}

const EXPECTED: Record<Branch, string> = {
  full: `${ORIGIN}/dashboard`,
  'brokerage-placed': `${ORIGIN}/dashboard`,
  accept: `${ORIGIN}/dashboard`,
  jit: `${ORIGIN}/dashboard`,
  floor: `${ORIGIN}/dashboard`,
  refusal: `${ORIGIN}/login?error=not_authorized`,
};
const BRANCHES = Object.keys(EXPECTED) as Branch[];

let consoleSpy: ReturnType<typeof spyConsole>;
beforeEach(() => {
  jest.clearAllMocks();
  mockEmulator.reset();
  mockOrder.length = 0;
  mockSignOut.mockResolvedValue({ error: null });
  consoleSpy = spyConsole();
});
afterEach(() => consoleSpy.restore());

describe('C25 one call, user client, before the branch', () => {
  it.each(BRANCHES)('%s: called exactly once with the provider names, on the user client, before any table read', async (branch) => {
    arrange(branch);
    expect(await land(branch)).toBe(EXPECTED[branch]);
    const syncCalls = mockUserRpc.mock.calls.filter((c) => c[0] === SYNC);
    expect(syncCalls).toEqual([[SYNC, NAMES]]);
    expect(mockServiceRpc).not.toHaveBeenCalled();
    expect(mockOrder[0]).toBe(`rpc:${SYNC}`);
  });
});

describe('C26 a failure never changes the landing and never logs the token', () => {
  const failures: Array<[string, () => Promise<unknown>]> = [
    ['returned error', async () => ({ data: null, error: { code: 'PGRST202', message: 'missing' } })],
    ['success:false', async () => ({ data: { success: false, error: 'no_user_row' }, error: null })],
    ['throw', async () => { throw new Error(`boom ${FIXTURE_TOKEN}`); }],
  ];
  for (const [label, reply] of failures) {
    it.each(BRANCHES)(`${label} on %s -> same landing, logged without the token`, async (branch) => {
      arrange(branch, reply);
      expect(await land(branch)).toBe(EXPECTED[branch]);
      const lines = consoleSpy.calls();
      expect(lines.some((l) => l.startsWith('sync_profile_names_from_idp'))).toBe(true);
      expect(lines.filter((l) => l.includes(FIXTURE_TOKEN))).toEqual([]);
    });
  }
});

describe('C30 the accept branch writes no names itself', () => {
  it('upsert carries id / email / oauth_provider / oauth_id only; accept_invitation is still called', async () => {
    arrange('accept');
    expect(await land('accept')).toBe(EXPECTED.accept);
    expect(mockUserRpc).toHaveBeenCalledWith('accept_invitation', { p_token: TOKEN });
    const upserts = mockEmulator.state.writes.filter((w) => w.table === 'users' && w.op === 'upsert');
    expect(upserts).toHaveLength(1);
    expect(Object.keys(upserts[0].values as Row).sort()).toEqual(['email', 'id', 'oauth_id', 'oauth_provider']);
    expect(mockOrder.filter((o) => o === 'from:users')).toEqual(['from:users']);
  });
});
