/**
 * BACKLOG-4032 slice 2: Org Settings > People on a phone. Below md
 * ('(max-width: 767px)', the breakpoint UserListClient uses) the user pickers
 * open as a bottom sheet; a pick commits. At desktop width they stay popovers.
 *
 * The view shape is the one billing-login-4007/orgPeople.test.tsx transcribed
 * from org_contacts_list; names, emails and ids are invented, phones in the
 * reserved 555-01xx range.
 */
import '@testing-library/jest-dom';
import { act, cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const mockList = jest.fn();
const mockSave = jest.fn();
jest.mock('@/lib/actions/orgContacts', () => ({
  listOrgContacts: (...a: unknown[]) => mockList(...a),
  saveOrgContact: (...a: unknown[]) => mockSave(...a),
  removeOrgContact: jest.fn(async () => ({ ok: true })),
  invitePerson: jest.fn(async () => ({ ok: true, emailSent: true, inviteLink: null })),
}));

import { PeopleCard } from '@/components/settings/PeopleCard';

Object.assign(window.HTMLElement.prototype, {
  scrollIntoView: () => undefined,
  hasPointerCapture: () => false,
  releasePointerCapture: () => undefined,
});

function member(id: string, over: Record<string, unknown> = {}) {
  return {
    member_id: `m-${id}`, user_id: `u-${id}`, role: 'agent', license_status: 'active', billing_only: false,
    name: `Member ${id}`, email: `${id}@example.test`, phone: null, idp_managed: false, pending: false, ...over,
  };
}

const VIEW = {
  can_edit: true,
  can_edit_billing: true,
  can_edit_it: true,
  can_edit_phone: true,
  deal_status: 'active',
  contacts: [
    {
      id: 'b1', role: 'billing', name: 'Person b1', email: 'p-b1@example.test', phone: '+12025550123',
      company_name: null, member_id: 'm-b1', login: 'admin', login_claimed: true,
    },
  ],
  members: [member('ag'), member('bea', { name: 'Jane Doe', email: 'bea@example.test', phone: '+12025550131' })],
};

function setWidth(phone: boolean) {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: (query: string) => ({
      matches: phone && query === '(max-width: 767px)',
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }),
  });
}

async function settle() {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 20));
  });
}

async function openBillingEditor() {
  render(<PeopleCard organizationId="org-1" />);
  await settle();
  const billing = document.querySelector('[data-role="billing"]') as HTMLElement;
  await userEvent.click(within(billing).getByRole('button', { name: /^Edit / }));
  return screen.getByRole('dialog', { name: 'Edit billing contact' });
}

beforeEach(() => {
  jest.clearAllMocks();
  mockList.mockResolvedValue({ ok: true, view: VIEW });
  mockSave.mockResolvedValue({ ok: true });
});
afterEach(cleanup);
afterAll(() => {
  delete (window as unknown as { matchMedia?: unknown }).matchMedia;
});

describe('People pickers at phone width (BACKLOG-4032)', () => {
  it('phone: User opens a bottom sheet; a tap on a person commits, closes it and Save sends them', async () => {
    setWidth(true);
    const editor = await openBillingEditor();
    const userTrigger = within(editor).getByRole('button', { name: /^User / });
    expect(userTrigger).toHaveAttribute('aria-haspopup', 'dialog');

    await userEvent.click(userTrigger);
    await settle();
    const sheet = screen.getByRole('dialog', { name: 'User' });
    expect(document.querySelector('[data-slot="dropdown-panel"]')).toBeNull();
    expect(document.activeElement).toBe(within(sheet).getByRole('combobox', { name: 'Search name or email' }));

    await userEvent.click(within(sheet).getByRole('option', { name: /Jane Doe/ }));
    await settle();
    expect(screen.queryByRole('dialog', { name: 'User' })).toBeNull();
    expect(screen.getByRole('dialog', { name: 'Edit billing contact' })).toBeInTheDocument();
    expect(document.activeElement).toBe(userTrigger);
    expect(userTrigger).toHaveTextContent('Jane Doe');
    expect(screen.getByLabelText(/^Phone/)).toHaveValue('(202) 555-0131');

    await userEvent.click(within(screen.getByRole('dialog', { name: 'Edit billing contact' })).getByRole('button', { name: 'Save' }));
    await settle();
    expect(mockSave).toHaveBeenCalledWith('org-1', { role: 'billing', member_id: 'm-bea', phone: '(202) 555-0131' });
  });

  it('desktop: User opens the inline popover, no sheet', async () => {
    setWidth(false);
    const editor = await openBillingEditor();
    const userTrigger = within(editor).getByRole('button', { name: /^User / });
    expect(userTrigger).toHaveAttribute('aria-haspopup', 'listbox');
    await userEvent.click(userTrigger);
    expect(screen.queryByRole('dialog', { name: 'User' })).toBeNull();
    expect(document.querySelector('[data-slot="dropdown-panel"]')).not.toBeNull();
  });
});
