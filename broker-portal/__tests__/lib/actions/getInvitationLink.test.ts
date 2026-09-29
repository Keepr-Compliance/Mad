/**
 * getInvitationLink — the fetch-on-demand replacement for shipping
 * invitation_token with every row of the Users list (BACKLOG-3541).
 *
 * Mirrors resendInvite's authorization shape: only an admin/it_admin in the
 * SAME organization as the target member may retrieve the link, and only for
 * a member who has not yet accepted. The gate is NOT mocked — only the
 * Supabase client is.
 *
 * @jest-environment node
 */

import {
  FIXTURE_USER_ID,
  FIXTURE_BROKERAGE_ORG_ID,
  FIXTURE_INVITE_ID,
  brokerageMembership,
  createPostgrestEmulator,
  pendingInvite,
  type Row,
} from '../../helpers/postgrestEmulator';

const mockEmulator = createPostgrestEmulator();
const mockGetUser = jest.fn();

jest.mock('@/lib/supabase/server', () => ({
  createClient: jest.fn(async () => ({
    auth: { getUser: mockGetUser },
    from: (table: string) => mockEmulator.from(table),
  })),
}));

import { getInvitationLink } from '@/lib/actions/getInvitationLink';

const PENDING_WITH_TOKEN: Row = {
  ...pendingInvite('new@example.com', 'agent'),
  invitation_token: 'super-secret-invite-token',
};

function given(rows: Row[]): void {
  mockGetUser.mockResolvedValue({ data: { user: { id: FIXTURE_USER_ID } } });
  mockEmulator.set({ columnPresent: true, rows: { organization_members: rows } });
}

beforeEach(() => {
  jest.clearAllMocks();
  mockEmulator.reset();
});

describe('getInvitationLink', () => {
  it('returns the invite link for an admin viewing a pending member in their org', async () => {
    given([brokerageMembership('admin'), PENDING_WITH_TOKEN]);

    const result = await getInvitationLink({
      memberId: FIXTURE_INVITE_ID,
      organizationId: FIXTURE_BROKERAGE_ORG_ID,
    });

    expect(result).toEqual({
      success: true,
      inviteLink: expect.stringContaining('/invite/super-secret-invite-token'),
    });
  });

  it('returns the invite link for an it_admin', async () => {
    given([brokerageMembership('it_admin'), PENDING_WITH_TOKEN]);

    const result = await getInvitationLink({
      memberId: FIXTURE_INVITE_ID,
      organizationId: FIXTURE_BROKERAGE_ORG_ID,
    });

    expect(result.success).toBe(true);
  });

  it('refuses a broker (only admin/it_admin may retrieve invite links)', async () => {
    given([brokerageMembership('broker'), PENDING_WITH_TOKEN]);

    const result = await getInvitationLink({
      memberId: FIXTURE_INVITE_ID,
      organizationId: FIXTURE_BROKERAGE_ORG_ID,
    });

    expect(result).toEqual({ success: false, error: 'Not authorized' });
  });

  it('refuses an unauthenticated caller', async () => {
    mockGetUser.mockResolvedValue({ data: { user: null } });

    const result = await getInvitationLink({
      memberId: FIXTURE_INVITE_ID,
      organizationId: FIXTURE_BROKERAGE_ORG_ID,
    });

    expect(result).toEqual({ success: false, error: 'Not authenticated' });
  });

  it('refuses when the caller has no membership in the target organization', async () => {
    given([PENDING_WITH_TOKEN]); // no membership row for FIXTURE_USER_ID at all

    const result = await getInvitationLink({
      memberId: FIXTURE_INVITE_ID,
      organizationId: FIXTURE_BROKERAGE_ORG_ID,
    });

    expect(result).toEqual({ success: false, error: 'Not authorized' });
  });

  it('reports "Invitation not found" when the member row does not exist', async () => {
    given([brokerageMembership('admin')]); // no target row at all

    const result = await getInvitationLink({
      memberId: FIXTURE_INVITE_ID,
      organizationId: FIXTURE_BROKERAGE_ORG_ID,
    });

    expect(result).toEqual({ success: false, error: 'Invitation not found' });
  });

  it('refuses a member who has already accepted (user_id set)', async () => {
    given([
      brokerageMembership('admin'),
      { ...PENDING_WITH_TOKEN, user_id: 'some-other-user-id' },
    ]);

    const result = await getInvitationLink({
      memberId: FIXTURE_INVITE_ID,
      organizationId: FIXTURE_BROKERAGE_ORG_ID,
    });

    expect(result).toEqual({
      success: false,
      error: 'This user has already accepted the invitation',
    });
  });

  it('reports no link available when the pending row has no token', async () => {
    given([
      brokerageMembership('admin'),
      { ...pendingInvite('new@example.com'), invitation_token: null },
    ]);

    const result = await getInvitationLink({
      memberId: FIXTURE_INVITE_ID,
      organizationId: FIXTURE_BROKERAGE_ORG_ID,
    });

    expect(result).toEqual({ success: false, error: 'No invitation link available' });
  });
});
