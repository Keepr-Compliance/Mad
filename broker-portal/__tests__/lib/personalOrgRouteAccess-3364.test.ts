/**
 * A personal organization opens no admin route — BACKLOG-3364.
 *
 * ---------------------------------------------------------------------------
 * Why this is a control and not a change.
 * ---------------------------------------------------------------------------
 * Before this item a solo user had NO membership row, and every gate below
 * refused them on `!membership`. After it they have one — role `agent`, in an
 * organization of their own — so they now arrive at these gates carrying a
 * membership for the first time. Each gate is supposed to refuse them anyway,
 * on the role, and none of them is edited by this PR (3e27deee ruling 5).
 *
 * "Supposed to" is the part that needs measuring. The refusals here are the
 * only thing standing between a personal organization and org-wide policy:
 * retention, SCIM, JIT, the member list, invitations. The most likely wrong
 * implementation of this whole item is someone widening a role list to make a
 * personal-org user "work" in the portal — so every case below is paired with
 * that mutation, and `agent` appearing in ORG_SETTINGS_ROLES, JIT_ADMIN_ROLES
 * or SCIM_ADMIN_ROLES must turn this file red.
 *
 * The gates are NOT mocked. Each test drives the real function against a
 * PostgREST-shaped stub that applies `eq` and `in` as the database does —
 * `requireJitAccess` and `requireScimAccess` narrow by role in SQL, so a stub
 * that ignored `.in()` would report a refusal that never happened.
 *
 * @jest-environment node
 */

import {
  FIXTURE_USER_ID,
  brokerageMembership,
  createPostgrestEmulator,
  personalMembership,
  type Row,
} from '../helpers/postgrestEmulator';

const mockEmulator = createPostgrestEmulator();
const mockGetUser = jest.fn();

jest.mock('@/lib/supabase/server', () => ({
  createClient: jest.fn(async () => ({
    auth: { getUser: mockGetUser },
    from: (table: string) => mockEmulator.from(table),
    rpc: jest.fn(async () => ({ data: null, error: null })),
  })),
}));

// Every gate below reports "feature off" as the same refusal as "not
// authorized", so the feature check is forced ON. A control that let the
// feature check do the refusing would pass with the role check deleted.
jest.mock('@/lib/feature-gate', () => ({
  ...jest.requireActual('@/lib/feature-gate'),
  isFeatureEnabledFailClosed: jest.fn(async () => true),
}));

import { ORG_SETTINGS_ROLES, checkOrgSettingsAccess } from '@/lib/org-settings-access';
import { JIT_ADMIN_ROLES, requireJitAccess } from '@/lib/jit-access';
import { SCIM_ADMIN_ROLES, requireScimAccess } from '@/lib/scim-access';

function given(rows: Row[]): void {
  mockGetUser.mockResolvedValue({ data: { user: { id: FIXTURE_USER_ID } } });
  mockEmulator.set({ columnPresent: true, rows: { organization_members: rows } });
}

beforeEach(() => {
  jest.clearAllMocks();
  mockEmulator.reset();
});

describe('the role a personal organization grants', () => {
  it('is `agent`, and no admin role list contains it', () => {
    // The row this item creates, read from the same builder the other suites
    // use. If the creation function ever wrote a different role, the lists
    // below stop being the thing that refuses.
    expect(personalMembership().role).toBe('agent');

    for (const list of [ORG_SETTINGS_ROLES, JIT_ADMIN_ROLES, SCIM_ADMIN_ROLES]) {
      expect([...list]).not.toContain('agent');
      expect([...list]).toEqual(['admin', 'it_admin']);
    }
  });
});

describe('organization settings', () => {
  it('refuses a user whose only membership is their personal organization', async () => {
    given([personalMembership()]);
    expect(await checkOrgSettingsAccess()).toEqual({
      allowed: false,
      reason: 'unauthorized',
    });
  });

  it('refuses them for the same reason it refuses a user with no membership at all', async () => {
    given([personalMembership()]);
    const withPersonalRow = await checkOrgSettingsAccess();

    given([]);
    const withNoRowAtAll = await checkOrgSettingsAccess();

    expect(withPersonalRow).toEqual(withNoRowAtAll);
  });

  it('still admits a brokerage admin', async () => {
    given([brokerageMembership('admin')]);
    expect(await checkOrgSettingsAccess()).toMatchObject({ allowed: true, role: 'admin' });
  });

  it('still refuses a brokerage broker — this gate is admin-only, not portal-wide', async () => {
    given([brokerageMembership('broker')]);
    expect(await checkOrgSettingsAccess()).toEqual({
      allowed: false,
      reason: 'unauthorized',
    });
  });
});

describe('JIT provisioning settings', () => {
  it('refuses a personal-organization member', async () => {
    given([personalMembership()]);
    await expect(requireJitAccess()).rejects.toThrow('Not authorized');
  });

  it('still admits a brokerage it_admin', async () => {
    given([brokerageMembership('it_admin')]);
    await expect(requireJitAccess()).resolves.toMatchObject({ role: 'it_admin' });
  });
});

describe('SCIM settings', () => {
  it('refuses a personal-organization member', async () => {
    given([personalMembership()]);
    await expect(requireScimAccess()).rejects.toThrow('Not authorized');
  });

  it('still admits a brokerage admin', async () => {
    given([brokerageMembership('admin')]);
    await expect(requireScimAccess()).resolves.toMatchObject({ role: 'admin' });
  });
});
