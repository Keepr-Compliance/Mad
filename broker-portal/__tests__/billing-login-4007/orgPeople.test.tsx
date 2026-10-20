/**
 * BACKLOG-4007 PR-4: the People panel (@keepr/ui OrgPeoplePanel, shared with the admin portal)
 * and the broker portal's People actions.
 *
 * The view shape is transcribed from org_contacts_list on keepr-test (C_L1 in
 * supabase/tests/backlog-4007-pr4): {success, can_edit, deal_status, contacts[{id, role, name,
 * email, phone, company_name, member_id, login, login_claimed}], members[{user_id, member_id,
 * role, name, email}]}. Names and emails replaced with invented ones.
 */

import '@testing-library/jest-dom';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';

const mockRpc = jest.fn();
const mockGate = jest.fn();
const mockSendInvite = jest.fn();
jest.mock('@/lib/impersonation-guards', () => ({ blockWriteDuringImpersonation: async () => null }));
jest.mock('@/lib/auth/memberAccess', () => ({ requireActiveOrgRole: (...a: unknown[]) => mockGate(...a) }));
jest.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    rpc: mockRpc,
    auth: { getUser: async () => ({ data: { user: { id: 'u-1', email: 'admin@example.test' } } }) },
  }),
}));
jest.mock('@/lib/email', () => ({ sendInviteEmail: (...a: unknown[]) => mockSendInvite(...a) }));

import { OrgPeoplePanel, orgPeopleErrorMessage, type OrgPeopleView, type OrgPeopleActions } from '@keepr/ui';
import { PHONE_ERROR, formatBillingPhoneInput, isValidBillingPhone } from '@/lib/billing/phone';
import { listOrgContacts, saveOrgContact, setOrgBillingLogin } from '@/lib/actions/orgContacts';

const PHONE = { isValid: isValidBillingPhone, format: formatBillingPhoneInput, error: PHONE_ERROR };

function contact(id: string, role: 'billing' | 'it' | 'office' | 'msp', over: Record<string, unknown> = {}) {
  return { id, role, name: `Person ${id}`, email: `p-${id}@example.test`, phone: null, company_name: null, member_id: null, login: null, login_claimed: false, ...over };
}

const VIEW: OrgPeopleView = {
  can_edit: true,
  deal_status: 'active',
  contacts: [contact('b1', 'billing', { phone: '+12025550123' })],
  members: [{ user_id: 'u-ag', member_id: 'm-ag', role: 'agent', name: 'agent one', email: 'agent@example.test' }],
};

function actions(over: Partial<OrgPeopleActions> = {}): OrgPeopleActions {
  return {
    save: jest.fn(async () => ({ ok: true as const })),
    remove: jest.fn(async () => ({ ok: true as const })),
    setBillingLogin: jest.fn(async () => ({ ok: true as const })),
    ...over,
  };
}

function row(role: string): HTMLElement {
  return document.querySelector(`[data-role="${role}"]`) as HTMLElement;
}

beforeEach(() => jest.clearAllMocks());

