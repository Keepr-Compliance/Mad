/**
 * BACKLOG-3851 PR-2f: invite without a license, support preset, invite names — REAL renders.
 *
 * C9  OutOfLicensesNotice: "contact Keepr support" for admins (not it_admins); "Invite
 *     without a license" only when the form passes a handler (Resend / Reactivate never do).
 * C10 SupportWidget: openSupportRequest(preset) -> after the categories load, Category =
 *     Billing & Subscription, Subcategory = Plan/seat change, description prefilled; a
 *     plain Event opens a blank form. Categories resolving LATE still get the preset.
 * C11 Users list label: an unclaimed 'unassigned' row reads "Invited (no license)"; a
 *     claimed 'unassigned' row reads "No license"; an unclaimed 'pending' row "Invited".
 * C14 InviteUserModal: the button follows allowInviteWithoutLicense (default = the switches,
 *     off in this environment); pressing it re-sends the SAME form with withoutLicense.
 * C12 landing page: the line iff licensed === false; "Hi <first>," iff a first name.
 *
 * support_categories rows (slugs, names) as read on keepr-test and production
 * (pm_comments 5f519ddb section 2).
 */
import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';

const mockRefresh = jest.fn();
const mockInviteUser = jest.fn();
const mockGetCategories = jest.fn();
const mockParams = { token: 'fixture-token' };

jest.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: mockRefresh, push: jest.fn() }),
  useParams: () => mockParams,
}));
jest.mock('@/lib/actions/inviteUser', () => ({ inviteUser: (...a: unknown[]) => mockInviteUser(...a) }));
jest.mock('html2canvas', () => ({
  __esModule: true,
  default: async () => ({ toBlob: (cb: (b: Blob | null) => void) => cb(null) }),
}));
jest.mock('@/lib/supabase/client', () => ({
  createClient: () => ({ auth: { getUser: async () => ({ data: { user: null } }), signInWithOAuth: jest.fn() } }),
}));
jest.mock('@/lib/support-queries', () => {
  const actual = jest.requireActual('@/lib/support-queries');
  return {
    ...actual,
    getCategories: () => mockGetCategories(),
    createTicket: jest.fn(),
    uploadAttachment: jest.fn(),
  };
});
jest.mock('@/app/support/components/FileUpload', () => ({ FileUpload: () => null }));
jest.mock('@/app/support/components/BrowserDiagnostics', () => ({
  useBrowserDiagnostics: () => ({}),
  BrowserDiagnostics: () => null,
}));

import OutOfLicensesNotice from '@/components/users/OutOfLicensesNotice';
import InviteUserModal from '@/components/users/InviteUserModal';
import { SupportWidget } from '@/app/dashboard/components/SupportWidget';
import UserTableRow from '@/components/users/UserTableRow';
import UserCard from '@/components/users/UserCard';
import InviteAcceptPage from '@/app/invite/[token]/page';
import { openSupportRequest, moreLicensesSupportPreset } from '@/lib/support/openSupportRequest';
import { INVITED_NO_LICENSE_LABEL, memberStatusLabel } from '@/lib/types/users';
import type { OrganizationMember } from '@/lib/types/users';

const INVITEE_EMAIL = 'ann@fixture.invalid';

const CATEGORIES = [
  { id: 'cat-billing', name: 'Billing & Subscription', slug: 'billing-subscription', description: null, parent_id: null, sort_order: 1, is_active: true, metadata: null },
  { id: 'cat-tech', name: 'Technical Issue', slug: 'technical-issue', description: null, parent_id: null, sort_order: 2, is_active: true, metadata: null },
  { id: 'sub-invoice', name: 'Invoice/payment issue', slug: 'invoice-payment-issue', description: null, parent_id: 'cat-billing', sort_order: 1, is_active: true, metadata: null },
  { id: 'sub-seat', name: 'Plan/seat change', slug: 'plan-seat-change', description: null, parent_id: 'cat-billing', sort_order: 2, is_active: true, metadata: null },
  { id: 'sub-refund', name: 'Refund/cancellation request', slug: 'refund-cancellation-request', description: null, parent_id: 'cat-billing', sort_order: 3, is_active: true, metadata: null },
];

beforeEach(() => {
  mockRefresh.mockReset();
  mockInviteUser.mockReset();
  mockGetCategories.mockReset().mockResolvedValue(CATEGORIES);
});
afterEach(cleanup);

