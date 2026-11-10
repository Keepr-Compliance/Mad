// @vitest-environment jsdom

/**
 * BACKLOG-3976: the Change Role control on the organization members table.
 * Shown only to staff with users.edit (canEditRole); the server re-checks it (supabase/tests/backlog-3976).
 * A refusal is shown in the dialog; a change refreshes the page.
 */

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const refresh = vi.hoisted(() => vi.fn());
const changeMemberRole = vi.hoisted(() => vi.fn());
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), refresh }) }));
vi.mock('@/components/pwa/NavigationProgress', () => ({ startNavigationProgress: vi.fn() }));
vi.mock('@/lib/admin-queries', () => ({ suspendUser: vi.fn(), unsuspendUser: vi.fn() }));
vi.mock('@/lib/actions/changeMemberRole', () => ({ changeMemberRole }));

import { MembersTable, type MemberRow } from '../MembersTable';
import { LAST_ADMIN_DEMOTE_REFUSED } from '@/lib/actions/changeMemberRole.helpers';

const MEMBER: MemberRow = {
  user_id: 'user-1',
  display_name: 'Pat Admin',
  email: 'pat@example.test',
  role: 'admin',
  license_status: 'active',
  joined_at: '2026-10-01T00:00:00.000Z',
  status: 'active',
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

function openMenu() {
  fireEvent.click(screen.getByRole('button', { name: 'Actions' }));
}

describe('MembersTable role change', () => {
  it('has no Change Role item without users.edit', () => {
    render(<MembersTable members={[MEMBER]} organizationId="org-1" />);
    openMenu();
    expect(screen.getByText('View User Detail')).toBeTruthy();
    expect(screen.queryByText('Change Role')).toBeNull();
  });

  it('changes the role with users.edit and refreshes', async () => {
    changeMemberRole.mockResolvedValue({ success: true, oldRole: 'admin', newRole: 'broker' });
    render(<MembersTable members={[MEMBER]} organizationId="org-1" canEditRole />);
    openMenu();
    fireEvent.click(screen.getByText('Change Role'));
    fireEvent.change(screen.getByLabelText('Role'), { target: { value: 'broker' } });
    fireEvent.click(screen.getByRole('button', { name: 'Change Role' }));
    await waitFor(() => expect(refresh).toHaveBeenCalled());
    expect(changeMemberRole).toHaveBeenCalledWith({ organizationId: 'org-1', userId: 'user-1', role: 'broker' });
    expect(screen.getByText("Changed Pat Admin's role to Broker.")).toBeTruthy();
  });

  it('shows the refusal in the dialog and does not refresh', async () => {
    changeMemberRole.mockResolvedValue({ success: false, error: LAST_ADMIN_DEMOTE_REFUSED });
    render(<MembersTable members={[MEMBER]} organizationId="org-1" canEditRole />);
    openMenu();
    fireEvent.click(screen.getByText('Change Role'));
    fireEvent.change(screen.getByLabelText('Role'), { target: { value: 'agent' } });
    fireEvent.click(screen.getByRole('button', { name: 'Change Role' }));
    expect((await screen.findByRole('alert')).textContent).toBe(LAST_ADMIN_DEMOTE_REFUSED);
    expect(refresh).not.toHaveBeenCalled();
  });
});
