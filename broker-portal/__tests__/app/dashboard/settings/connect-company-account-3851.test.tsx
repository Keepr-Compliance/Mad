/**
 * Desktop App Permissions card — "Connect company account". BACKLOG-3851 PR-2d.
 *
 * An admin whose brokerage has no Microsoft organization linked used to see
 * "Microsoft tenant not configured. Please contact support." Since /setup links
 * the organization for an admin, the card offers "Connect company account"
 * (Microsoft only today; the label leaves room for Google Workspace) instead:
 * it sends the browser to /auth/logout?next=setup, which signs out and opens
 * /setup (middleware sends a signed-in user away from /setup). The logout half
 * is tested in __tests__/agentFloor-3080/logout.test.ts.
 *
 * Renders the real OrgSettingsClient; only the server actions and the
 * impersonation context are mocked.
 */

import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom';

type Consent = {
  organizationId: string;
  tenantId: string | null;
  consentGranted: boolean;
  consentGrantedAt: string | null;
};

let mockConsent: Consent;
let mockImpersonating = false;

jest.mock('@/lib/actions/scim', () => ({
  getConsentStatus: async () => mockConsent,
  getRetentionPolicy: async () => ({ retentionYears: 7 }),
  getJitStatus: async () => ({ enabled: false }),
  updateRetentionPolicy: async () => ({ success: true }),
  updateJitStatus: async () => ({ success: true }),
}));

jest.mock('@/components/providers/ImpersonationProvider', () => ({
  useImpersonation: () => ({ isImpersonating: mockImpersonating }),
}));

import OrgSettingsClient from '@/app/dashboard/settings/OrgSettingsClient';
import type { OrgSettingsFeatureView } from '@/lib/org-settings-access';

const VIEW: OrgSettingsFeatureView = {
  retention: { policy: 'hidden', unlockLabel: null },
  scim: { policy: 'hidden', unlockLabel: null },
  jit: { policy: 'hidden', unlockLabel: null },
};

const HEADING = 'Desktop App Permissions';
// Literal on purpose: the test pins the founder's copy, not the constant.
const CONNECT = 'Connect company account';
const LINE =
  "Connect your brokerage's Microsoft 365 account so team members can connect their Outlook in the desktop app. Google Workspace support is coming.";
const GRANT = /grant permissions with microsoft/i;
const OLD_COPY = 'Microsoft tenant not configured. Please contact support.';
const ORIGINAL_CLIENT_ID = process.env.NEXT_PUBLIC_DESKTOP_CLIENT_ID;

function stubLocation(): void {
  // jsdom does not implement navigation; a plain object records the assignment.
  Object.defineProperty(window, 'location', {
    writable: true,
    configurable: true,
    value: { href: '', hash: '', search: '', origin: 'https://portal.test' },
  });
}

beforeEach(() => {
  mockImpersonating = false;
  mockConsent = { organizationId: 'org-1', tenantId: null, consentGranted: false, consentGrantedAt: null };
  process.env.NEXT_PUBLIC_DESKTOP_CLIENT_ID = 'desktop-client-fixture';
  stubLocation();
});

afterAll(() => {
  process.env.NEXT_PUBLIC_DESKTOP_CLIENT_ID = ORIGINAL_CLIENT_ID;
});

describe('Desktop App Permissions — Connect company account (BACKLOG-3851 PR-2d)', () => {
  it('no Microsoft organization linked: shows Connect company account and the line, not the old copy', async () => {
    render(<OrgSettingsClient features={VIEW} />);
    await screen.findByText(HEADING);
    expect(screen.getByRole('button', { name: CONNECT })).toBeEnabled();
    expect(screen.getByText(LINE)).toBeInTheDocument();
    expect(screen.queryByText(OLD_COPY)).toBeNull();
    expect(screen.queryByRole('button', { name: GRANT })).toBeNull();
  });

  it('organization linked: shows Grant, no Connect company account', async () => {
    mockConsent = { ...mockConsent, tenantId: 'tenant-fixture' };
    render(<OrgSettingsClient features={VIEW} />);
    await screen.findByText(HEADING);
    expect(screen.getByRole('button', { name: GRANT })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: CONNECT })).toBeNull();
  });

  it('organization linked but no desktop client id: no Connect company account, no Grant', async () => {
    mockConsent = { ...mockConsent, tenantId: 'tenant-fixture' };
    process.env.NEXT_PUBLIC_DESKTOP_CLIENT_ID = '';
    render(<OrgSettingsClient features={VIEW} />);
    await screen.findByText(HEADING);
    expect(screen.queryByRole('button', { name: CONNECT })).toBeNull();
    expect(screen.queryByRole('button', { name: GRANT })).toBeNull();
    expect(
      screen.getByText('Desktop app permissions are not configured for this portal. Please contact support.')
    ).toBeInTheDocument();
  });

  it('consent already granted: no Connect company account', async () => {
    mockConsent = { ...mockConsent, tenantId: 'tenant-fixture', consentGranted: true };
    render(<OrgSettingsClient features={VIEW} />);
    await screen.findByText(HEADING);
    expect(screen.queryByRole('button', { name: CONNECT })).toBeNull();
  });

  it('during a support session the button is disabled and clicking does nothing', async () => {
    mockImpersonating = true;
    render(<OrgSettingsClient features={VIEW} />);
    await screen.findByText(HEADING);
    const button = screen.getByRole('button', { name: CONNECT });
    expect(button).toBeDisabled();
    await userEvent.click(button);
    expect(window.location.href).toBe('');
  });

  it('clicking sends the browser to the sign-out route that continues to /setup', async () => {
    render(<OrgSettingsClient features={VIEW} />);
    await screen.findByText(HEADING);
    await userEvent.click(screen.getByRole('button', { name: CONNECT }));
    expect(window.location.href).toBe('/auth/logout?next=setup');
  });

  it('BACKLOG-3851 PR-2e: both action buttons sit in the right-aligned action row (flex justify-end)', async () => {
    const { unmount } = render(<OrgSettingsClient features={VIEW} />);
    await screen.findByText(HEADING);
    const connectRow = screen.getByRole('button', { name: CONNECT }).closest('[data-testid="permissions-actions"]');
    expect(connectRow).not.toBeNull();
    expect(connectRow).toHaveClass('flex', 'justify-end');
    unmount();

    mockConsent = { ...mockConsent, tenantId: 'tenant-fixture' };
    render(<OrgSettingsClient features={VIEW} />);
    await screen.findByText(HEADING);
    const grantRow = screen.getByRole('button', { name: GRANT }).closest('[data-testid="permissions-actions"]');
    expect(grantRow).not.toBeNull();
    expect(grantRow).toHaveClass('flex', 'justify-end');
  });
});
