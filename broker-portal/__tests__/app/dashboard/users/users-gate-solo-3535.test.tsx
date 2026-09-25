/**
 * /dashboard/users and /dashboard/users/[id] refuse a solo user — BACKLOG-3535.
 *
 * BACKLOG-3535 lets the owner of a personal organization (role `agent` there,
 * no brokerage row) into the Checklists surfaces. They must gain nothing else.
 * Both users pages gate inline (`.maybeSingle()` + admin / it_admin); before
 * this file, adding `agent` to either list left every broker-portal test green.
 *
 * The pages are rendered for real; only the Supabase client, the impersonation
 * reader and next/navigation are stand-ins. organization_members is served by
 * the BACKLOG-3364 PostgREST emulator with the transcribed personal row.
 * A brokerage admin is the positive control: the same harness lets them past
 * the gate, so a refusal below is the gate's and not the harness's.
 *
 * @jest-environment node
 */

const mockCreateClient = jest.fn();
const mockGetImpersonationSession = jest.fn();

jest.mock('@/lib/supabase/server', () => ({
  createClient: (...args: unknown[]) => mockCreateClient(...args),
}));
jest.mock('@/lib/impersonation', () => ({
  getImpersonationSession: () => mockGetImpersonationSession(),
}));
jest.mock('@/lib/impersonation-guards', () => ({
  getDataClient: jest.fn(async () => {
    throw new Error('getDataClient must not run outside impersonation');
  }),
}));
jest.mock('@/components/users/UserListClient', () => ({ __esModule: true, default: () => null }));
jest.mock('@/components/users/UserDetailsCard', () => ({ __esModule: true, default: () => null }));

const REDIRECT = 'NEXT_REDIRECT:';
const NOT_FOUND = 'NEXT_NOT_FOUND';
jest.mock('next/navigation', () => ({
  redirect: (to: string) => {
    throw new Error(`NEXT_REDIRECT:${to}`);
  },
  notFound: () => {
    throw new Error('NEXT_NOT_FOUND');
  },
}));

import UsersPage from '@/app/dashboard/users/page';
import UserDetailsPage from '@/app/dashboard/users/[id]/page';
import {
  FIXTURE_USER_ID,
  brokerageMembership,
  createPostgrestEmulator,
  personalMembership,
  type Row,
} from '../../../helpers/postgrestEmulator';

/** pii-allow-uuid: invented fixture id, a member that does not exist */
const MISSING_MEMBER_ID = '00000000-0000-4000-8000-0000003535a1';

function setup(memberships: Row[]) {
  const emu = createPostgrestEmulator({ rows: { organization_members: memberships } });
  mockCreateClient.mockResolvedValue({
    auth: { getUser: async () => ({ data: { user: { id: FIXTURE_USER_ID } } }) },
    from: (t: string) => emu.from(t),
    rpc: jest.fn(async () => ({ data: null, error: { message: 'unexpected rpc' } })),
  });
  mockGetImpersonationSession.mockResolvedValue(null);
}

async function outcome(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
    return 'rendered';
  } catch (e) {
    return (e as Error).message;
  }
}

beforeEach(() => {
  mockCreateClient.mockReset();
  mockGetImpersonationSession.mockReset();
});

describe('a solo user (personal organization only, role agent)', () => {
  it('is sent to /dashboard from /dashboard/users', async () => {
    setup([personalMembership()]);
    await expect(outcome(() => UsersPage())).resolves.toBe(`${REDIRECT}/dashboard`);
  });

  it('is sent to /dashboard from /dashboard/users/[id]', async () => {
    setup([personalMembership()]);
    await expect(
      outcome(() => UserDetailsPage({ params: Promise.resolve({ id: MISSING_MEMBER_ID }) }))
    ).resolves.toBe(`${REDIRECT}/dashboard`);
  });
});

describe('positive control: a brokerage admin passes the same gates', () => {
  it('renders /dashboard/users', async () => {
    setup([brokerageMembership('admin')]);
    await expect(outcome(() => UsersPage())).resolves.toBe('rendered');
  });

  it('gets past the /dashboard/users/[id] gate (404 for a member that does not exist)', async () => {
    setup([brokerageMembership('admin')]);
    await expect(
      outcome(() => UserDetailsPage({ params: Promise.resolve({ id: MISSING_MEMBER_ID }) }))
    ).resolves.toBe(NOT_FOUND);
  });
});
