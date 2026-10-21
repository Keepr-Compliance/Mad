/**
 * BACKLOG-4007 PR-4 / People v2: the People panel (@keepr/ui OrgPeoplePanel, shared with the
 * admin portal) and the broker portal's People actions.
 *
 * The view shape is transcribed from org_contacts_list on keepr-test after 20261020200000
 * (called as an admin of a QA brokerage, 2026-10-20): {success, caller, can_edit,
 * can_edit_billing, can_edit_it, can_edit_phone, deal_status, contacts[{id, role, name, email,
 * phone, company_name, member_id, login, login_claimed}], members[{member_id, user_id, role,
 * license_status, billing_only, name, email, phone, idp_managed, pending}]}. Names, emails and
 * ids replaced with invented ones; phones in the reserved 555-01xx range.
 */

import '@testing-library/jest-dom';
import { act, fireEvent, render, screen, within } from '@testing-library/react';

const mockRpc = jest.fn();
const mockGate = jest.fn();
const mockSendInvite = jest.fn();
jest.mock('@/lib/impersonation-guards', () => ({ blockWriteDuringImpersonation: async () => null }));
jest.mock('@/lib/auth/memberAccess', () => ({ requireActiveOrgRole: (...a: unknown[]) => mockGate(...a) }));
jest.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    rpc: mockRpc,
    auth: { getUser: async () => ({ data: { user: { id: 'u-1', email: 'admin@example.test', user_metadata: { first_name: 'fixture', last_name: 'admin' } } } }) },
  }),
}));
jest.mock('@/lib/email', () => ({ sendInviteEmail: (...a: unknown[]) => mockSendInvite(...a) }));

import { OrgPeoplePanel, orgPeopleErrorMessage, type OrgPeopleView, type OrgPeopleActions } from '@keepr/ui';
import { PHONE_ERROR, formatBillingPhoneInput, isValidBillingPhone } from '@/lib/billing/phone';
import { invitePerson, listOrgContacts, saveOrgContact } from '@/lib/actions/orgContacts';

const PHONE = { isValid: isValidBillingPhone, format: formatBillingPhoneInput, error: PHONE_ERROR };

function contact(id: string, role: 'billing' | 'it' | 'office' | 'msp', over: Record<string, unknown> = {}) {
  return {
    id, role, name: `Person ${id}`, email: `p-${id}@example.test`, phone: null, company_name: null,
    member_id: `m-${id}`, login: 'agent', login_claimed: true, ...over,
  };
}

function member(id: string, over: Record<string, unknown> = {}) {
  return {
    member_id: `m-${id}`, user_id: `u-${id}`, role: 'agent', license_status: 'active', billing_only: false,
    name: `Member ${id}`, email: `${id}@example.test`, phone: null, idp_managed: false, pending: false, ...over,
  };
}

const MEMBERS = [
  member('ag'),
  member('bea', { name: 'Jane Doe', email: 'bea@example.test', phone: '+12025550131' }),
  member('adm', { role: 'admin', name: 'fixture admin' }),
  member('un', { license_status: 'unassigned', name: 'Una Unlicensed' }),
  member('idp', { name: 'Ivy Idp', idp_managed: true }),
];

const VIEW: OrgPeopleView = {
  can_edit: true,
  can_edit_billing: true,
  can_edit_it: true,
  can_edit_phone: true,
  deal_status: 'active',
  contacts: [contact('b1', 'billing', { phone: '+12025550123', login: 'admin' })],
  members: MEMBERS,
};

function actions(over: Partial<OrgPeopleActions> = {}): OrgPeopleActions {
  return {
    save: jest.fn(async () => ({ ok: true as const })),
    remove: jest.fn(async () => ({ ok: true as const })),
    ...over,
  };
}

function row(role: string): HTMLElement {
  return document.querySelector(`[data-role="${role}"]`) as HTMLElement;
}

