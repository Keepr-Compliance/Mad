// @vitest-environment jsdom
/**
 * BACKLOG-4007 People popups (staff): OrgPeopleCard on the organization page.
 *  - Each person's name links to the staff user page, /dashboard/users/<user id> (the page reads
 *    public.users by id). A pending invitation has no user id and no link.
 *  - Edit opens the popup; its invite tab sends to invitePersonAction with the slot.
 * The view shape follows org_contacts_list (see broker-portal billing-login-4007/orgPeople.test.tsx);
 * names, emails and ids are invented, ids all-zero.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';

const U_ADMIN = '00000000-0000-0000-0000-000000000000';
const VIEW = {
  can_edit: true,
  can_edit_billing: true,
  can_edit_it: true,
  can_edit_phone: true,
  deal_status: 'active',
  contacts: [
    { id: 'c-b', role: 'billing', name: 'fixture admin', email: 'adm@example.test', phone: '+12025550101', company_name: null, member_id: 'm-adm', login: 'admin', login_claimed: true },
    { id: 'c-o', role: 'office', name: 'pending invitee', email: 'pend@example.test', phone: null, company_name: null, member_id: 'm-pend', login: 'agent', login_claimed: false },
  ],
  members: [
    { member_id: 'm-adm', user_id: U_ADMIN, role: 'admin', license_status: 'active', billing_only: false, name: 'fixture admin', email: 'adm@example.test', phone: '+12025550101', idp_managed: false, pending: false },
    { member_id: 'm-pend', user_id: null, role: 'agent', license_status: 'unassigned', billing_only: false, name: 'pending invitee', email: 'pend@example.test', phone: null, idp_managed: false, pending: true },
  ],
};

const mockInvite = vi.fn(async () => ({ ok: true, emailSent: true, inviteLink: null }));
vi.mock('@/lib/actions/orgContacts', () => ({
  listOrgContactsAction: async () => VIEW,
  saveOrgContactAction: vi.fn(async () => ({ ok: true })),
  removeOrgContactAction: vi.fn(async () => ({ ok: true })),
  invitePersonAction: (...a: unknown[]) => mockInvite(...(a as [])),
}));

import { OrgPeopleCard } from '@/app/dashboard/organizations/[id]/components/OrgPeopleCard';

Object.assign(window.HTMLElement.prototype, {
  scrollIntoView: () => undefined,
  hasPointerCapture: () => false,
  releasePointerCapture: () => undefined,
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

async function renderCard() {
  await act(async () => {
    render(<OrgPeopleCard organizationId="org-fixture" />);
  });
}

describe('OrgPeopleCard (staff)', () => {
  it('a name links to /dashboard/users/<user id>; a pending invitation is plain text', async () => {
    await renderCard();
    const link = screen.getByRole('link', { name: 'fixture admin' });
    expect(link.getAttribute('href')).toBe(`/dashboard/users/${U_ADMIN}`);
    expect(link.className).toContain('text-primary-600');
    expect(link.className).toContain('hover:underline');
    expect(screen.getByText('pending invitee').tagName).toBe('SPAN');
    expect(screen.getAllByRole('link')).toHaveLength(1);
  });

  it('Edit opens the popup; the invite tab sends to invitePersonAction with the slot', async () => {
    await renderCard();
    const itRow = document.querySelector('[data-role="it"]') as HTMLElement;
    fireEvent.click(within(itRow).getByRole('button', { name: /^Edit / }));
    const dlg = screen.getByRole('dialog');
    fireEvent.click(within(dlg).getByRole('tab', { name: 'Invite new person' }));
    fireEvent.change(within(dlg).getByLabelText(/Work email/), { target: { value: 'it@example.test' } });
    await act(async () => {
      fireEvent.click(within(dlg).getByRole('button', { name: 'Send invite' }));
    });
    expect(mockInvite).toHaveBeenCalledWith('org-fixture', {
      slot: 'it',
      email: 'it@example.test',
      firstName: '',
      lastName: '',
      phone: '',
    });
  });
});