describe('OrgPeoplePanel', () => {
  it('lists the four roles; the billing contact offers the billing-only login', async () => {
    const a = actions();
    const onChanged = jest.fn();
    render(<OrgPeoplePanel view={VIEW} actions={a} phone={PHONE} onChanged={onChanged} />);
    expect(within(row('billing')).getByText('Person b1')).toBeInTheDocument();
    expect(within(row('billing')).getByText('Contact only')).toBeInTheDocument();
    expect(within(row('it')).getByText('No one added')).toBeInTheDocument();
    await act(async () => fireEvent.click(within(row('billing')).getByText('Give billing-only login')));
    expect(a.setBillingLogin).toHaveBeenCalledWith(true);
    expect(onChanged).toHaveBeenCalled();
  });

  it('a billing-only login can be removed; no Remove for the billing contact itself', async () => {
    const a = actions();
    const view = { ...VIEW, contacts: [contact('b1', 'billing', { member_id: 'm-b', login: 'billing_only' })] };
    render(<OrgPeoplePanel view={view} actions={a} phone={PHONE} onChanged={jest.fn()} />);
    expect(within(row('billing')).getByText('Billing-only login')).toBeInTheDocument();
    expect(within(row('billing')).queryByText('Remove')).not.toBeInTheDocument();
    await act(async () => fireEvent.click(within(row('billing')).getByText('Remove billing-only login')));
    expect(a.setBillingLogin).toHaveBeenCalledWith(false);
  });

  it('waiting for setup: the billing contact is set in the guide, no buttons on that row', () => {
    render(<OrgPeoplePanel view={{ ...VIEW, deal_status: 'draft', contacts: [] }} actions={actions()} phone={PHONE} onChanged={jest.fn()} />);
    expect(within(row('billing')).getByText('Set in the setup guide.')).toBeInTheDocument();
    expect(within(row('billing')).queryByRole('button')).not.toBeInTheDocument();
  });

  it('Create new person: saves the typed person for the role; a bad phone blocks Save', async () => {
    const a = actions();
    render(<OrgPeoplePanel view={VIEW} actions={a} phone={PHONE} onChanged={jest.fn()} />);
    fireEvent.click(within(row('it')).getByText('Add person'));
    fireEvent.change(screen.getByLabelText(/Full name/), { target: { value: 'Help Desk' } });
    fireEvent.change(screen.getByLabelText(/Email/), { target: { value: 'it@example.test' } });
    fireEvent.change(screen.getByLabelText(/Phone/), { target: { value: '12' } });
    fireEvent.blur(screen.getByLabelText(/Phone/));
    expect(screen.getByRole('alert')).toHaveTextContent(PHONE_ERROR);
    expect(screen.getByText('Save')).toBeDisabled();
    fireEvent.change(screen.getByLabelText(/Phone/), { target: { value: '2025550124' } });
    await act(async () => fireEvent.click(screen.getByText('Save')));
    expect(a.save).toHaveBeenCalledWith({
      id: undefined,
      role: 'it',
      name: 'Help Desk',
      email: 'it@example.test',
      phone: '(202) 555-0124',
      company_name: '',
    });
  });

  it('the billing contact needs a phone; MSP asks for the company', () => {
    render(<OrgPeoplePanel view={VIEW} actions={actions()} phone={PHONE} onChanged={jest.fn()} />);
    fireEvent.click(within(row('billing')).getByText('Change'));
    fireEvent.change(screen.getByLabelText(/Phone/), { target: { value: '' } });
    expect(screen.getByText('Save')).toBeDisabled();
    fireEvent.click(screen.getByText('Cancel'));
    fireEvent.click(within(row('msp')).getByText('Add person'));
    expect(screen.getByLabelText(/IT provider company/)).toBeInTheDocument();
  });

  it('Select existing user (broker): the brokerage members only, saved by user id', async () => {
    const a = actions();
    render(<OrgPeoplePanel view={VIEW} actions={a} phone={PHONE} onChanged={jest.fn()} />);
    fireEvent.click(within(row('office')).getByText('Add person'));
    fireEvent.click(screen.getByRole('tab', { name: 'Select existing user' }));
    expect(screen.queryByLabelText('Search users')).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('User'), { target: { value: 'u-ag' } });
    await act(async () => fireEvent.click(screen.getByText('Save')));
    expect(a.save).toHaveBeenCalledWith(expect.objectContaining({ role: 'office', user_id: 'u-ag' }));
  });

  it('Select existing user (staff): search; a user in another brokerage cannot be picked', async () => {
    const a = actions({
      searchUsers: jest.fn(async () => [
        { user_id: 'u-x', name: 'other user', email: 'other@example.test', status: 'other_brokerage' as const },
        { user_id: 'u-s', name: 'solo user', email: 'solo@example.test', status: 'no_brokerage' as const },
      ]),
    });
    render(<OrgPeoplePanel view={VIEW} actions={a} phone={PHONE} onChanged={jest.fn()} />);
    fireEvent.click(within(row('office')).getByText('Add person'));
    fireEvent.click(screen.getByRole('tab', { name: 'Select existing user' }));
    await act(async () => fireEvent.change(screen.getByLabelText('Search users'), { target: { value: 'pe' } }));
    await waitFor(() => expect(screen.getByRole('option', { name: /other user/ })).toBeDisabled());
    expect(screen.getByRole('option', { name: /solo user/ })).not.toBeDisabled();
  });

  it('one IT contact: Change, no Add; office lists 5 then Show more', () => {
    const office = Array.from({ length: 7 }, (_, i) => contact(`o${i}`, 'office'));
    render(
      <OrgPeoplePanel view={{ ...VIEW, contacts: [...VIEW.contacts, contact('i1', 'it'), ...office] }} actions={actions()} phone={PHONE} onChanged={jest.fn()} />
    );
    expect(within(row('it')).queryByText('Add person')).not.toBeInTheDocument();
    expect(within(row('it')).queryByText('Add another')).not.toBeInTheDocument();
    expect(within(row('office')).getAllByText(/^Person o/)).toHaveLength(5);
    fireEvent.click(within(row('office')).getByText('Show more (2)'));
    expect(within(row('office')).getAllByText(/^Person o/)).toHaveLength(7);
  });

  it('a refusal is worded; read-only shows no buttons', async () => {
    const a = actions({ setBillingLogin: jest.fn(async () => ({ ok: false as const, error: 'duplicate_invitation' })) });
    const { unmount } = render(<OrgPeoplePanel view={VIEW} actions={a} phone={PHONE} onChanged={jest.fn()} />);
    await act(async () => fireEvent.click(screen.getByText('Give billing-only login')));
    expect(screen.getByText(orgPeopleErrorMessage('duplicate_invitation'))).toBeInTheDocument();
    unmount();
    render(<OrgPeoplePanel view={VIEW} actions={actions()} phone={PHONE} onChanged={jest.fn()} readOnly />);
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });
});

