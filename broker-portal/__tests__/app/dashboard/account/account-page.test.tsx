/**
 * My Account: who may open it, and where Session Management lives now.
 * BACKLOG-3078.
 *
 * The split is only real if Session Management ends up on EXACTLY ONE page.
 * Removing it from org settings without a home would have cost every user the
 * ability to see their devices or sign out everywhere, so both halves are
 * asserted here against the real components — the settings client is rendered
 * for real and searched for the heading, rather than trusted to have dropped it.
 */

import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';

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

const mockIsImpersonating = jest.fn(() => false);
jest.mock('@/components/providers/ImpersonationProvider', () => ({
  useImpersonation: () => ({ isImpersonating: mockIsImpersonating() }),
}));

jest.mock('@/lib/actions/getActiveDevices', () => ({
  getActiveDevices: async () => ({ success: true, devices: [] }),
}));
jest.mock('@/lib/actions/signOutAllDevices', () => ({
  signOutAllDevices: async () => ({ success: true }),
}));
jest.mock('@/lib/actions/scim', () => ({
  getConsentStatus: async () => ({
    organizationId: 'org-1',
    tenantId: null,
    consentGranted: false,
    consentGrantedAt: null,
  }),
  getRetentionPolicy: async () => ({ retentionYears: 7 }),
  getJitStatus: async () => ({ enabled: true }),
  updateRetentionPolicy: async () => ({ success: true }),
  updateJitStatus: async () => ({ success: true }),
}));

import AccountPage from '@/app/dashboard/account/page';
import AccountClient from '@/app/dashboard/account/AccountClient';
import OrgSettingsClient from '@/app/dashboard/settings/OrgSettingsClient';
import { TEST_ORG_ID, TEST_USER_ID, makeSupabaseStub } from '../../../fixtures/orgFeatures';

const SESSION_HEADING = 'Session Management';
const SIGN_OUT_ALL = 'Sign Out All Devices';

function signedInAs(role: string | null) {
  const stub = makeSupabaseStub({
    user: { id: TEST_USER_ID },
    membership: role ? { organization_id: TEST_ORG_ID, role } : null,
  });
  mockCreateClient.mockResolvedValue(stub.client);
  return stub;
}

beforeEach(() => {
  redirectTargets.length = 0;
  mockCreateClient.mockReset();
  mockGetImpersonationSession.mockReset();
  mockGetImpersonationSession.mockResolvedValue(null);
  mockIsImpersonating.mockReturnValue(false);
});

// ---------------------------------------------------------------------------
// Who gets in
// ---------------------------------------------------------------------------

describe('/dashboard/account access', () => {
  it.each([['agent'], ['broker'], ['admin'], ['it_admin']])(
    'admits %s — nothing on this page is org policy',
    async (role) => {
      signedInAs(role);
      const element = await AccountPage();
      expect(element.type).toBe(AccountClient);
    }
  );

  it('admits a signed-in user with no membership row at all', async () => {
    // A solo individual (BACKLOG-3080) has no organization_members row. Their
    // own account page must not depend on one.
    signedInAs(null);
    const element = await AccountPage();
    expect(element.type).toBe(AccountClient);
  });

  it('admits a support session through impersonation', async () => {
    // RLS on user_preferences is own-rows plus service_role with no
    // internal-role read policy, so impersonation is the ONLY way support sees
    // this page (BACKLOG-3079).
    mockGetImpersonationSession.mockResolvedValue({ target_user_id: 'target-1' });
    const element = await AccountPage();
    expect(element.type).toBe(AccountClient);
  });

  it('sends an unauthenticated caller to login', async () => {
    const stub = makeSupabaseStub({ user: null });
    mockCreateClient.mockResolvedValue(stub.client);
    await expect(AccountPage()).rejects.toThrow(REDIRECTED);
    expect(redirectTargets).toEqual(['/login']);
  });

  it('does not consult a role to decide', async () => {
    // If the page ever grew a role check it would lock out exactly the people
    // it exists for. Proven by admitting a role the org-settings page refuses.
    signedInAs('agent');
    const element = await AccountPage();
    expect(element.type).toBe(AccountClient);
  });
});

// ---------------------------------------------------------------------------
// Session Management lives here, and only here
// ---------------------------------------------------------------------------

describe('Session Management placement', () => {
  it('renders on the account page', async () => {
    render(<AccountClient />);
    expect(await screen.findByText(SESSION_HEADING)).toBeInTheDocument();
  });

  it('offers Sign Out All Devices on the account page', async () => {
    render(<AccountClient />);
    expect(await screen.findByRole('button', { name: SIGN_OUT_ALL })).toBeInTheDocument();
  });

  it('hides Sign Out All Devices during a support session', async () => {
    // A support agent must never be able to sign the customer out everywhere.
    mockIsImpersonating.mockReturnValue(true);
    render(<AccountClient />);
    await screen.findByText(SESSION_HEADING);
    expect(screen.queryByRole('button', { name: SIGN_OUT_ALL })).not.toBeInTheDocument();
  });

  it('no longer renders on org settings', async () => {
    render(
      <OrgSettingsClient
        features={{
          retention: { policy: 'enabled', unlockLabel: null },
          scim: { policy: 'hidden', unlockLabel: null },
          jit: { policy: 'hidden', unlockLabel: null },
        }}
      />
    );
    // Wait for a card that always renders, so absence is measured after the
    // page has settled rather than before it has loaded.
    await screen.findByText('Email Retention Policy');
    expect(screen.queryByText(SESSION_HEADING)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: SIGN_OUT_ALL })).not.toBeInTheDocument();
  });
});
