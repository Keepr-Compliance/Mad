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
import { useState } from 'react';
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
    invite: jest.fn(async () => ({ ok: true as const, emailSent: true, inviteLink: 'https://portal.example.test/invite/tok' })),
    ...over,
  };
}

function row(role: string): HTMLElement {
  return document.querySelector(`[data-role="${role}"]`) as HTMLElement;
}

// The Dropdown scrolls the active row into view; jsdom has no scrollIntoView. Radix Dialog
// touches pointer capture.
Object.assign(window.HTMLElement.prototype, {
  scrollIntoView: () => undefined,
  hasPointerCapture: () => false,
  releasePointerCapture: () => undefined,
});

function dialog(): HTMLElement {
  return screen.getByRole('dialog');
}

/** Each role row has ONE Edit button; it opens the popup. */
function openEdit(role: string) {
  fireEvent.click(within(row(role)).getByRole('button', { name: /^Edit / }));
}

/** A Dropdown trigger: its name is the label plus the chosen user (or the placeholder). */
function trigger(label: 'User' | 'Add a person'): HTMLElement {
  return within(dialog()).getByRole('button', { name: new RegExp(`^${label} `) });
}

async function openList(label: 'User' | 'Add a person' = 'User') {
  await act(async () => fireEvent.click(trigger(label)));
}

function search(text: string) {
  fireEvent.change(screen.getByRole('combobox', { name: 'Search name or email' }), { target: { value: text } });
}

function optionNames(): string[] {
  return screen.getAllByRole('option').map((o) => within(o).getAllByText(/./)[0].textContent ?? '');
}

async function pick(name: RegExp, label: 'User' | 'Add a person' = 'User') {
  await openList(label);
  await act(async () => fireEvent.click(screen.getByRole('option', { name })));
}

async function click(name: string | RegExp) {
  await act(async () => fireEvent.click(within(dialog()).getByRole('button', { name })));
}

function primary(name: string): HTMLElement {
  return within(dialog()).getByRole('button', { name });
}

beforeEach(() => jest.clearAllMocks());

