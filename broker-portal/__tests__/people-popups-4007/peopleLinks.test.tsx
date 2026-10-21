/**
 * BACKLOG-4007 People popups: which viewers get a link on a person's name.
 *
 * The broker portal's member page (/dashboard/users/<member id>) admits admins and IT admins, so
 * only those viewers' People card links names. A broker's People-only page, and any read-only
 * (support) view, show plain text. The view shape is the one in orgPeople.test.tsx (transcribed
 * from org_contacts_list); names, emails and ids are invented.
 */

import '@testing-library/jest-dom';
import { render, screen, waitFor } from '@testing-library/react';

const mockList = jest.fn();
jest.mock('@/lib/actions/orgContacts', () => ({
  listOrgContacts: (...a: unknown[]) => mockList(...a),
  saveOrgContact: jest.fn(),
  removeOrgContact: jest.fn(),
  invitePerson: jest.fn(),
}));
jest.mock('@/lib/actions/scim', () => ({
  getConsentStatus: async () => ({ organizationId: 'org-1', tenantId: null, consentGranted: false, consentGrantedAt: null }),
  getRetentionPolicy: async () => ({ retentionYears: 7 }),
  getJitStatus: async () => ({ enabled: true }),
  updateRetentionPolicy: async () => ({ success: true }),
  updateJitStatus: async () => ({ success: true }),
}));
jest.mock('@/components/providers/ImpersonationProvider', () => ({ useImpersonation: () => ({ isImpersonating: false }) }));

import { PeopleCard } from '@/components/settings/PeopleCard';
import OrgSettingsClient from '@/app/dashboard/settings/OrgSettingsClient';
import type { OrgSettingsFeatureView } from '@/lib/org-settings-access';

const VIEW = {
  can_edit: true,
  can_edit_billing: true,
  can_edit_it: true,
  can_edit_phone: true,
  deal_status: 'active',
  contacts: [
    { id: 'b1', role: 'billing', name: 'Jane Doe', email: 'bea@example.test', phone: null, company_name: null, member_id: 'm-bea', login: 'admin', login_claimed: true },
  ],
  members: [
    { member_id: 'm-bea', user_id: 'u-bea', role: 'admin', license_status: 'active', billing_only: false, name: 'Jane Doe', email: 'bea@example.test', phone: null, idp_managed: false, pending: false },
  ],
};

const FEATURES: OrgSettingsFeatureView = {
  retention: { policy: 'hidden', unlockLabel: null },
  scim: { policy: 'hidden', unlockLabel: null },
  jit: { policy: 'hidden', unlockLabel: null },
};

beforeEach(() => {
  mockList.mockReset();
  mockList.mockResolvedValue({ ok: true, view: VIEW });
});

describe('People card links to the member page', () => {
  it('with linkUsers a name links to /dashboard/users/<member id>', async () => {
    render(<PeopleCard organizationId="org-1" linkUsers />);
    expect(await screen.findByRole('link', { name: 'Jane Doe' })).toHaveAttribute('href', '/dashboard/users/m-bea');
  });

  it('without linkUsers (the broker page) the name is plain text', async () => {
    render(<PeopleCard organizationId="org-1" />);
    await screen.findByText('Jane Doe');
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
  });

  it('read-only never links, even with linkUsers', async () => {
    render(<PeopleCard organizationId="org-1" linkUsers readOnly />);
    await screen.findByText('Jane Doe');
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
  });
});

describe('Org Settings (admin / IT admin page) mounts People with links', () => {
  it('renders the People card with linked names', async () => {
    render(<OrgSettingsClient features={FEATURES} peopleOrganizationId="org-1" />);
    await waitFor(() => expect(screen.getByRole('link', { name: 'Jane Doe' })).toHaveAttribute('href', '/dashboard/users/m-bea'));
  });
});