describe('broker People actions', () => {
  it('refused before any RPC for anyone the gate refuses (lists: peopleRoles.test.tsx)', async () => {
    mockGate.mockResolvedValue({ ok: false });
    expect(await listOrgContacts('ORG-1')).toEqual({ ok: false, error: 'not_authorized' });
    expect(await saveOrgContact('ORG-1', { role: 'it', name: 'x', email: 'x@example.test' })).toEqual({ ok: false, error: 'not_authorized' });
    expect(await setOrgBillingLogin('ORG-1', true)).toEqual({ ok: false, error: 'not_authorized' });
    expect(mockRpc).not.toHaveBeenCalled();
    expect(mockGate).toHaveBeenCalledWith(expect.anything(), 'u-1', 'ORG-1', ['admin', 'it_admin', 'broker']);
    expect(mockGate).toHaveBeenCalledWith(expect.anything(), 'u-1', 'ORG-1', ['admin', 'broker']);
  });

  it('only the documented keys travel', async () => {
    mockGate.mockResolvedValue({ ok: true });
    mockRpc.mockResolvedValue({ data: { success: true }, error: null });
    await saveOrgContact('ORG-1', { role: 'msp', name: ' Ben ', email: 'b@example.test', phone: '', company_name: 'IT Co', seats: 99 } as never);
    expect(mockRpc).toHaveBeenCalledWith('org_contact_save', {
      p_org: 'ORG-1',
      p_contact: { role: 'msp', name: 'Ben', email: 'b@example.test', phone: '', company_name: 'IT Co' },
    });
  });

  it('a created login is emailed (billing-only invite); the result notes it', async () => {
    mockGate.mockResolvedValue({ ok: true });
    mockRpc.mockResolvedValue({
      data: { name: 'payer team', email: 'payer@example.test', token: 'b'.repeat(64), success: true, org_name: 'fixture realty' },
      error: null,
    });
    mockSendInvite.mockResolvedValue({ success: true, outcome: 'sent' });
    const r = await setOrgBillingLogin('ORG-1', true);
    expect(mockRpc).toHaveBeenCalledWith('org_billing_login_set', { p_org: 'ORG-1', p_enable: true });
    expect(mockSendInvite.mock.calls[0][0]).toMatchObject({ recipientEmail: 'payer@example.test', billingOnly: true });
    expect(r).toEqual({ ok: true, note: 'We emailed the billing contact an invitation to their billing-only login.' });
  });

  it('the database refusal is passed through; 42501 reads not_authorized', async () => {
    mockGate.mockResolvedValue({ ok: true });
    mockRpc.mockResolvedValueOnce({ data: { success: false, error: 'billing_login_exists' }, error: null });
    expect(await setOrgBillingLogin('ORG-1', true)).toEqual({ ok: false, error: 'billing_login_exists' });
    mockRpc.mockResolvedValueOnce({ data: null, error: { code: '42501', message: 'Not authorized' } });
    expect(await listOrgContacts('ORG-1')).toEqual({ ok: false, error: 'not_authorized' });
    expect(mockSendInvite).not.toHaveBeenCalled();
  });
});
