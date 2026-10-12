/**
 * BACKLOG-3904: the Users page's phone filter bar and results row (shared kit
 * components). Presentation only: the filters, their options and their results
 * are the desktop ones. Member shape follows app/dashboard/users/page.tsx.
 */
import React from 'react';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import '@testing-library/jest-dom';

jest.mock('next/navigation', () => ({ useRouter: () => ({ refresh: jest.fn(), push: jest.fn() }) }));
jest.mock('@/components/users/InviteUserModal', () => ({
  __esModule: true,
  default: ({ isOpen }: { isOpen: boolean }) => (isOpen ? <div data-testid="invite-modal" /> : null),
}));
jest.mock('@/components/users/EditRoleModal', () => ({ __esModule: true, default: () => null }));
jest.mock('@/components/users/BulkEditRoleModal', () => ({ __esModule: true, default: () => null }));
jest.mock('@/components/users/DeactivateUserModal', () => ({ __esModule: true, default: () => null }));
jest.mock('@/components/users/RemoveUserModal', () => ({ __esModule: true, default: () => null }));
jest.mock('@/lib/actions/resendInvite', () => ({ resendInvite: jest.fn() }));

import UserListClient from '@/components/users/UserListClient';
import type { OrganizationMember } from '@/lib/types/users';

function member(i: number, role: string, status: string, first: string): OrganizationMember {
  return {
    id: `m${i}`, organization_id: 'org-1', user_id: `u${i}`, role, license_status: status,
    invited_email: null, invitation_token: null, invitation_expires_at: null, invited_by: null,
    invited_at: null, joined_at: '2024-01-01T00:00:00Z', last_invited_at: null,
    created_at: '2024-01-01T00:00:00Z', updated_at: '2024-01-01T00:00:00Z',
    user: { id: `u${i}`, email: `${first.toLowerCase()}@example.test`, first_name: first, last_name: 'Fixture', display_name: null, avatar_url: null },
  } as unknown as OrganizationMember;
}

// 4 members: agent/active Ann, agent/pending Bob, broker/active Cy, admin/suspended Di.
const MEMBERS = [
  member(1, 'agent', 'active', 'Ann'),
  member(2, 'agent', 'pending', 'Bob'),
  member(3, 'broker', 'active', 'Cy'),
  member(4, 'admin', 'suspended', 'Di'),
];

function renderList(role: 'admin' | 'broker' = 'admin', readOnly = false) {
  return render(
    <UserListClient initialMembers={MEMBERS} currentUserId="u0" currentUserRole={role} organizationId="org-1" readOnly={readOnly} />
  );
}
const phoneRow = () => document.querySelector('[data-slot=phone-results-row]') as HTMLElement;
const phoneSearch = () => document.getElementById('user-search-phone') as HTMLInputElement;
/** Rendered user cards/rows (jsdom has no matchMedia: the desktop table renders). */
const renderedRows = () => document.querySelectorAll('tbody tr').length;

afterEach(cleanup);