// Radix Select under jsdom needs pointer-capture and scroll stubs (same as packages/ui/test/setup.ts).
Object.assign(window.HTMLElement.prototype, {
  hasPointerCapture: () => false,
  setPointerCapture: () => undefined,
  releasePointerCapture: () => undefined,
  scrollIntoView: () => undefined,
});

async function openUserList() {
  await act(async () => {
    fireEvent.keyDown(screen.getByRole('combobox', { name: 'User' }), { key: 'Enter' });
  });
}

async function pick(name: RegExp) {
  await openUserList();
  await act(async () => fireEvent.click(screen.getByRole('option', { name })));
}

beforeEach(() => jest.clearAllMocks());

describe('OrgPeoplePanel (People v2)', () => {
  it('no billing-only login buttons and no "Create new person": the removed controls are gone', () => {
    render(<OrgPeoplePanel view={VIEW} actions={actions()} phone={PHONE} onChanged={jest.fn()} onAddNew={jest.fn()} />);
    expect(screen.queryByText('Give billing-only login')).not.toBeInTheDocument();
    expect(screen.queryByText('Remove login')).not.toBeInTheDocument();
    fireEvent.click(within(row('office')).getByText('Add person'));
    expect(screen.queryByRole('radio', { name: 'Create new person' })).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/Full name/)).not.toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'User' })).toBeInTheDocument();
  });

  it('"Invite new person" for billing, IT contact and MSP calls onAddNew with the slot; never for office', () => {
    const onAddNew = jest.fn();
    const view = { ...VIEW, contacts: [...VIEW.contacts, contact('m1', 'msp', { company_name: 'Fixture IT Co' })] };
    render(<OrgPeoplePanel view={view} actions={actions()} phone={PHONE} onChanged={jest.fn()} onAddNew={onAddNew} />);
    fireEvent.click(within(row('billing')).getByText('Invite new person'));
    fireEvent.click(within(row('it')).getByText('Invite new person'));
    fireEvent.click(within(row('msp')).getByText('Invite new person'));
    expect(within(row('office')).queryByText('Invite new person')).not.toBeInTheDocument();
    expect(onAddNew.mock.calls).toEqual([['billing', undefined], ['it', undefined], ['msp', 'Fixture IT Co']]);
  });

  it('Select existing user saves the member id; the search filters by name or email', async () => {
    const a = actions();
    render(<OrgPeoplePanel view={VIEW} actions={a} phone={PHONE} onChanged={jest.fn()} />);
    fireEvent.click(within(row('office')).getByText('Add person'));
    fireEvent.change(screen.getByLabelText('Search users'), { target: { value: 'bea@' } });
    await openUserList();
    expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual(['Jane Doe (bea@example.test)']);
    await act(async () => fireEvent.click(screen.getByRole('option', { name: /Jane Doe/ })));
    // the person's phone is filled in from the member
    expect(screen.getByLabelText(/Phone/)).toHaveValue('(202) 555-0131');
    await act(async () => fireEvent.click(screen.getByText('Save')));
    expect(a.save).toHaveBeenCalledWith({ role: 'office', member_id: 'm-bea', phone: '(202) 555-0131' });
  });

  it('IT contact: an unlicensed or IdP-managed agent cannot be picked; an admin can', async () => {
    render(<OrgPeoplePanel view={VIEW} actions={actions()} phone={PHONE} onChanged={jest.fn()} />);
    fireEvent.click(within(row('it')).getByText('Add person'));
    await openUserList();
    expect(screen.getByRole('option', { name: /Una Unlicensed.*Needs a license first/ })).toHaveAttribute('aria-disabled', 'true');
    expect(screen.getByRole('option', { name: /Ivy Idp.*Managed by your identity provider\./ })).toHaveAttribute('aria-disabled', 'true');
    expect(screen.getByRole('option', { name: /fixture admin/ })).not.toHaveAttribute('aria-disabled', 'true');
    expect(screen.getByRole('option', { name: /Member ag/ })).not.toHaveAttribute('aria-disabled', 'true');
  });

  it('an agent picked as IT contact: the database asks to confirm, the panel says so, the second save confirms', async () => {
    const save = jest
      .fn()
      .mockResolvedValueOnce({ ok: false, error: 'role_change_needs_confirm', role: 'agent' })
      .mockResolvedValueOnce({ ok: true });
    const onChanged = jest.fn();
    render(<OrgPeoplePanel view={VIEW} actions={actions({ save })} phone={PHONE} onChanged={onChanged} />);
    fireEvent.click(within(row('it')).getByText('Add person'));
    await pick(/Member ag/);
    await act(async () => fireEvent.click(screen.getByText('Save')));
    expect(screen.getByText('Member ag is now Agent. Saving makes them an IT admin.')).toBeInTheDocument();
    expect(onChanged).not.toHaveBeenCalled();
    await act(async () => fireEvent.click(screen.getByText('Make IT admin')));
    expect(save.mock.calls[0][0]).toEqual({ role: 'it', member_id: 'm-ag' });
    expect(save.mock.calls[1][0]).toEqual({ role: 'it', member_id: 'm-ag', confirm_role_change: true });
    expect(onChanged).toHaveBeenCalled();
  });

  it('the billing contact needs a phone unless the person has one; MSP asks for the company', async () => {
    render(<OrgPeoplePanel view={VIEW} actions={actions()} phone={PHONE} onChanged={jest.fn()} />);
    fireEvent.click(within(row('billing')).getByText('Change'));
    await pick(/Member ag/);
    expect(screen.getByText('Save')).toBeDisabled();
    await pick(/Jane Doe/);
    expect(screen.getByText('Save')).not.toBeDisabled();
    fireEvent.click(screen.getByText('Cancel'));
    fireEvent.click(within(row('msp')).getByText('Add person'));
    expect(screen.getByLabelText(/IT provider company/)).toBeInTheDocument();
  });

  it('an IT admin (can_edit_phone false, can_edit_billing false): no phone field, billing row read-only', () => {
    const view = { ...VIEW, can_edit_billing: false, can_edit_phone: false };
    render(<OrgPeoplePanel view={view} actions={actions()} phone={PHONE} onChanged={jest.fn()} onAddNew={jest.fn()} />);
    expect(within(row('billing')).queryByRole('button')).not.toBeInTheDocument();
    expect(within(row('billing')).getByText('Only a broker or admin can change it.')).toBeInTheDocument();
    fireEvent.click(within(row('office')).getByText('Add person'));
    expect(screen.queryByLabelText(/Phone/)).not.toBeInTheDocument();
  });

  it('a broker (can_edit_it false): the IT contact and MSP rows have no buttons (founder R7)', () => {
    const view = { ...VIEW, can_edit_it: false };
    render(<OrgPeoplePanel view={view} actions={actions()} phone={PHONE} onChanged={jest.fn()} onAddNew={jest.fn()} />);
    expect(within(row('it')).queryByRole('button')).not.toBeInTheDocument();
    expect(within(row('msp')).queryByRole('button')).not.toBeInTheDocument();
    expect(within(row('it')).getByText('Only an admin or IT admin can change it.')).toBeInTheDocument();
    expect(within(row('office')).getByText('Add person')).toBeInTheDocument();
    expect(within(row('billing')).getByText('Change')).toBeInTheDocument();
  });

  it('waiting for setup: the billing contact is set in the guide, no buttons on that row', () => {
    render(<OrgPeoplePanel view={{ ...VIEW, deal_status: 'draft' }} actions={actions()} phone={PHONE} onChanged={jest.fn()} onAddNew={jest.fn()} />);
    expect(within(row('billing')).getByText('Set in the setup guide.')).toBeInTheDocument();
    expect(within(row('billing')).queryByRole('button')).not.toBeInTheDocument();
  });

  it('button variants: Add person and Cancel are secondary, Save is primary, nothing is dark', () => {
    const { container } = render(<OrgPeoplePanel view={VIEW} actions={actions()} phone={PHONE} onChanged={jest.fn()} />);
    const add = within(row('office')).getByText('Add person');
    expect(add.className).toContain('bg-white');
    fireEvent.click(add);
    expect(screen.getByText('Cancel').className).toContain('bg-white');
    expect(screen.getByText('Save').className).toContain('bg-primary-600');
    expect(container.querySelector('.bg-gray-900')).toBeNull();
  });

  it('contact phones show formatted for US/CA numbers and as stored otherwise', () => {
    const view = { ...VIEW, contacts: [contact('b1', 'billing', { phone: '+12025550123' }), contact('o1', 'office', { phone: '+442071838750' })] };
    render(<OrgPeoplePanel view={view} actions={actions()} phone={PHONE} onChanged={jest.fn()} />);
    expect(within(row('billing')).getByText(/\(202\) 555-0123/)).toBeInTheDocument();
    expect(within(row('office')).getByText(/\+442071838750/)).toBeInTheDocument();
  });

  it('one IT contact: no Add; office lists 5 then Show more', () => {
    const office = Array.from({ length: 7 }, (_, i) => contact(`o${i}`, 'office'));
    render(<OrgPeoplePanel view={{ ...VIEW, contacts: [...VIEW.contacts, contact('i1', 'it'), ...office] }} actions={actions()} phone={PHONE} onChanged={jest.fn()} onAddNew={jest.fn()} />);
    expect(within(row('it')).queryByText('Add person')).not.toBeInTheDocument();
    expect(within(row('it')).queryByText('Invite new person')).not.toBeInTheDocument();
    expect(within(row('office')).getAllByText(/^Person o/)).toHaveLength(5);
    fireEvent.click(within(row('office')).getByText('Show more (2)'));
    expect(within(row('office')).getAllByText(/^Person o/)).toHaveLength(7);
  });

  it('a refusal is worded; read-only shows no buttons', async () => {
    const a = actions({ save: jest.fn(async () => ({ ok: false as const, error: 'managed_by_idp' })) });
    const r = render(<OrgPeoplePanel view={VIEW} actions={a} phone={PHONE} onChanged={jest.fn()} />);
    fireEvent.click(within(row('office')).getByText('Add person'));
    await pick(/Member ag/);
    await act(async () => fireEvent.click(screen.getByText('Save')));
    expect(screen.getByText('Managed by your identity provider.')).toBeInTheDocument();
    r.unmount();
    render(<OrgPeoplePanel view={VIEW} actions={actions()} phone={PHONE} onChanged={jest.fn()} readOnly />);
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('the founder sentences, exactly', () => {
    expect(orgPeopleErrorMessage('has_personal_account')).toBe(
      'This person already has their own Keepr account. Pick another billing contact or invite them as a member.'
    );
    expect(orgPeopleErrorMessage('managed_by_idp')).toBe('Managed by your identity provider.');
  });
});