describe('OrgPeoplePanel card (People popups)', () => {
  it('each row has ONE Edit button; the old per-row buttons are gone', () => {
    const view = { ...VIEW, contacts: [...VIEW.contacts, contact('i1', 'it'), contact('o1', 'office'), contact('m1', 'msp', { company_name: 'Fixture IT Co' })] };
    render(<OrgPeoplePanel view={view} actions={actions()} phone={PHONE} onChanged={jest.fn()} />);
    for (const r of ['billing', 'it', 'office', 'msp']) {
      expect(within(row(r)).getAllByRole('button').map((b) => b.textContent)).toEqual(['Edit']);
    }
    for (const gone of ['Add person', 'Invite new person', 'Change', 'Remove', 'Add another', 'Give billing-only login', 'Remove login']) {
      expect(screen.queryByText(gone)).not.toBeInTheDocument();
    }
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('the role pill renders right after the name; email · phone on the second line', () => {
    const view = { ...VIEW, contacts: [contact('b1', 'billing', { phone: '+12025550123', login: 'billing_only' }), contact('o1', 'office', { login: 'admin' })] };
    render(<OrgPeoplePanel view={view} actions={actions()} phone={PHONE} onChanged={jest.fn()} />);
    const name = within(row('billing')).getByText('Person b1');
    expect(name.nextElementSibling).toHaveTextContent('Billing-only login');
    expect(within(row('billing')).getByText('p-b1@example.test · (202) 555-0123')).toBeInTheDocument();
    expect(within(row('office')).getByText('Person o1').nextElementSibling).toHaveTextContent('Admin');
  });

  it('an empty row says "No one added"; MSP shows the company above its people', () => {
    const view = { ...VIEW, contacts: [...VIEW.contacts, contact('m1', 'msp', { company_name: 'Fixture IT Co', login: 'it_admin' })] };
    render(<OrgPeoplePanel view={view} actions={actions()} phone={PHONE} onChanged={jest.fn()} />);
    expect(within(row('it')).getByText('No one added')).toBeInTheDocument();
    const company = within(row('msp')).getByText('Fixture IT Co');
    const person = within(row('msp')).getByText('Person m1');
    expect(company.compareDocumentPosition(person) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('contact phones show formatted for US/CA numbers and as stored otherwise', () => {
    const view = { ...VIEW, contacts: [contact('b1', 'billing', { phone: '+12025550123' }), contact('o1', 'office', { phone: '+442071838750' })] };
    render(<OrgPeoplePanel view={view} actions={actions()} phone={PHONE} onChanged={jest.fn()} />);
    expect(within(row('billing')).getByText(/\(202\) 555-0123/)).toBeInTheDocument();
    expect(within(row('office')).getByText(/\+442071838750/)).toBeInTheDocument();
  });

  it('office lists 5 then Show more', () => {
    const office = Array.from({ length: 7 }, (_, i) => contact(`o${i}`, 'office'));
    render(<OrgPeoplePanel view={{ ...VIEW, contacts: [...VIEW.contacts, ...office] }} actions={actions()} phone={PHONE} onChanged={jest.fn()} />);
    expect(within(row('office')).getAllByText(/^Person o/)).toHaveLength(5);
    fireEvent.click(within(row('office')).getByText('Show more (2)'));
    expect(within(row('office')).getAllByText(/^Person o/)).toHaveLength(7);
  });

  it('names link to the user page only when the portal gives a link; invitations never link', () => {
    const view = {
      ...VIEW,
      contacts: [contact('b1', 'billing', { member_id: 'm-bea' }), contact('o1', 'office', { member_id: 'm-pend', login_claimed: false })],
      members: [...MEMBERS, member('pend', { user_id: null, pending: true, name: 'Pending Person' })],
    };
    const userHref = jest.fn((p: { member_id: string; user_id: string }) => `/dashboard/users/${p.member_id}`);
    const r = render(<OrgPeoplePanel view={view} actions={actions()} phone={PHONE} onChanged={jest.fn()} userHref={userHref} />);
    expect(within(row('billing')).getByRole('link', { name: 'Person b1' })).toHaveAttribute('href', '/dashboard/users/m-bea');
    expect(within(row('office')).queryByRole('link')).not.toBeInTheDocument();
    expect(userHref).toHaveBeenCalledWith({ member_id: 'm-bea', user_id: 'u-bea' });
    r.unmount();
    render(<OrgPeoplePanel view={view} actions={actions()} phone={PHONE} onChanged={jest.fn()} />);
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
  });
});

describe('OrgPeoplePanel popup: billing and IT contact', () => {
  it('Edit opens the dialog with the title and the current person chosen', () => {
    render(<OrgPeoplePanel view={VIEW} actions={actions()} phone={PHONE} onChanged={jest.fn()} />);
    openEdit('billing');
    expect(within(dialog()).getByRole('heading', { name: 'Edit billing contact' })).toBeInTheDocument();
    expect(trigger('User')).toHaveTextContent('Person b1');
    expect(screen.getByLabelText(/^Phone/)).toHaveValue('(202) 555-0123');
  });

  it('one User dropdown lists every member with email and role; typing filters by name or email', async () => {
    render(<OrgPeoplePanel view={VIEW} actions={actions()} phone={PHONE} onChanged={jest.fn()} />);
    openEdit('it');
    await openList();
    expect(optionNames()).toEqual(['Member ag', 'Jane Doe', 'fixture admin', 'Una Unlicensed', 'Ivy Idp']);
    expect(screen.getByRole('option', { name: /Jane Doe/ })).toHaveTextContent('bea@example.test · Agent');
    search('una');
    expect(optionNames()).toEqual(['Una Unlicensed']);
    search('bea@');
    expect(optionNames()).toEqual(['Jane Doe']);
  });

  it('IT contact: an unlicensed or IdP-managed agent shows the reason and cannot be picked; an admin can', async () => {
    render(<OrgPeoplePanel view={VIEW} actions={actions()} phone={PHONE} onChanged={jest.fn()} />);
    openEdit('it');
    await openList();
    const una = screen.getByRole('option', { name: /Una Unlicensed/ });
    expect(una).toHaveAttribute('aria-disabled', 'true');
    expect(una).toHaveAccessibleDescription('Needs a license first');
    expect(screen.getByRole('option', { name: /Ivy Idp/ })).toHaveAccessibleDescription('Managed by your identity provider.');
    expect(screen.getByRole('option', { name: /fixture admin/ })).not.toHaveAttribute('aria-disabled');
    await act(async () => fireEvent.click(una));
    expect(trigger('User')).toHaveTextContent('Choose a user');
    expect(primary('Save')).toBeDisabled();
  });

  it('save sends the same arguments as before: billing without an id, the member and the phone', async () => {
    const a = actions();
    const onChanged = jest.fn();
    render(<OrgPeoplePanel view={VIEW} actions={a} phone={PHONE} onChanged={onChanged} />);
    openEdit('billing');
    await pick(/Jane Doe/);
    expect(screen.getByLabelText(/^Phone/)).toHaveValue('(202) 555-0131');
    await click('Save');
    expect(a.save).toHaveBeenCalledWith({ role: 'billing', member_id: 'm-bea', phone: '(202) 555-0131' });
    expect(onChanged).toHaveBeenCalled();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('changing the IT contact sends its id; Remove (left in the footer) calls org_contact_remove', async () => {
    const a = actions();
    const view = { ...VIEW, contacts: [...VIEW.contacts, contact('i1', 'it', { member_id: 'm-adm', login: 'admin' })] };
    render(<OrgPeoplePanel view={view} actions={a} phone={PHONE} onChanged={jest.fn()} />);
    openEdit('it');
    await pick(/fixture admin/);
    await click('Save');
    expect(a.save).toHaveBeenCalledWith({ id: 'i1', role: 'it', member_id: 'm-adm' });
    openEdit('it');
    const footer = within(dialog()).getByRole('button', { name: 'Remove' }).parentElement as HTMLElement;
    expect(within(footer).getAllByRole('button').map((b) => b.textContent)).toEqual(['Remove', 'Cancel', 'Save']);
    await click('Remove');
    expect(a.remove).toHaveBeenCalledWith('i1');
  });

  it('the billing contact can be changed, not removed: no Remove in its popup', () => {
    render(<OrgPeoplePanel view={VIEW} actions={actions()} phone={PHONE} onChanged={jest.fn()} />);
    openEdit('billing');
    expect(within(dialog()).queryByRole('button', { name: 'Remove' })).not.toBeInTheDocument();
  });

  it('an agent picked as IT contact: the database asks to confirm, the popup says so, only the confirm saves', async () => {
    const save = jest
      .fn()
      .mockResolvedValueOnce({ ok: false, error: 'role_change_needs_confirm', role: 'agent' })
      .mockResolvedValueOnce({ ok: true });
    const onChanged = jest.fn();
    render(<OrgPeoplePanel view={VIEW} actions={actions({ save })} phone={PHONE} onChanged={onChanged} />);
    openEdit('it');
    await pick(/Member ag/);
    await click('Save');
    expect(within(dialog()).getByText('Member ag is an Agent now. Saving makes them an IT admin.')).toBeInTheDocument();
    expect(onChanged).not.toHaveBeenCalled();
    expect(save).toHaveBeenCalledTimes(1);
    await click('Make IT admin');
    expect(save.mock.calls[0][0]).toEqual({ role: 'it', member_id: 'm-ag' });
    expect(save.mock.calls[1][0]).toEqual({ role: 'it', member_id: 'm-ag', confirm_role_change: true });
    expect(onChanged).toHaveBeenCalled();
  });

  it('the billing contact needs a phone unless the person has one; IT says optional', async () => {
    render(<OrgPeoplePanel view={VIEW} actions={actions()} phone={PHONE} onChanged={jest.fn()} />);
    openEdit('billing');
    await pick(/Member ag/);
    expect(primary('Save')).toBeDisabled();
    fireEvent.change(screen.getByLabelText(/^Phone/), { target: { value: '2025550140' } });
    expect(primary('Save')).not.toBeDisabled();
    fireEvent.change(screen.getByLabelText(/^Phone/), { target: { value: '' } });
    expect(primary('Save')).toBeDisabled();
    await pick(/Jane Doe/);
    expect(primary('Save')).not.toBeDisabled();
    await click('Cancel');
    openEdit('it');
    expect(screen.getByLabelText(/^Phone/).closest('div')).toHaveTextContent('(optional)');
    await pick(/fixture admin/);
    expect(primary('Save')).not.toBeDisabled();
  });

  it('a refusal is worded inside the popup', async () => {
    const a = actions({ save: jest.fn(async () => ({ ok: false as const, error: 'managed_by_idp' })) });
    render(<OrgPeoplePanel view={VIEW} actions={a} phone={PHONE} onChanged={jest.fn()} />);
    openEdit('it');
    await pick(/Member ag/);
    await click('Save');
    expect(within(dialog()).getByText('Managed by your identity provider.')).toBeInTheDocument();
  });

  it('button variants: Edit and Cancel are secondary, Save is primary, nothing is dark', () => {
    const { container } = render(<OrgPeoplePanel view={VIEW} actions={actions()} phone={PHONE} onChanged={jest.fn()} />);
    expect(within(row('office')).getByText('Edit').className).toContain('bg-white');
    openEdit('office');
    expect(primary('Cancel').className).toContain('bg-white');
    expect(primary('Save').className).toContain('bg-primary-600');
    expect(container.querySelector('.bg-gray-900')).toBeNull();
    expect(dialog().querySelector('.bg-gray-900')).toBeNull();
  });
});

describe('OrgPeoplePanel popup: Invite new person', () => {
  it('billing, IT (while empty) and MSP have the invite tab; office never; IT once set has none', () => {
    const r = render(<OrgPeoplePanel view={VIEW} actions={actions()} phone={PHONE} onChanged={jest.fn()} />);
    for (const role of ['billing', 'it', 'msp']) {
      openEdit(role);
      expect(within(dialog()).getByRole('tab', { name: 'Invite new person' })).toBeInTheDocument();
      fireEvent.click(primary('Cancel'));
    }
    openEdit('office');
    expect(within(dialog()).queryByRole('tablist')).not.toBeInTheDocument();
    expect(within(dialog()).queryByText('Invite new person')).not.toBeInTheDocument();
    expect(within(dialog()).getByText('Not listed? Invite them from Users first.')).toBeInTheDocument();
    r.unmount();
    render(<OrgPeoplePanel view={{ ...VIEW, contacts: [...VIEW.contacts, contact('i1', 'it')] }} actions={actions()} phone={PHONE} onChanged={jest.fn()} />);
    openEdit('it');
    expect(within(dialog()).queryByRole('tablist')).not.toBeInTheDocument();
  });

  it('no invite action from the portal: no tab', () => {
    render(<OrgPeoplePanel view={VIEW} actions={{ save: jest.fn(), remove: jest.fn() }} phone={PHONE} onChanged={jest.fn()} />);
    openEdit('billing');
    expect(within(dialog()).queryByRole('tablist')).not.toBeInTheDocument();
  });

  it('billing invite: phone required, "no seat", org_people_invite gets the same fields', async () => {
    const a = actions();
    const onChanged = jest.fn();
    render(<OrgPeoplePanel view={VIEW} actions={a} phone={PHONE} onChanged={onChanged} />);
    openEdit('billing');
    fireEvent.click(within(dialog()).getByRole('tab', { name: 'Invite new person' }));
    expect(within(dialog()).getByTestId('op-seat-line')).toHaveTextContent('We email them an invite. They join with a Billing-only login and use no seat.');
    fireEvent.change(screen.getByLabelText(/Work email/), { target: { value: ' pay@example.test ' } });
    fireEvent.change(screen.getByLabelText('First name'), { target: { value: 'Pat' } });
    fireEvent.change(screen.getByLabelText('Last name'), { target: { value: 'Payer' } });
    expect(primary('Send invite')).toBeDisabled();
    fireEvent.change(screen.getByLabelText(/^Phone/), { target: { value: '2025550132' } });
    await click('Send invite');
    expect(a.invite).toHaveBeenCalledWith('billing', { email: 'pay@example.test', firstName: 'Pat', lastName: 'Payer', phone: '(202) 555-0132' });
    expect(a.save).not.toHaveBeenCalled();
    expect(onChanged).toHaveBeenCalled();
    expect(screen.getByText('Invite sent to pay@example.test.')).toBeInTheDocument();
  });

  it('IT invite: "IT admin ... 1 seat", phone optional; an unsent email shows the link to share', async () => {
    const a = actions({ invite: jest.fn(async () => ({ ok: true as const, emailSent: false, inviteLink: 'https://portal.example.test/invite/abc' })) });
    render(<OrgPeoplePanel view={VIEW} actions={a} phone={PHONE} onChanged={jest.fn()} />);
    openEdit('it');
    fireEvent.click(within(dialog()).getByRole('tab', { name: 'Invite new person' }));
    expect(within(dialog()).getByTestId('op-seat-line')).toHaveTextContent('We email them an invite. They join as an IT admin and use 1 seat.');
    fireEvent.change(screen.getByLabelText(/Work email/), { target: { value: 'it@example.test' } });
    await click('Send invite');
    expect(a.invite).toHaveBeenCalledWith('it', { email: 'it@example.test', firstName: '', lastName: '', phone: '' });
    expect(screen.getByText(/could not be sent\. Share this link with it@example\.test: https:\/\/portal\.example\.test\/invite\/abc/)).toBeInTheDocument();
  });

  it('MSP invite: the company is required and sent; a refusal is worded', async () => {
    const a = actions({ invite: jest.fn(async () => ({ ok: false as const, error: 'seat_limit_reached' })) });
    const view = { ...VIEW, contacts: [...VIEW.contacts, contact('m1', 'msp', { company_name: 'Fixture IT Co' })] };
    render(<OrgPeoplePanel view={view} actions={a} phone={PHONE} onChanged={jest.fn()} />);
    openEdit('msp');
    fireEvent.click(within(dialog()).getByRole('tab', { name: 'Invite new person' }));
    expect(screen.getByLabelText(/IT provider company/)).toHaveValue('Fixture IT Co');
    fireEvent.change(screen.getByLabelText(/Work email/), { target: { value: 'msp@example.test' } });
    fireEvent.change(screen.getByLabelText(/IT provider company/), { target: { value: '' } });
    expect(primary('Send invite')).toBeDisabled();
    fireEvent.change(screen.getByLabelText(/IT provider company/), { target: { value: 'Fixture IT Co' } });
    await click('Send invite');
    expect(a.invite).toHaveBeenCalledWith('msp', { email: 'msp@example.test', firstName: '', lastName: '', phone: '', companyName: 'Fixture IT Co' });
    expect(within(dialog()).getByText('No license is free. The IT contact uses a seat.')).toBeInTheDocument();
  });
});

describe('OrgPeoplePanel popup: office and MSP', () => {
  const OFFICE = [contact('o1', 'office', { member_id: 'm-adm', name: 'fixture admin', phone: '+12025550170', login: 'admin' }), contact('o2', 'office', { member_id: 'm-ag', name: 'Member ag' })];

  it('lists the people with a phone input and a remove button each; Save is off until something changes', () => {
    render(<OrgPeoplePanel view={{ ...VIEW, contacts: [...VIEW.contacts, ...OFFICE] }} actions={actions()} phone={PHONE} onChanged={jest.fn()} />);
    openEdit('office');
    expect(screen.getByLabelText('Phone for fixture admin')).toHaveValue('(202) 555-0170');
    expect(screen.getByLabelText('Phone for Member ag')).toHaveValue('');
    expect(within(dialog()).getByRole('button', { name: 'Remove fixture admin' })).toBeInTheDocument();
    expect(primary('Save')).toBeDisabled();
  });

  it('Save sends one call per change: remove, phone update (with the id), add', async () => {
    const a = actions();
    const onChanged = jest.fn();
    render(<OrgPeoplePanel view={{ ...VIEW, contacts: [...VIEW.contacts, ...OFFICE] }} actions={a} phone={PHONE} onChanged={onChanged} />);
    openEdit('office');
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Remove Member ag' }));
    fireEvent.change(screen.getByLabelText('Phone for fixture admin'), { target: { value: '2025550171' } });
    await pick(/Jane Doe/, 'Add a person');
    expect(screen.getByLabelText('Phone for Jane Doe')).toHaveValue('(202) 555-0131');
    expect(a.save).not.toHaveBeenCalled();
    expect(a.remove).not.toHaveBeenCalled();
    await click('Save');
    expect((a.remove as jest.Mock).mock.calls).toEqual([['o2']]);
    expect((a.save as jest.Mock).mock.calls.map((c) => c[0])).toEqual([
      { id: 'o1', role: 'office', member_id: 'm-adm', phone: '(202) 555-0171' },
      { role: 'office', member_id: 'm-bea', phone: '(202) 555-0131' },
    ]);
    expect(onChanged).toHaveBeenCalledTimes(1);
  });

  it('Cancel after a remove calls nothing', () => {
    const a = actions();
    render(<OrgPeoplePanel view={{ ...VIEW, contacts: [...VIEW.contacts, ...OFFICE] }} actions={a} phone={PHONE} onChanged={jest.fn()} />);
    openEdit('office');
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Remove Member ag' }));
    fireEvent.click(primary('Cancel'));
    expect(a.remove).not.toHaveBeenCalled();
  });

  it('MSP: an agent added needs the confirm; the confirm resends only that person', async () => {
    const save = jest
      .fn()
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({ ok: false, error: 'role_change_needs_confirm', role: 'broker' })
      .mockResolvedValueOnce({ ok: true });
    const onChanged = jest.fn();
    const view = { ...VIEW, members: [...MEMBERS, member('bro', { role: 'broker', name: 'Bo Broker' })] };
    render(<OrgPeoplePanel view={view} actions={actions({ save })} phone={PHONE} onChanged={onChanged} />);
    openEdit('msp');
    fireEvent.change(screen.getByLabelText(/IT provider company/), { target: { value: 'Fixture IT Co' } });
    await pick(/fixture admin/, 'Add a person');
    await pick(/Bo Broker/, 'Add a person');
    await click('Save');
    expect(within(dialog()).getByText('Bo Broker is a Broker now. Saving makes them an IT admin.')).toBeInTheDocument();
    await click('Make IT admin');
    expect(save.mock.calls.map((c) => c[0])).toEqual([
      { role: 'msp', member_id: 'm-adm', company_name: 'Fixture IT Co' },
      { role: 'msp', member_id: 'm-bro', company_name: 'Fixture IT Co' },
      { role: 'msp', member_id: 'm-bro', company_name: 'Fixture IT Co', confirm_role_change: true },
    ]);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('MSP: changing the company re-saves each person with it', async () => {
    const a = actions();
    const view = { ...VIEW, contacts: [...VIEW.contacts, contact('m1', 'msp', { member_id: 'm-adm', company_name: 'Old IT' })] };
    render(<OrgPeoplePanel view={view} actions={a} phone={PHONE} onChanged={jest.fn()} />);
    openEdit('msp');
    fireEvent.change(screen.getByLabelText(/IT provider company/), { target: { value: 'New IT' } });
    await click('Save');
    expect(a.save).toHaveBeenCalledWith({ id: 'm1', role: 'msp', member_id: 'm-adm', company_name: 'New IT' });
  });
});

describe('OrgPeoplePanel permissions', () => {
  it('an IT admin (can_edit_phone false, can_edit_billing false): no phone field, billing row read-only', () => {
    const view = { ...VIEW, can_edit_billing: false, can_edit_phone: false, contacts: [...VIEW.contacts, contact('o1', 'office')] };
    render(<OrgPeoplePanel view={view} actions={actions()} phone={PHONE} onChanged={jest.fn()} />);
    expect(within(row('billing')).queryByRole('button')).not.toBeInTheDocument();
    expect(within(row('billing')).getByText('Only a broker or admin can change it.')).toBeInTheDocument();
    openEdit('office');
    expect(screen.queryByLabelText(/Phone/)).not.toBeInTheDocument();
    fireEvent.click(primary('Cancel'));
    openEdit('it');
    expect(screen.queryByLabelText(/Phone/)).not.toBeInTheDocument();
  });

  it('a broker (can_edit_it false): the IT contact and MSP rows have no Edit (founder R7)', () => {
    render(<OrgPeoplePanel view={{ ...VIEW, can_edit_it: false }} actions={actions()} phone={PHONE} onChanged={jest.fn()} />);
    expect(within(row('it')).queryByRole('button')).not.toBeInTheDocument();
    expect(within(row('msp')).queryByRole('button')).not.toBeInTheDocument();
    expect(within(row('it')).getByText('Only an admin or IT admin can change it.')).toBeInTheDocument();
    expect(within(row('office')).getByText('Edit')).toBeInTheDocument();
    expect(within(row('billing')).getByText('Edit')).toBeInTheDocument();
  });

  it('waiting for setup: the billing contact is set in the guide, no Edit on that row', () => {
    render(<OrgPeoplePanel view={{ ...VIEW, deal_status: 'draft' }} actions={actions()} phone={PHONE} onChanged={jest.fn()} />);
    expect(within(row('billing')).getByText('Set in the setup guide.')).toBeInTheDocument();
    expect(within(row('billing')).queryByRole('button')).not.toBeInTheDocument();
  });

  it('read-only shows no buttons and no links', () => {
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

/**
 * A portal stand-in: the "server" is `db`; onChanged re-reads it into a NEW view object, as the
 * real portals do after a change. Save refuses the members in `refuse` with contact_exists (the
 * refusal code the RPC uses; a real one for office and MSP adds).
 */
function liveHost(role: 'office' | 'msp', initial: Array<Record<string, unknown>>, opts: { refuse?: Set<string>; throwOn?: Set<string> } = {}) {
  const db = [...initial];
  const refuse = opts.refuse ?? new Set<string>();
  const throwOn = opts.throwOn ?? new Set<string>();
  let seq = 0;
  const saveCalls: Array<Record<string, unknown>> = [];
  const removeCalls: string[] = [];
  const viewNow = (): OrgPeopleView => ({ ...VIEW, contacts: [...VIEW.contacts, ...db.map((c) => ({ ...c }))] as OrgPeopleView['contacts'] });
  const changed = jest.fn();
  const a: OrgPeopleActions = {
    save: jest.fn(async (input) => {
      saveCalls.push(input as unknown as Record<string, unknown>);
      if (throwOn.has(input.member_id)) throw new Error('network');
      if (refuse.has(input.member_id)) return { ok: false as const, error: 'contact_exists' };
      if (input.id) {
        const c = db.find((x) => x.id === input.id)!;
        c.phone = input.phone ? `+1${input.phone.replace(/\D/g, '')}` : c.phone;
        if (input.company_name !== undefined) c.company_name = input.company_name;
      } else {
        const m = MEMBERS.find((x) => x.member_id === input.member_id)!;
        db.push(contact(`n${++seq}`, role, { member_id: m.member_id, name: m.name, phone: input.phone ? `+1${input.phone.replace(/\D/g, '')}` : null, company_name: input.company_name ?? null }));
      }
      return { ok: true as const };
    }),
    remove: jest.fn(async (id) => {
      removeCalls.push(id);
      const i = db.findIndex((x) => x.id === id);
      if (i >= 0) db.splice(i, 1);
      return { ok: true as const };
    }),
  };
  function Host() {
    const [view, setView] = useState(viewNow);
    return <OrgPeoplePanel view={view} actions={a} phone={PHONE} onChanged={() => { changed(); setView(viewNow()); }} />;
  }
  return { Host, db, refuse, throwOn, saveCalls, removeCalls, changed };
}

describe('OrgPeoplePanel popup: a save that fails part-way', () => {
  const JANE = (over: Record<string, unknown> = {}) => contact('o1', 'office', { member_id: 'm-bea', name: 'Jane Doe', phone: '+12025550131', ...over });

  it('the error names the person whose change failed and says the earlier ones were saved; the list re-reads', async () => {
    const h = liveHost('office', [], { refuse: new Set(['m-un']) });
    render(<h.Host />);
    openEdit('office');
    await pick(/Jane Doe/, 'Add a person');
    await pick(/Una Unlicensed/, 'Add a person');
    await click('Save');
    const alert = within(dialog()).getByText(/Una Unlicensed:/);
    expect(alert).toHaveTextContent('Una Unlicensed: This person is already listed in this role. The changes before this one were saved.');
    expect(h.changed).toHaveBeenCalledTimes(1);
    expect(within(row('office')).getByText('Jane Doe')).toBeInTheDocument();
    expect(dialog()).toBeInTheDocument();
  });

  it('the first change failing names the person and does not claim anything was saved', async () => {
    const h = liveHost('office', [], { refuse: new Set(['m-bea']) });
    render(<h.Host />);
    openEdit('office');
    await pick(/Jane Doe/, 'Add a person');
    await click('Save');
    expect(within(dialog()).getByText(/Jane Doe:/)).not.toHaveTextContent('were saved');
    expect(h.changed).toHaveBeenCalledTimes(1);
  });

  it('removing a person saved a moment ago in the same popup calls remove, not a silent close', async () => {
    const h = liveHost('office', [], { refuse: new Set(['m-un']) });
    render(<h.Host />);
    openEdit('office');
    await pick(/Jane Doe/, 'Add a person');
    await pick(/Una Unlicensed/, 'Add a person');
    await click('Save');
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Remove Jane Doe' }));
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Remove Una Unlicensed' }));
    await click('Save');
    expect(h.removeCalls).toEqual(['n1']);
    expect(h.db).toEqual([]);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('a second phone edit to a person saved in the failed attempt saves', async () => {
    const h = liveHost('office', [JANE()], { refuse: new Set(['m-un']) });
    render(<h.Host />);
    openEdit('office');
    fireEvent.change(screen.getByLabelText('Phone for Jane Doe'), { target: { value: '2025550171' } });
    await pick(/Una Unlicensed/, 'Add a person');
    await click('Save');
    expect(h.db[0].phone).toBe('+12025550171');
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Remove Una Unlicensed' }));
    fireEvent.change(screen.getByLabelText('Phone for Jane Doe'), { target: { value: '2025550172' } });
    expect(primary('Save')).toBeEnabled();
    await click('Save');
    expect(h.saveCalls.map((c) => [c.member_id, c.id, c.phone])).toEqual([
      ['m-bea', 'o1', '(202) 555-0171'],
      ['m-un', undefined, undefined],
      ['m-bea', 'o1', '(202) 555-0172'],
    ]);
    expect(h.db[0].phone).toBe('+12025550172');
  });

  it('a thrown action does not leave the popup stuck on Saving', async () => {
    const h = liveHost('office', [], { throwOn: new Set(['m-bea']) });
    render(<h.Host />);
    openEdit('office');
    await pick(/Jane Doe/, 'Add a person');
    await click('Save');
    expect(primary('Save')).toBeEnabled();
    expect(within(dialog()).getByText(/Jane Doe: Something went wrong/)).toBeInTheDocument();
    expect(within(dialog()).queryByText('Saving…')).not.toBeInTheDocument();
  });

  it('a thrown save or remove in a single-person popup does not leave it stuck on Saving', async () => {
    const view = { ...VIEW, contacts: [...VIEW.contacts, contact('i1', 'it', { member_id: 'm-adm', name: 'fixture admin' })] };
    const save = jest.fn(async () => {
      throw new Error('network');
    });
    const remove = jest.fn(async () => {
      throw new Error('network');
    });
    render(<OrgPeoplePanel view={view} actions={actions({ save, remove })} phone={PHONE} onChanged={jest.fn()} />);
    openEdit('it');
    await pick(/Jane Doe/);
    await click('Save');
    expect(primary('Save')).toBeEnabled();
    expect(within(dialog()).getByText('Something went wrong. Please try again.')).toBeInTheDocument();
    await click('Remove');
    expect(remove).toHaveBeenCalledTimes(1);
    expect(primary('Cancel')).toBeEnabled();
    expect(within(dialog()).queryByText('Saving…')).not.toBeInTheDocument();
  });

  it('MSP: after a company change fails part-way, the retry sends only the person not yet saved', async () => {
    const two = [contact('m1', 'msp', { member_id: 'm-adm', name: 'fixture admin', company_name: 'Old IT' }), contact('m2', 'msp', { member_id: 'm-ag', name: 'Member ag', company_name: 'Old IT' })];
    const h = liveHost('msp', two, { refuse: new Set(['m-ag']) });
    render(<h.Host />);
    openEdit('msp');
    fireEvent.change(screen.getByLabelText(/IT provider company/), { target: { value: 'New IT' } });
    await click('Save');
    expect(within(dialog()).getByText(/Member ag:/)).toBeInTheDocument();
    h.refuse.clear();
    h.saveCalls.length = 0;
    await click('Save');
    expect(h.saveCalls).toEqual([{ id: 'm2', role: 'msp', member_id: 'm-ag', company_name: 'New IT' }]);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});
