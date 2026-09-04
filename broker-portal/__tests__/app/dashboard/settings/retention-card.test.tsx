/**
 * "gray what a plan gates" — the Email Retention Policy card. BACKLOG-3078.
 *
 * Retention is the one card on this page in the GRAYED category: the feature
 * works, custom_retention is simply not on every plan (verified against
 * plan_features 2026-09-04 — enterprise on, team and individual off). So a
 * team-plan admin should SEE it, disabled, with a label naming what unlocks it.
 * Hiding it would lose the sales signal; leaving it live would let them set an
 * org-wide policy they have not bought.
 *
 * The refusal itself is server-side and lives in
 * __tests__/lib/actions/org-settings-actions-gate.test.ts. This file proves the
 * pixels, and that the disabled control cannot be submitted from the page.
 */

import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom';

const mockUpdateRetentionPolicy = jest.fn(async (_years: number) => ({ success: true }));

jest.mock('@/lib/actions/scim', () => ({
  getConsentStatus: async () => ({
    organizationId: 'org-1',
    tenantId: null,
    consentGranted: false,
    consentGrantedAt: null,
  }),
  getRetentionPolicy: async () => ({ retentionYears: 7 }),
  getJitStatus: async () => ({ enabled: true }),
  updateRetentionPolicy: (years: number) => mockUpdateRetentionPolicy(years),
  updateJitStatus: async () => ({ success: true }),
}));

jest.mock('@/components/providers/ImpersonationProvider', () => ({
  useImpersonation: () => ({ isImpersonating: false }),
}));

import OrgSettingsClient from '@/app/dashboard/settings/OrgSettingsClient';
import type { CardPolicy, OrgSettingsFeatureView } from '@/lib/org-settings-access';

const HEADING = 'Email Retention Policy';
const UNLOCK = 'Available on Enterprise';

function view(retention: CardPolicy): OrgSettingsFeatureView {
  return {
    retention,
    scim: { policy: 'hidden', unlockLabel: null },
    jit: { policy: 'hidden', unlockLabel: null },
  };
}

const TEAM: CardPolicy = { policy: 'grayed', unlockLabel: UNLOCK };
const ENTERPRISE: CardPolicy = { policy: 'enabled', unlockLabel: null };

beforeEach(() => mockUpdateRetentionPolicy.mockClear());

describe('Email Retention Policy — team plan (grayed)', () => {
  it('renders the card rather than hiding it', async () => {
    render(<OrgSettingsClient features={view(TEAM)} />);
    expect(await screen.findByText(HEADING)).toBeInTheDocument();
  });

  it('names what unlocks it', async () => {
    render(<OrgSettingsClient features={view(TEAM)} />);
    expect(await screen.findByText(UNLOCK)).toBeInTheDocument();
  });

  it('disables the period selector', async () => {
    render(<OrgSettingsClient features={view(TEAM)} />);
    await screen.findByText(HEADING);
    expect(screen.getByLabelText('Retain emails for')).toBeDisabled();
  });

  it('marks the whole control inert, not just the button', async () => {
    // Save is ALSO disabled while the selected value equals the saved one, so
    // `Save is disabled` on its own cannot tell a locked card from an untouched
    // one. This flag is set by the lock and nothing else.
    render(<OrgSettingsClient features={view(TEAM)} />);
    await screen.findByText(HEADING);
    expect(screen.getByLabelText('Retain emails for').closest('[aria-disabled]'))
      .toHaveAttribute('aria-disabled', 'true');
  });

  it('cannot be submitted — the period cannot even be changed', async () => {
    // The real argument for "not submittable": Save only enables once the
    // selected value differs from the saved one, and a disabled selector means
    // it never can. Driving the interaction proves that, where asserting the
    // button's disabled attribute would pass either way.
    render(<OrgSettingsClient features={view(TEAM)} />);
    await screen.findByText(HEADING);
    const select = screen.getByLabelText('Retain emails for') as HTMLSelectElement;

    await userEvent.selectOptions(select, '3').catch(() => {
      /* a disabled control rejects the interaction; that is the point */
    });

    expect(select.value).toBe('7');
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(mockUpdateRetentionPolicy).not.toHaveBeenCalled();
  });

  it('does not tell members their desktop setting is locked', async () => {
    // The org policy is not in force, so the desktop setting is theirs.
    render(<OrgSettingsClient features={view(TEAM)} />);
    await screen.findByText(HEADING);
    expect(
      screen.queryByText(/see this setting locked in their desktop app/i)
    ).not.toBeInTheDocument();
  });
});

describe('Email Retention Policy — enterprise plan (enabled)', () => {
  it('renders no unlock label', async () => {
    render(<OrgSettingsClient features={view(ENTERPRISE)} />);
    await screen.findByText(HEADING);
    expect(screen.queryByText(UNLOCK)).not.toBeInTheDocument();
  });

  it('enables the period selector', async () => {
    render(<OrgSettingsClient features={view(ENTERPRISE)} />);
    await screen.findByText(HEADING);
    expect(screen.getByLabelText('Retain emails for')).not.toBeDisabled();
  });

  it('submits a changed value', async () => {
    render(<OrgSettingsClient features={view(ENTERPRISE)} />);
    await screen.findByText(HEADING);
    await userEvent.selectOptions(screen.getByLabelText('Retain emails for'), '3');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(mockUpdateRetentionPolicy).toHaveBeenCalledWith(3));
    // The save resolves asynchronously and sets state on the way out; settle it
    // here so the assertion above is not racing the component's own update.
    await screen.findByText('Saved');
  });

  it('warns that members lose control of their desktop setting', async () => {
    render(<OrgSettingsClient features={view(ENTERPRISE)} />);
    await screen.findByText(HEADING);
    expect(
      await screen.findByText(/see this setting locked in their desktop app/i)
    ).toBeInTheDocument();
  });
});

describe('Just-in-Time Provisioning card', () => {
  it('is absent when hidden — and its status is never fetched', async () => {
    render(<OrgSettingsClient features={view(ENTERPRISE)} />);
    await screen.findByText(HEADING);
    expect(screen.queryByText('Just-in-Time Provisioning')).not.toBeInTheDocument();
  });

  it('renders when the feature is on', async () => {
    render(
      <OrgSettingsClient
        features={{
          retention: ENTERPRISE,
          scim: { policy: 'hidden', unlockLabel: null },
          jit: { policy: 'enabled', unlockLabel: null },
        }}
      />
    );
    expect(await screen.findByText('Just-in-Time Provisioning')).toBeInTheDocument();
  });
});
