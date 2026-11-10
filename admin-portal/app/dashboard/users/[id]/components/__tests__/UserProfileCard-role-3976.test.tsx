// @vitest-environment jsdom

/**
 * BACKLOG-3976: Change Role in the user profile header. Shown to staff with users.edit when the
 * user has a brokerage membership; never offers a personal organization. One brokerage opens the
 * role dialog directly; several ask which brokerage first.
 */

import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const refresh = vi.hoisted(() => vi.fn());
const changeMemberRole = vi.hoisted(() => vi.fn());
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), refresh }) }));
vi.mock('@/lib/actions/changeMemberRole', () => ({ changeMemberRole }));

vi.mock('../ImpersonateButton', () => ({ ImpersonateButton: () => null }));
vi.mock('../SuspendDialog', () => ({ SuspendDialog: () => null }));
import { UserProfileCard } from '../UserProfileCard';
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

const USER = {
  id: 'user-1',
  email: 'pat@example.test',
  display_name: 'Pat',
  avatar_url: null,
  oauth_provider: 'google',
  status: 'active',
  subscription_tier: 'free',
  created_at: '2026-01-01T00:00:00.000Z',
  last_login_at: null,
};

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

function changeRoleButton() {
  return screen.queryByRole('button', { name: 'Change Role' });
}

function submitRole(role: string) {
  fireEvent.change(screen.getByLabelText('Role'), { target: { value: role } });
  const dialog = screen.getByLabelText('Role').closest('dialog') as HTMLElement;
  fireEvent.click(within(dialog).getByRole('button', { name: 'Change Role' }));
}

describe('UserProfileCard role change', () => {
  it('has no Change Role without users.edit', () => {
    render(<UserProfileCard user={USER} memberships={[BROKERAGE_A]} />);
    expect(changeRoleButton()).toBeNull();
  });

  it('has no Change Role when the only membership is a personal organization', () => {
    render(<UserProfileCard user={USER} canEditRole memberships={[PERSONAL]} />);
    expect(changeRoleButton()).toBeNull();
  });

  it('has no Change Role with no memberships', () => {
    render(<UserProfileCard user={USER} canEditRole memberships={[]} />);
    expect(changeRoleButton()).toBeNull();
  });

  it('one brokerage: opens the role dialog for that org and calls the action', async () => {
    changeMemberRole.mockResolvedValue({ success: true, oldRole: 'agent', newRole: 'broker' });
    render(<UserProfileCard user={USER} canEditRole memberships={[PERSONAL, BROKERAGE_A]} />);
    fireEvent.click(changeRoleButton() as HTMLElement);
    expect(screen.queryByLabelText('Organization')).toBeNull();
    submitRole('broker');

    await waitFor(() => expect(refresh).toHaveBeenCalled());
    expect(changeMemberRole).toHaveBeenCalledWith({ organizationId: 'org-a', userId: 'user-1', role: 'broker' });
    expect(screen.getByText("Changed Pat's role to Broker.")).toBeTruthy();
  });

  it('two brokerages: the picker lists both (not the personal org) and the chosen one is targeted', async () => {
    changeMemberRole.mockResolvedValue({ success: true, oldRole: 'admin', newRole: 'broker' });
    render(<UserProfileCard user={USER} canEditRole memberships={[PERSONAL, BROKERAGE_A, BROKERAGE_B]} />);
    fireEvent.click(changeRoleButton() as HTMLElement);

    const picker = screen.getByLabelText('Organization') as HTMLSelectElement;
    expect(Array.from(picker.options).map((o) => o.value)).toEqual(['org-a', 'org-b']);
    fireEvent.change(picker, { target: { value: 'org-b' } });
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    submitRole('broker');

    await waitFor(() => expect(refresh).toHaveBeenCalled());
    expect(changeMemberRole).toHaveBeenCalledTimes(1);
    expect(changeMemberRole).toHaveBeenCalledWith({ organizationId: 'org-b', userId: 'user-1', role: 'broker' });
  });

  it('two brokerages: Cancel closes the picker without opening the role dialog or calling the action', () => {
    render(<UserProfileCard user={USER} canEditRole memberships={[BROKERAGE_A, BROKERAGE_B]} />);
    fireEvent.click(changeRoleButton() as HTMLElement);
    expect(screen.getByLabelText('Organization')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(screen.queryByLabelText('Organization')).toBeNull();
    expect(screen.queryByLabelText('Role')).toBeNull();
    expect(document.querySelector('dialog[open]')).toBeNull();
    expect(changeMemberRole).not.toHaveBeenCalled();
  });

  it('shows a refusal in the dialog and does not refresh', async () => {
    changeMemberRole.mockResolvedValue({ success: false, error: ROLE_MANAGED_BY_IDP });
    render(<UserProfileCard user={USER} canEditRole memberships={[BROKERAGE_A]} />);
    fireEvent.click(changeRoleButton() as HTMLElement);
    submitRole('admin');
    expect((await screen.findByRole('alert')).textContent).toBe(ROLE_MANAGED_BY_IDP);
    expect(refresh).not.toHaveBeenCalled();
  });
});
