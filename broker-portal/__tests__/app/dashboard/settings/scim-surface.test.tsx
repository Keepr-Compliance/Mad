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
 *
 * BACKLOG-3078 moved the card's decision off the client. The page previously
 * asked getScimFeatureStatus() from a useEffect; it now receives a render
 * policy resolved server-side (lib/org-settings-access.ts) and rendered by the
 * shared gray-vs-hide rule. The card's OBSERVABLE behaviour is unchanged and is
 * still pinned here — visible iff the feature resolves enabled — with the
 * fail-closed cases that used to live in this file now proven at the page gate
 * in org-settings-gate.test.tsx, which is where the decision moved to.
 */

import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';

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

jest.mock('@/components/providers/ImpersonationProvider', () => ({
  useImpersonation: () => ({ isImpersonating: false }),
}));

const mockIsScimProvisioningEnabled = jest.fn();
jest.mock('@/lib/scim-access', () => ({
  SCIM_FEATURE_KEY: 'scim_provisioning',
  isScimProvisioningEnabled: () => mockIsScimProvisioningEnabled(),
}));

const NOT_FOUND = 'NEXT_NOT_FOUND';
jest.mock('next/navigation', () => ({
  notFound: () => {
    throw new Error(NOT_FOUND);
  },
}));

import OrgSettingsClient from '@/app/dashboard/settings/OrgSettingsClient';
import ScimSettingsPage from '@/app/dashboard/settings/scim/page';
import ScimSettingsClient from '@/app/dashboard/settings/scim/ScimSettingsClient';
import type { FeatureRenderPolicy } from '@/lib/feature-availability';
import type { OrgSettingsFeatureView } from '@/lib/org-settings-access';

const CARD_TEXT = 'SCIM Provisioning';
/** A card that always renders, so absence is measured after the page settles. */
const SETTLED_MARKER = 'Email Retention Policy';

function view(scim: FeatureRenderPolicy): OrgSettingsFeatureView {
  return {
    retention: { policy: 'enabled', unlockLabel: null },
    scim: { policy: scim, unlockLabel: null },
    jit: { policy: 'hidden', unlockLabel: null },
  };
}

beforeEach(() => {
  mockIsScimProvisioningEnabled.mockReset();
});

// ---------------------------------------------------------------------------
// 1. The settings card
// ---------------------------------------------------------------------------

describe('Settings page — SCIM card', () => {
  it('renders the card when the feature is on', async () => {
    render(<OrgSettingsClient features={view('enabled')} />);
    const card = await screen.findByText(CARD_TEXT);
    expect(card).toBeInTheDocument();
    expect(card.closest('a')).toHaveAttribute('href', '/dashboard/settings/scim');
  });

  it('does NOT render the card when the feature is off', async () => {
    render(<OrgSettingsClient features={view('hidden')} />);
    await screen.findByText(SETTLED_MARKER);
    expect(screen.queryByText(CARD_TEXT)).not.toBeInTheDocument();
  });

  it('does NOT gray the card — an unbuilt feature is absent, never upsold', async () => {
    // If SCIM ever fell out of UNBUILT_FEATURES the page gate would hand this
    // component 'grayed', and a grayed card would advertise a purchase for an
    // endpoint that returns 404. Rendering nothing is the only safe answer.
    render(<OrgSettingsClient features={view('grayed')} />);
    await screen.findByText(SETTLED_MARKER);
    expect(screen.queryByText(CARD_TEXT)).toBeInTheDocument();
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