describe('C9: OutOfLicensesNotice', () => {
  it('admin + handler: both buttons; the invite button calls the handler', () => {
    const onInvite = jest.fn();
    render(<OutOfLicensesNotice callerRole="admin" organizationName="Fixture Org" onInviteWithoutLicense={onInvite} />);
    expect(screen.getByRole('button', { name: 'contact Keepr support' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Invite without a license' }));
    expect(onInvite).toHaveBeenCalledTimes(1);
  });

  it('no handler (Resend, Reactivate): no invite button', () => {
    render(<OutOfLicensesNotice callerRole="admin" />);
    expect(screen.queryByRole('button', { name: 'Invite without a license' })).toBeNull();
  });

  it('it_admin: no support button', () => {
    render(<OutOfLicensesNotice callerRole="it_admin" onInviteWithoutLicense={jest.fn()} />);
    expect(screen.queryByRole('button', { name: 'contact Keepr support' })).toBeNull();
    expect(screen.getByText('Ask a Broker or Admin to add a seat.')).toBeInTheDocument();
  });

  it('"contact Keepr support" dispatches the billing preset with the organization name', () => {
    const seen: unknown[] = [];
    const listener = (e: Event) => seen.push((e as CustomEvent).detail);
    window.addEventListener('open-support-widget', listener);
    render(<OutOfLicensesNotice callerRole="admin" organizationName="Fixture Org" />);
    fireEvent.click(screen.getByRole('button', { name: 'contact Keepr support' }));
    window.removeEventListener('open-support-widget', listener);
    expect(seen).toEqual([{
      categorySlug: 'billing-subscription', subcategorySlug: 'plan-seat-change',
      subject: 'More licenses needed', description: 'We need more licenses for Fixture Org',
    }]);
  });
});

describe('C10: SupportWidget preset', () => {
  const category = () => screen.getByLabelText('Category') as HTMLSelectElement;

  it('preset -> Billing & Subscription / Plan/seat change, message prefilled', async () => {
    render(<SupportWidget />);
    await act(async () => { openSupportRequest(moreLicensesSupportPreset('Fixture Org')); });
    await waitFor(() => expect(category().value).toBe('cat-billing'));
    expect((screen.getByLabelText('Subcategory') as HTMLSelectElement).value).toBe('sub-seat');
    expect(screen.getByDisplayValue('We need more licenses for Fixture Org')).toBeInTheDocument();
    expect(screen.getByDisplayValue('More licenses needed')).toBeInTheDocument();
  });

  it('categories that resolve AFTER the open still get the preset', async () => {
    let release!: (v: unknown) => void;
    mockGetCategories.mockReturnValue(new Promise((r) => { release = r; }));
    render(<SupportWidget />);
    await act(async () => { openSupportRequest(moreLicensesSupportPreset('Fixture Org')); });
    await waitFor(() => expect(screen.getByLabelText('Category')).toBeInTheDocument());
    expect(category().value).toBe('');
    await act(async () => { release(CATEGORIES); });
    await waitFor(() => expect(category().value).toBe('cat-billing'));
    expect((screen.getByLabelText('Subcategory') as HTMLSelectElement).value).toBe('sub-seat');
  });

  it('a plain Event (Support page) opens a blank form', async () => {
    render(<SupportWidget />);
    await act(async () => { window.dispatchEvent(new Event('open-support-widget')); });
    await waitFor(() => expect(screen.getByLabelText('Category')).toBeInTheDocument());
    await act(async () => { await Promise.resolve(); });
    expect(category().value).toBe('');
    expect(screen.queryByDisplayValue('We need more licenses for Fixture Org')).toBeNull();
  });

  it('an unknown slug leaves the category blank', async () => {
    render(<SupportWidget />);
    await act(async () => { openSupportRequest({ categorySlug: 'no-such-category', description: 'x' }); });
    await waitFor(() => expect(screen.getByLabelText('Category')).toBeInTheDocument());
    await act(async () => { await Promise.resolve(); });
    expect(category().value).toBe('');
  });
});

function member(over: Partial<OrganizationMember>): OrganizationMember {
  return {
    id: 'm-1', organization_id: 'org-1', user_id: null, role: 'agent', license_status: 'pending',
    invited_email: 'ann@fixture.invalid', invitation_token: 'tok', invitation_expires_at: null, invited_by: null,
    invited_at: '2026-10-17T00:00:00Z', joined_at: null, last_invited_at: null, created_at: '2026-10-17T00:00:00Z',
    updated_at: '2026-10-17T00:00:00Z', provisioned_by: 'invite', provisioned_at: null, scim_synced_at: null,
    provisioning_metadata: null, idp_groups: null, group_sync_enabled: false, ...over,
  };
}

describe('C11: status label and invite names in the Users list', () => {
  it('label rule', () => {
    expect(memberStatusLabel({ user_id: null, license_status: 'unassigned' })).toBe(INVITED_NO_LICENSE_LABEL);
    expect(memberStatusLabel({ user_id: 'u-1', license_status: 'unassigned' })).toBe('No license');
    expect(memberStatusLabel({ user_id: null, license_status: 'pending' })).toBe('Invited');
    expect(memberStatusLabel({ user_id: 'u-1', license_status: 'active' })).toBe('Active');
  });

  const rowProps = {
    isCurrentUser: false, isSelected: false, canManage: false, onToggleSelect: jest.fn(), onEditRole: jest.fn(),
    onResendInvite: jest.fn(), onDeactivate: jest.fn(), onRemove: jest.fn(), callerRole: 'admin', onLicenseAction: jest.fn(),
  };

  it('table row: unclaimed unlicensed invite with names -> "Invited (no license)" and the typed name', () => {
    render(<table><tbody><UserTableRow {...(rowProps as never)} member={member({ license_status: 'unassigned', invited_first_name: 'Ann', invited_last_name: 'Lee' })} /></tbody></table>);
    expect(screen.getByText(INVITED_NO_LICENSE_LABEL)).toBeInTheDocument();
    expect(screen.getByText('Ann Lee')).toBeInTheDocument();
  });

  it('card: a claimed unlicensed member -> "No license"', () => {
    render(<UserCard {...(rowProps as never)} member={member({ user_id: 'u-1', license_status: 'unassigned', user: { id: 'u-1', email: 'ann@fixture.invalid', display_name: 'Ann L' } as never })} />);
    expect(screen.getByText('No license')).toBeInTheDocument();
    expect(screen.queryByText(INVITED_NO_LICENSE_LABEL)).toBeNull();
  });
});

describe('C14: InviteUserModal and the switch', () => {
  async function fillAndSubmit(allow?: boolean) {
    render(<InviteUserModal isOpen onClose={jest.fn()} organizationId="org-1" organizationName="Fixture Org" callerRole="admin"
      {...(allow === undefined ? {} : { allowInviteWithoutLicense: allow })} />);
    fireEvent.change(screen.getByLabelText('First name (optional)'), { target: { value: 'Ann' } });
    fireEvent.change(screen.getByLabelText('Last name (optional)'), { target: { value: 'Lee' } });
    const emailField = screen.getByLabelText('Email Address');
    fireEvent.change(emailField, { target: { value: INVITEE_EMAIL } });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Send Invite' })); });
  }

  it('allowed: the button re-sends the same form with withoutLicense', async () => {
    mockInviteUser.mockResolvedValueOnce({ success: false, outOfSeats: true }).mockResolvedValueOnce({ success: true, inviteLink: 'https://x.test/invite/t', emailSent: true });
    await fillAndSubmit(true);
    expect(mockInviteUser).toHaveBeenLastCalledWith({ email: 'ann@fixture.invalid', role: 'agent', organizationId: 'org-1', firstName: 'Ann', lastName: 'Lee' });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Invite without a license' })); });
    expect(mockInviteUser).toHaveBeenLastCalledWith({ email: 'ann@fixture.invalid', role: 'agent', organizationId: 'org-1', firstName: 'Ann', lastName: 'Lee', withoutLicense: true });
    expect(screen.getByText('Invitation Email Sent')).toBeInTheDocument();
    expect(mockRefresh).toHaveBeenCalledTimes(1);
  });

  it('not allowed: the prompt shows no invite button', async () => {
    mockInviteUser.mockResolvedValue({ success: false, outOfSeats: true });
    await fillAndSubmit(false);
    expect(screen.getByTestId('out-of-licenses')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Invite without a license' })).toBeNull();
  });

  it('default (switch unset in this environment): no invite button', async () => {
    mockInviteUser.mockResolvedValue({ success: false, outOfSeats: true });
    await fillAndSubmit();
    expect(screen.getByTestId('out-of-licenses')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Invite without a license' })).toBeNull();
  });
});

describe('C12: invite landing page', () => {
  const realFetch = global.fetch;
  afterEach(() => { global.fetch = realFetch; });

  function answer(body: Record<string, unknown>) {
    global.fetch = jest.fn(async () => ({ ok: true, json: async () => body })) as never;
  }

  it('licensed === false -> the line; a first name -> the greeting', async () => {
    answer({
      valid: true,
      email: INVITEE_EMAIL,
      orgName: 'Fixture Org',
      role: 'Agent',
      licensed: false,
      firstName: 'Ann',
    });
    render(<InviteAcceptPage />);
    expect(await screen.findByTestId('invite-unlicensed')).toHaveTextContent("You'll join without a license until your admin assigns one.");
    expect(screen.getByText('Hi Ann,')).toBeInTheDocument();
  });

  it('licensed, no name -> neither', async () => {
    answer({
      valid: true,
      email: INVITEE_EMAIL,
      orgName: 'Fixture Org',
      role: 'Agent',
      licensed: true,
      firstName: null,
    });
    render(<InviteAcceptPage />);
    expect(await screen.findByText('Fixture Org')).toBeInTheDocument();
    expect(screen.queryByTestId('invite-unlicensed')).toBeNull();
    expect(screen.queryByText(/^Hi /)).toBeNull();
  });
});
