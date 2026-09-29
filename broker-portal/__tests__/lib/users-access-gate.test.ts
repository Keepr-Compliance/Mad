/**
 * Who may view the Users list and a member's detail page — BACKLOG-3541.
 *
 * Widened from ['admin', 'it_admin'] to include 'broker' so the split editor
 * (BACKLOG-3504) is reachable from a page a broker can view. Management
 * actions (Change Role / Deactivate / Remove) are untouched — they stay
 * gated by canManage (admin/it_admin only) inside the client components.
 *
 * The most likely wrong implementation of a "widen this role list" change is
 * widening it too far, to 'agent' — so that mutation is the one this file is
 * built to catch. The gate itself is NOT mocked; only the Supabase client.
 *
 * @jest-environment node
 */

import {
  FIXTURE_USER_ID,
  brokerageMembership,
  createPostgrestEmulator,
  type Row,
} from '../helpers/postgrestEmulator';

const mockEmulator = createPostgrestEmulator();
const mockGetUser = jest.fn();

jest.mock('@/lib/supabase/server', () => ({
  createClient: jest.fn(async () => ({
    auth: { getUser: mockGetUser },
    from: (table: string) => mockEmulator.from(table),
  })),
}));

import { USERS_PAGE_ROLES, checkUsersPageAccess } from '@/lib/users-access';

function given(rows: Row[]): void {
  mockGetUser.mockResolvedValue({ data: { user: { id: FIXTURE_USER_ID } } });
  mockEmulator.set({ columnPresent: true, rows: { organization_members: rows } });
}

beforeEach(() => {
  jest.clearAllMocks();
  mockEmulator.reset();
});

describe('USERS_PAGE_ROLES', () => {
  it('is exactly admin, it_admin, broker — never agent', () => {
    expect([...USERS_PAGE_ROLES].sort()).toEqual(['admin', 'broker', 'it_admin']);
  });
});

describe('checkUsersPageAccess', () => {
  it('admits admin', async () => {
    given([brokerageMembership('admin')]);
    const result = await checkUsersPageAccess();
    expect(result.allowed).toBe(true);
  });

  it('admits it_admin', async () => {
    given([brokerageMembership('it_admin')]);
    const result = await checkUsersPageAccess();
    expect(result.allowed).toBe(true);
  });

  it('admits broker (BACKLOG-3541 widening)', async () => {
    given([brokerageMembership('broker')]);
    const result = await checkUsersPageAccess();
    expect(result.allowed).toBe(true);
  });

  it('refuses agent', async () => {
    given([brokerageMembership('agent')]);
    expect(await checkUsersPageAccess()).toEqual({
      allowed: false,
      reason: 'unauthorized',
    });
  });

  it('refuses an unauthenticated caller', async () => {
    mockGetUser.mockResolvedValue({ data: { user: null } });
    expect(await checkUsersPageAccess()).toEqual({
      allowed: false,
      reason: 'unauthenticated',
    });
  });

  it('refuses a caller with no membership row', async () => {
    given([]);
    expect(await checkUsersPageAccess()).toEqual({
      allowed: false,
      reason: 'unauthorized',
    });
  });
});
