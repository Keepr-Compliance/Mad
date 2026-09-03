/**
 * The two SCIM surfaces a person can reach — BACKLOG-3087.
 *
 *  1. The card on Settings, which is what puts "SCIM Provisioning" in front of
 *     an IT admin in the first place.
 *  2. The /dashboard/settings/scim route, which must refuse on the server even
 *     when nothing links to it.
 *
 * The route test does NOT mock the client component: it asserts the page
 * renders the real ScimSettingsClient, so the file split that this item
 * performed is proven wired rather than assumed.
 */

import { render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';

const mockGetScimFeatureStatus = jest.fn();
const mockIsScimProvisioningEnabled = jest.fn();

jest.mock('@/lib/actions/scim', () => ({
  getScimFeatureStatus: () => mockGetScimFeatureStatus(),
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

jest.mock('@/components/providers/ImpersonationProvider', () => ({
  useImpersonation: () => ({ isImpersonating: false }),
}));
jest.mock('@/components/SignOutAllButton', () => ({
  SignOutAllButton: () => null,
}));
jest.mock('@/components/ActiveSessionsList', () => ({
  ActiveSessionsList: () => null,
}));

jest.mock('@/lib/scim-access', () => ({
  isScimProvisioningEnabled: () => mockIsScimProvisioningEnabled(),
}));

const NOT_FOUND = 'NEXT_NOT_FOUND';
jest.mock('next/navigation', () => ({
  notFound: () => {
    throw new Error(NOT_FOUND);
  },
}));

import SettingsPage from '@/app/dashboard/settings/page';
import ScimSettingsPage from '@/app/dashboard/settings/scim/page';
import ScimSettingsClient from '@/app/dashboard/settings/scim/ScimSettingsClient';

const CARD_TEXT = 'SCIM Provisioning';

beforeEach(() => {
  mockGetScimFeatureStatus.mockReset();
  mockIsScimProvisioningEnabled.mockReset();
});

// ---------------------------------------------------------------------------
// 1. The settings card
// ---------------------------------------------------------------------------

describe('Settings page — SCIM card', () => {
  it('renders the card when the feature is on', async () => {
    mockGetScimFeatureStatus.mockResolvedValue({ enabled: true });
    render(<SettingsPage />);
    const card = await screen.findByText(CARD_TEXT);
    expect(card).toBeInTheDocument();
    expect(card.closest('a')).toHaveAttribute('href', '/dashboard/settings/scim');
  });

  it('does NOT render the card when the feature is off', async () => {
    mockGetScimFeatureStatus.mockResolvedValue({ enabled: false });
    render(<SettingsPage />);
    // Wait for a sibling section that always renders, so absence is measured
    // after the page has settled rather than before it has loaded.
    await screen.findByText('Session Management');
    expect(screen.queryByText(CARD_TEXT)).not.toBeInTheDocument();
  });

  it('does NOT render the card when the status call rejects', async () => {
    mockGetScimFeatureStatus.mockRejectedValue(new Error('network'));
    render(<SettingsPage />);
    await screen.findByText('Session Management');
    expect(screen.queryByText(CARD_TEXT)).not.toBeInTheDocument();
  });

  it('does NOT render the card when the status payload is not literally true', async () => {
    // A server action that somehow answers with a truthy non-boolean must not
    // be read as consent.
    mockGetScimFeatureStatus.mockResolvedValue({ enabled: 'yes' });
    render(<SettingsPage />);
    await screen.findByText('Session Management');
    expect(screen.queryByText(CARD_TEXT)).not.toBeInTheDocument();
  });

  it('asks the server exactly once', async () => {
    mockGetScimFeatureStatus.mockResolvedValue({ enabled: true });
    render(<SettingsPage />);
    await screen.findByText(CARD_TEXT);
    await waitFor(() => expect(mockGetScimFeatureStatus).toHaveBeenCalledTimes(1));
  });
});

// ---------------------------------------------------------------------------
// 2. The route
// ---------------------------------------------------------------------------

describe('/dashboard/settings/scim route gate', () => {
  it('renders the SCIM client when the feature is on', async () => {
    mockIsScimProvisioningEnabled.mockResolvedValue(true);
    const element = await ScimSettingsPage();
    expect(element.type).toBe(ScimSettingsClient);
  });

  it('404s when the feature is off', async () => {
    mockIsScimProvisioningEnabled.mockResolvedValue(false);
    await expect(ScimSettingsPage()).rejects.toThrow(NOT_FOUND);
  });

  it('404s before producing any SCIM markup', async () => {
    mockIsScimProvisioningEnabled.mockResolvedValue(false);
    await expect(ScimSettingsPage()).rejects.toThrow(NOT_FOUND);
    // The gate is consulted, and it is the only thing consulted.
    expect(mockIsScimProvisioningEnabled).toHaveBeenCalledTimes(1);
  });
});
