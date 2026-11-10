// @vitest-environment jsdom

/**
 * BACKLOG-3976: Change Role on the user detail page's Organizations card.
 * Same dialog and server action as the organization members table. Shown per brokerage
 * membership to staff with users.edit; never on a personal organization.
 */

import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const refresh = vi.hoisted(() => vi.fn());
const changeMemberRole = vi.hoisted(() => vi.fn());
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), refresh }) }));
vi.mock('@/lib/actions/changeMemberRole', () => ({ changeMemberRole }));

import { OrganizationCard } from '../OrganizationCard';
import { ROLE_MANAGED_BY_IDP } from '@/lib/actions/changeMemberRole.helpers';

const BROKERAGE_A = {
  organization_id: 'org-a',
  org_name: 'Brokerage A',
  role: 'agent',
  joined_at: '2026-10-01T00:00:00.000Z',
  is_personal: false,
};
const BROKERAGE_B = { ...BROKERAGE_A, organization_id: 'org-b', org_name: 'Brokerage B', role: 'admin' };
const PERSONAL = { ...BROKERAGE_A, organization_id: 'org-p', org_name: 'Personal', role: 'admin', is_personal: true };

beforeAll(() => {
  // jsdom has no <dialog> modal API.
  HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement) {
    this.setAttribute('open', '');
  };
  HTMLDialogElement.prototype.close = function close(this: HTMLDialogElement) {
    this.removeAttribute('open');
  };
});
beforeEach(() => {
  refresh.mockReset();
  changeMemberRole.mockReset();
});
afterEach(cleanup);

function rowFor(name: string) {
  return screen.getByText(name).closest('li') as HTMLElement;
}

function submitIn(dialog: HTMLElement, role: string) {
  fireEvent.change(within(dialog).getByLabelText('Role'), { target: { value: role } });
  fireEvent.click(within(dialog).getByRole('button', { name: 'Change Role' }));
}

describe('OrganizationCard role change', () => {
  it('has no Change Role without users.edit', () => {
    render(<OrganizationCard memberships={[BROKERAGE_A]} userId="user-1" userName="Pat" />);
    expect(screen.queryByRole('button', { name: 'Change Role' })).toBeNull();
  });

  it('shows Change Role on every brokerage membership and calls the action for that org', async () => {
    changeMemberRole.mockResolvedValue({ success: true, oldRole: 'admin', newRole: 'broker' });
    render(
      <OrganizationCard memberships={[BROKERAGE_A, BROKERAGE_B]} userId="user-1" userName="Pat" canEditRole />
    );
    expect(screen.getAllByRole('button', { name: 'Change Role' })).toHaveLength(2);

    fireEvent.click(within(rowFor('Brokerage B')).getByRole('button', { name: 'Change Role' }));
    const dialog = within(rowFor('Brokerage B')).getByRole('dialog', { hidden: true });
    expect(dialog.hasAttribute('open')).toBe(true);
    submitIn(dialog, 'broker');

    await waitFor(() => expect(refresh).toHaveBeenCalled());
    expect(changeMemberRole).toHaveBeenCalledWith({ organizationId: 'org-b', userId: 'user-1', role: 'broker' });
    expect(screen.getByText("Changed Pat's role to Broker.")).toBeTruthy();
  });

  it('shows a refusal in the dialog and does not refresh', async () => {
    changeMemberRole.mockResolvedValue({ success: false, error: ROLE_MANAGED_BY_IDP });
    render(<OrganizationCard memberships={[BROKERAGE_A]} userId="user-1" userName="Pat" canEditRole />);
    fireEvent.click(screen.getByRole('button', { name: 'Change Role' }));
    submitIn(screen.getByRole('dialog', { hidden: true }), 'admin');
    expect((await screen.findByRole('alert')).textContent).toBe(ROLE_MANAGED_BY_IDP);
    expect(refresh).not.toHaveBeenCalled();
  });

  it('has no Change Role on a personal organization', () => {
    render(
      <OrganizationCard memberships={[PERSONAL, BROKERAGE_A]} userId="user-1" userName="Pat" canEditRole />
    );
    expect(within(rowFor('Personal')).queryByRole('button', { name: 'Change Role' })).toBeNull();
    expect(within(rowFor('Brokerage A')).getByRole('button', { name: 'Change Role' })).toBeTruthy();
    expect(screen.getByText('Personal').closest('li')?.textContent).toContain('admin');
  });
});
