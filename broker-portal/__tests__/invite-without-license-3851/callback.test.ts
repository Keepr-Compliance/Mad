/**
 * BACKLOG-3851 PR-2f C17, as changed by BACKLOG-3991: after accept_invitation,
 * /auth/callback's users upsert writes the sign-in fields only. Names are written
 * by sync_profile_names_from_idp before the branch (see
 * __tests__/member-name-3991/callback.test.ts), and accept_invitation fills blank
 * names from the invitation. The old "fill blank names" read is gone.
 *
 * Only the Supabase server client is mocked (the shared PostgREST emulator).
 *
 * @jest-environment node
 */

import {
  FIXTURE_BROKERAGE_ORG_ID,
  FIXTURE_USER_ID,
  createPostgrestEmulator,
  type Row,
} from '../helpers/postgrestEmulator';

const mockEmulator = createPostgrestEmulator();
const mockGetUser = jest.fn();
const mockExchangeCodeForSession = jest.fn();
const mockSignOut = jest.fn();
const mockRpc = jest.fn();

jest.mock('@/lib/supabase/server', () => ({
  createClient: jest.fn(async () => ({
    auth: { exchangeCodeForSession: mockExchangeCodeForSession, getUser: mockGetUser, signOut: mockSignOut },
    rpc: mockRpc,
    from: (table: string) => mockEmulator.from(table),
  })),
}));

import { GET } from '@/app/auth/callback/route';

const ORIGIN = 'http://localhost:3000';
const EMAIL = 'invitee-fixture-3851@fixture.example.test';
const TOKEN = 'fixture0token0for0backlog03851';
const COOKIE = `sb-fixture-auth-token=abc; keepr_invite=invite.${TOKEN}`;

function signedIn(userMetadata: Record<string, unknown>): void {
  mockExchangeCodeForSession.mockResolvedValue({ data: { session: null }, error: null });
  mockGetUser.mockResolvedValue({
    data: { user: { id: FIXTURE_USER_ID, email: EMAIL, app_metadata: { provider: 'google' }, user_metadata: userMetadata } },
  });
}

function storedUser(names: Row): void {
  mockEmulator.set({
    columnPresent: true,
    rows: { organization_members: [], users: [{ id: FIXTURE_USER_ID, email: EMAIL, ...names }] },
  });
}

async function acceptAndGetUpsert(): Promise<Record<string, unknown>> {
  mockRpc.mockImplementation(async (name: string) =>
    name === 'accept_invitation'
      ? { data: { success: true, organization_id: FIXTURE_BROKERAGE_ORG_ID, role: 'agent', license_status: 'unassigned' }, error: null }
      : { data: { success: true, updated: false }, error: null }
  );
  const res = await GET(new Request(`${ORIGIN}/auth/callback?code=fixture-code-3851`, { headers: { cookie: COOKIE } }));
  expect(res.headers.get('location')).toBe(`${ORIGIN}/dashboard`);
  const upserts = mockEmulator.state.writes.filter((w) => w.table === 'users' && w.op === 'upsert');
  expect(upserts).toHaveLength(1);
  return upserts[0].values as Record<string, unknown>;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockEmulator.reset();
  mockSignOut.mockResolvedValue({ error: null });
});

describe('C17 (BACKLOG-3991): the accept upsert writes no name field', () => {
  it.each([
    ['stored names, provider names', { full_name: 'Idp Full', name: 'Idp Full' }, { display_name: 'ann', first_name: 'Ann', last_name: 'Lee' }],
    ['blank stored names, provider names', { full_name: 'Idp Full' }, { display_name: null, first_name: null, last_name: '  ' }],
    ['no provider names', {}, { display_name: null, first_name: null, last_name: null }],
  ])('%s -> email / provider upsert only', async (_label, metadata, stored) => {
    signedIn(metadata);
    storedUser(stored);
    const values = await acceptAndGetUpsert();
    expect(values).toEqual({ id: FIXTURE_USER_ID, email: EMAIL, oauth_provider: 'google', oauth_id: FIXTURE_USER_ID });
  });
});
