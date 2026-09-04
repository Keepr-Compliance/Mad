/**
 * /dashboard/settings refuses a non-admin on the SERVER — BACKLOG-3078.
 *
 * Before this item the page was a client component with no gate of its own.
 * Every server action it called checked admin/it_admin separately, so a
 * non-admin who loaded the URL got the page chrome, an empty consent card, a
 * retention dropdown reading 7 years and a JIT toggle reading on — all of it
 * organization policy — and only discovered it was refused when a save failed.
 * A missing nav link is not a gate, and neither is a card that renders and then
 * apologises.
 *
 * The gate is NOT mocked. Each test drives the real checkOrgSettingsAccess and
 * the real resolveOrgSettingsFeatures against a stubbed Supabase client, so a
 * regression in either shows up here rather than in a mock's expectations.
 */

const mockCreateClient = jest.fn();
const mockGetImpersonationSession = jest.fn();

jest.mock('@/lib/supabase/server', () => ({
  createClient: (...args: unknown[]) => mockCreateClient(...args),
}));
jest.mock('@/lib/impersonation', () => ({
  getImpersonationSession: () => mockGetImpersonationSession(),
}));

const REDIRECTED = 'NEXT_REDIRECT';
const redirectTargets: string[] = [];
jest.mock('next/navigation', () => ({
  redirect: (to: string) => {
    redirectTargets.push(to);
    throw new Error(REDIRECTED);
  },
}));

import SettingsPage from '@/app/dashboard/settings/page';
import OrgSettingsClient from '@/app/dashboard/settings/OrgSettingsClient';
import {
  ENTERPRISE_PLAN_FEATURES,
  TEAM_PLAN_FEATURES,
  TEST_ORG_ID,
  TEST_USER_ID,
  makeSupabaseStub,
} from '../../../fixtures/orgFeatures';
import type { OrgFeatures } from '@/lib/feature-gate';

function signedInAs(role: string | null, features: OrgFeatures = TEAM_PLAN_FEATURES) {
  const stub = makeSupabaseStub({
    user: { id: TEST_USER_ID },
    membership: role ? { organization_id: TEST_ORG_ID, role } : null,
    rpc: { data: features, error: null },
  });
  mockCreateClient.mockResolvedValue(stub.client);
  return stub;
}

let errorSpy: jest.SpyInstance;

beforeEach(() => {
  redirectTargets.length = 0;
  mockCreateClient.mockReset();
  mockGetImpersonationSession.mockReset();
  mockGetImpersonationSession.mockResolvedValue(null);
  errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => errorSpy.mockRestore());

// ---------------------------------------------------------------------------
// Who gets in
// ---------------------------------------------------------------------------

describe('/dashboard/settings role gate', () => {
  it.each([['admin'], ['it_admin']])('admits %s', async (role) => {
    signedInAs(role);
    const element = await SettingsPage();
    expect(element.type).toBe(OrgSettingsClient);
  });

  it.each([['agent'], ['broker']])(
    'refuses %s — the request is redirected, not merely unlinked',
    async (role) => {
      signedInAs(role);
      await expect(SettingsPage()).rejects.toThrow(REDIRECTED);
      expect(redirectTargets).toEqual(['/dashboard']);
    }
  );

  it('refuses a signed-in user with no membership row', async () => {
    signedInAs(null);
    await expect(SettingsPage()).rejects.toThrow(REDIRECTED);
  });

  it('refuses an unauthenticated caller', async () => {
    const stub = makeSupabaseStub({ user: null });
    mockCreateClient.mockResolvedValue(stub.client);
    await expect(SettingsPage()).rejects.toThrow(REDIRECTED);
  });

  it('refuses BEFORE resolving any feature state', async () => {
    // Ordering matters: reporting "not authorized" before touching the feature
    // RPC means a refused caller learns nothing about the org's plan.
    const stub = signedInAs('agent');
    await expect(SettingsPage()).rejects.toThrow(REDIRECTED);
    expect(stub.rpc).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Support sessions
// ---------------------------------------------------------------------------

describe('/dashboard/settings during impersonation', () => {
  it('admits a support session, which has no authenticated user', async () => {
    // TASK-2138 shipped a read-only view here. A getUser()-only gate would
    // refuse it and regress that.
    mockGetImpersonationSession.mockResolvedValue({ target_user_id: 'target-1' });
    const element = await SettingsPage();
    expect(element.type).toBe(OrgSettingsClient);
  });

  it('keeps both unbuilt cards hidden for a support session', async () => {
    mockGetImpersonationSession.mockResolvedValue({ target_user_id: 'target-1' });
    const element = await SettingsPage();
    expect(element.props.features.scim.policy).toBe('hidden');
    expect(element.props.features.jit.policy).toBe('hidden');
  });

  it('does not print a plan-upsell label at a support session', async () => {
    // Every fail-closed check refuses without an authenticated user, so a naive
    // reuse of the normal path would tell an enterprise customer's support
    // agent that retention is "Available on Enterprise".
    mockGetImpersonationSession.mockResolvedValue({ target_user_id: 'target-1' });
    const element = await SettingsPage();
    expect(element.props.features.retention.unlockLabel).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// gray-vs-hide, resolved server-side
// ---------------------------------------------------------------------------

describe('/dashboard/settings card policies', () => {
  it('grays retention for a team plan and names what unlocks it', async () => {
    signedInAs('admin', TEAM_PLAN_FEATURES);
    const element = await SettingsPage();
    expect(element.props.features.retention).toEqual({
      policy: 'grayed',
      unlockLabel: 'Available on Enterprise',
    });
  });

  it('enables retention for an enterprise plan', async () => {
    signedInAs('admin', ENTERPRISE_PLAN_FEATURES);
    const element = await SettingsPage();
    expect(element.props.features.retention).toEqual({
      policy: 'enabled',
      unlockLabel: null,
    });
  });

  it.each([['scim'], ['jit']])(
    'hides %s on every plan — it does not exist, so no plan can sell it',
    async (card) => {
      signedInAs('admin', ENTERPRISE_PLAN_FEATURES);
      const element = await SettingsPage();
      expect(element.props.features[card]).toEqual({
        policy: 'hidden',
        unlockLabel: null,
      });
    }
  );

  it('hides the unbuilt cards when the feature RPC errors', async () => {
    const stub = makeSupabaseStub({
      user: { id: TEST_USER_ID },
      membership: { organization_id: TEST_ORG_ID, role: 'admin' },
      rpc: { data: null, error: { message: 'boom' } },
    });
    mockCreateClient.mockResolvedValue(stub.client);
    const element = await SettingsPage();
    expect(element.props.features.scim.policy).toBe('hidden');
    expect(element.props.features.jit.policy).toBe('hidden');
    // Fail-closed on retention means grayed, not enabled: a broken RPC must
    // never leave an org-wide policy control writable.
    expect(element.props.features.retention.policy).toBe('grayed');
  });
});
