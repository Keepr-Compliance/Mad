/**
 * BACKLOG-3851 PR-2f C17 (SR R5): after accept_invitation, /auth/callback writes the
 * identity provider's names into public.users ONLY where the stored field is blank.
 *
 * Stored-row shape: handle_new_user (on auth.users insert) always sets display_name
 * (full_name, name, else the email's local part) and leaves first/last NULL; accept_invitation
 * (M4) then copies the invitation's names into blank first/last (measured on keepr-test,
 * supabase/tests/backlog-3851/pr2f, N1/N2).
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
import { blankNameFill, idpProfileNames } from '@/lib/auth/profileNameFill';

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
  mockExchangeCodeForSession.mockResolvedValue({ error: null });
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
      : { data: null, error: null }
  );
  const res = await GET(new Request(`${ORIGIN}/auth/callback?code=fixture-code-3851`, { headers: { cookie: COOKIE } }));
  expect(res.headers.get('location')).toBe(`${ORIGIN}/dashboard`);
  const upserts = mockEmulator.state.writes.filter((w) => w.table === 'users' && w.op === 'upsert');
  expect(upserts).toHaveLength(1);
  return upserts[0].values as Record<string, unknown>;
}

const IDP = { full_name: 'Idp Full', given_name: 'Idp', family_name: 'Family' };

beforeEach(() => {
  jest.clearAllMocks();
  mockEmulator.reset();
  mockSignOut.mockResolvedValue({ error: null });
});

describe('C17: names fill blanks only', () => {
  it('stored names (from the invitation or an admin) are kept: no name field is written', async () => {
    signedIn(IDP);
    storedUser({ display_name: 'ann', first_name: 'Ann', last_name: 'Lee' });
    const values = await acceptAndGetUpsert();
    expect(values).toEqual({ id: FIXTURE_USER_ID, email: EMAIL, oauth_provider: 'google', oauth_id: FIXTURE_USER_ID });
  });

  it('blank first/last are filled from the identity provider; a set display_name is kept', async () => {
    signedIn(IDP);
    storedUser({ display_name: 'invitee-fixture-3851', first_name: null, last_name: '  ' });
    const values = await acceptAndGetUpsert();
    expect(values).toEqual(expect.objectContaining({ first_name: 'Idp', last_name: 'Family' }));
    expect('display_name' in values).toBe(false);
  });

  it('the identity provider gives no names: nothing name-related is written', async () => {
    signedIn({});
    storedUser({ display_name: null, first_name: null, last_name: null });
    const values = await acceptAndGetUpsert();
    expect(Object.keys(values).sort()).toEqual(['email', 'id', 'oauth_id', 'oauth_provider']);
  });
});

describe('blankNameFill / idpProfileNames', () => {
  it('maps metadata and fills only blank fields', () => {
    expect(idpProfileNames({ name: 'N', given_name: 'G' })).toEqual({ display_name: 'N', first_name: 'G', last_name: null });
    expect(blankNameFill({ display_name: 'D', first_name: '', last_name: null }, { display_name: 'X', first_name: 'G', last_name: 'F' }))
      .toEqual({ first_name: 'G', last_name: 'F' });
    expect(blankNameFill(null, { display_name: 'X', first_name: null, last_name: null })).toEqual({ display_name: 'X' });
  });
});
