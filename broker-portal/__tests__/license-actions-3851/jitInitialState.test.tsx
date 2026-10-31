/**
 * BACKLOG-3851 PR-2b, C9: the JIT switch on /dashboard/settings starts OFF.
 *
 * getJitStatus never answers here, so what renders is the component's own
 * initial state — the first paint before the real value arrives. It used to
 * start ON and flip, which no other suite could see (they all resolve
 * getJitStatus before asserting).
 */
import React from 'react';
import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';

jest.mock('@/lib/actions/scim', () => ({
  getConsentStatus: async () => ({ organizationId: 'org-1', tenantId: null, consentGranted: false, consentGrantedAt: null }),
  getRetentionPolicy: async () => ({ retentionYears: 7 }),
  getJitStatus: () => new Promise(() => {}),
  updateRetentionPolicy: async () => ({ success: true }),
  updateJitStatus: async () => ({ success: true }),
}));
jest.mock('@/components/providers/ImpersonationProvider', () => ({
  useImpersonation: () => ({ isImpersonating: false }),
}));

import OrgSettingsClient from '@/app/dashboard/settings/OrgSettingsClient';

it('C9: JIT switch is unchecked before getJitStatus answers', async () => {
  render(
    <OrgSettingsClient
      features={{
        retention: { policy: 'hidden', unlockLabel: null },
        scim: { policy: 'hidden', unlockLabel: null },
        jit: { policy: 'enabled', unlockLabel: null },
      }}
    />
  );
  const sw = await screen.findByRole('switch');
  expect(sw).toHaveAttribute('aria-checked', 'false');
  expect(screen.getByText('Users must be invited or provisioned via SCIM before they can sign in')).toBeInTheDocument();
});