describe('broker People actions', () => {
  it('refused before any RPC for anyone the gate refuses; IT / MSP use the IT list, billing the billing list', async () => {
    mockGate.mockResolvedValue({ ok: false });
    expect(await listOrgContacts('ORG-1')).toEqual({ ok: false, error: 'not_authorized' });
    expect(await saveOrgContact('ORG-1', { role: 'it', member_id: 'm-1' })).toEqual({ ok: false, error: 'not_authorized' });
    expect(await saveOrgContact('ORG-1', { role: 'billing', member_id: 'm-1' })).toEqual({ ok: false, error: 'not_authorized' });
    expect(await invitePerson('ORG-1', { slot: 'msp', email: 'x@example.test', firstName: '', lastName: '', phone: '' })).toEqual({
      ok: false,
      error: 'not_authorized',
    });
    expect(mockRpc).not.toHaveBeenCalled();
    expect(mockGate.mock.calls.map((c) => c[3])).toEqual([
      ['admin', 'it_admin', 'broker'],
      ['admin', 'it_admin'],
      ['admin', 'broker'],
      ['admin', 'it_admin'],
    ]);
  });

  it('only the documented keys travel', async () => {
    mockGate.mockResolvedValue({ ok: true });
    mockRpc.mockResolvedValue({ data: { success: true }, error: null });
    await saveOrgContact('ORG-1', { role: 'msp', member_id: 'm-1', phone: ' ', company_name: ' IT Co ', seats: 99, name: 'x' } as never);
    expect(mockRpc).toHaveBeenCalledWith('org_contact_save', {
      p_org: 'ORG-1',
      p_contact: { role: 'msp', member_id: 'm-1', company_name: 'IT Co' },
    });
    await invitePerson('ORG-1', {
      slot: 'it', email: ' new@example.test ', firstName: 'Ned', lastName: 'New', phone: '', role: 'admin', billing_only: true,
    } as never);
    expect(mockRpc).toHaveBeenLastCalledWith('org_people_invite', {
      p_org: 'ORG-1',
      p_person: { slot: 'it', email: 'new@example.test', first_name: 'Ned', last_name: 'New' },
    });
  });

  it('the confirm request comes back with the old role', async () => {
    mockGate.mockResolvedValue({ ok: true });
    mockRpc.mockResolvedValue({ data: { success: false, error: 'role_change_needs_confirm', role: 'broker' }, error: null });
    expect(await saveOrgContact('ORG-1', { role: 'it', member_id: 'm-1' })).toEqual({ ok: false, error: 'role_change_needs_confirm', role: 'broker' });
  });

  it('an IT admin invitation is emailed as "IT admin"; a billing one as billing-only', async () => {
    mockGate.mockResolvedValue({ ok: true });
    mockSendInvite.mockResolvedValue({ success: true, outcome: 'sent' });
    mockRpc.mockResolvedValueOnce({ data: { success: true, slot: 'it', token: 'a'.repeat(64), email: 'it@example.test', org_name: 'fixture realty' }, error: null });
    const r = await invitePerson('ORG-1', { slot: 'it', email: 'it@example.test', firstName: 'Ira', lastName: 'Tech', phone: '' });
    expect(mockSendInvite.mock.calls[0][0]).toMatchObject({ recipientEmail: 'it@example.test', role: 'IT admin', inviterName: 'fixture admin' });
    expect(mockSendInvite.mock.calls[0][0].billingOnly).toBeUndefined();
    expect(r).toMatchObject({ ok: true, emailSent: true });
    mockRpc.mockResolvedValueOnce({ data: { success: true, slot: 'billing', token: 'b'.repeat(64), email: 'pay@example.test', name: 'payer team', org_name: 'fixture realty' }, error: null });
    await invitePerson('ORG-1', { slot: 'billing', email: 'pay@example.test', firstName: 'Pat', lastName: 'Payer', phone: '202-555-0132' });
    expect(mockSendInvite.mock.calls[1][0]).toMatchObject({ recipientEmail: 'pay@example.test', billingOnly: true, role: 'Billing only' });
  });

  it('the database refusal is passed through and nothing is emailed; 42501 reads not_authorized', async () => {
    mockGate.mockResolvedValue({ ok: true });
    mockRpc.mockResolvedValueOnce({ data: { success: false, error: 'seat_limit_reached' }, error: null });
    expect(await invitePerson('ORG-1', { slot: 'it', email: 'it@example.test', firstName: '', lastName: '', phone: '' })).toEqual({
      ok: false,
      error: 'seat_limit_reached',
    });
    mockRpc.mockResolvedValueOnce({ data: null, error: { code: '42501', message: 'Not authorized' } });
    expect(await listOrgContacts('ORG-1')).toEqual({ ok: false, error: 'not_authorized' });
    expect(mockSendInvite).not.toHaveBeenCalled();
  });
});