describe('Users phone bar', () => {
  it('has a search with an X, then Role and Status buttons in a 2-column grid', () => {
    renderList();
    fireEvent.change(phoneSearch(), { target: { value: 'ann' } });
    expect(screen.getByRole('button', { name: 'Clear search' })).toBeInTheDocument();
    const role = screen.getByRole('button', { name: 'Role: All Roles' });
    const status = screen.getByRole('button', { name: 'Status: All Statuses' });
    expect(role.parentElement).toBe(status.parentElement);
    expect(role.parentElement!.className).toContain('grid-cols-2');
  });

  it('the row is always shown: "Showing X of Y users" with Invite user on the right', () => {
    renderList();
    expect(phoneRow()).toHaveTextContent('Showing 4 of 4 users');
    expect(within(phoneRow()).getByRole('button', { name: /Invite user/ })).toBeInTheDocument();
    expect(within(phoneRow()).queryByRole('button', { name: 'Clear filters' })).toBeNull();
    fireEvent.click(within(phoneRow()).getByRole('button', { name: /Invite user/ }));
    expect(screen.getByTestId('invite-modal')).toBeInTheDocument();
  });

  it('a viewer who cannot manage gets the row without Invite', () => {
    renderList('broker');
    expect(phoneRow()).toHaveTextContent('Showing 4 of 4 users');
    expect(within(phoneRow()).queryByRole('button', { name: /Invite user/ })).toBeNull();
  });

  it('X is the rendered rows and Y is the total, counted before the filters', () => {
    renderList();
    fireEvent.change(phoneSearch(), { target: { value: 'ann' } });
    expect(renderedRows()).toBe(1);
    expect(phoneRow()).toHaveTextContent('Showing 1 of 4 users');
    fireEvent.change(phoneSearch(), { target: { value: 'nobody' } });
    expect(renderedRows()).toBe(0);
    expect(phoneRow()).toHaveTextContent('Showing 0 of 4 users');
  });

  it('Role and Status filters give the desktop results (AND), via the sheets', () => {
    renderList();
    fireEvent.click(screen.getByRole('button', { name: 'Role: All Roles' }));
    let sheet = screen.getByRole('dialog', { name: 'Role' });
    fireEvent.click(within(sheet).getByLabelText('Agent'));
    expect(within(sheet).getByRole('button', { name: 'Show 2 users' })).toBeInTheDocument();
    fireEvent.click(within(sheet).getByRole('button', { name: 'Show 2 users' }));
    expect(renderedRows()).toBe(2);
    expect(phoneRow()).toHaveTextContent('Showing 2 of 4 users');
    fireEvent.click(screen.getByRole('button', { name: 'Status: All Statuses' }));
    sheet = screen.getByRole('dialog', { name: 'Status' });
    fireEvent.click(within(sheet).getByLabelText('Pending'));
    fireEvent.click(within(sheet).getByRole('button', { name: 'Show 1 user' }));
    expect(renderedRows()).toBe(1);
    expect(phoneRow()).toHaveTextContent('Showing 1 of 4 users');
    expect(screen.getByRole('button', { name: 'Role: Agent' })).toBeInTheDocument();
  });

  it('Clear filters appears with a role or status filter and resets those two, leaving the search text', () => {
    renderList();
    fireEvent.change(phoneSearch(), { target: { value: 'ann' } });
    fireEvent.click(screen.getByRole('button', { name: 'Role: All Roles' }));
    fireEvent.click(within(screen.getByRole('dialog', { name: 'Role' })).getByLabelText('Agent'));
    fireEvent.click(within(screen.getByRole('dialog', { name: 'Role' })).getByRole('button', { name: /^Show/ }));
    const clear = within(phoneRow()).getByRole('button', { name: 'Clear filters' });
    expect(clear.className).toContain('min-h-11');
    expect(phoneRow().className).toContain('h-11');
    fireEvent.click(clear);
    expect(phoneSearch().value).toBe('ann');
    expect(screen.getByRole('button', { name: 'Role: All Roles' })).toBeInTheDocument();
    expect(within(phoneRow()).queryByRole('button', { name: 'Clear filters' })).toBeNull();
  });

  it('search alone does not show Clear filters; the row still shows', () => {
    renderList();
    fireEvent.change(phoneSearch(), { target: { value: 'ann' } });
    expect(within(phoneRow()).queryByRole('button', { name: 'Clear filters' })).toBeNull();
    expect(phoneRow()).toHaveTextContent(/Showing \d+ of 4 users/);
  });

  it('desktop pieces stay: the Card filters, the plain count line, the action bar Invite', () => {
    renderList();
    expect(document.getElementById('user-search')).not.toBeNull();
    expect(document.getElementById('role-filter')).not.toBeNull();
    const bar = screen.getAllByRole('button', { name: /Invite User/ }).find((b) => !phoneRow().contains(b));
    expect(bar).toBeDefined();
    expect(bar!.closest('.max-md\\:hidden')).not.toBeNull();
    const count = Array.from(document.querySelectorAll('div')).find((d) => d.textContent === 'Showing 4 of 4 users' && d.className.includes('text-gray-500'));
    expect(count?.className).toContain('max-md:hidden');
  });
});
