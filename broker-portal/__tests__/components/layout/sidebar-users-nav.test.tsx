/**
 * The "Users" nav link — BACKLOG-3504/3541.
 *
 * Before this split, "Users" and "Org Settings" were one bucket behind a
 * single `showAdminNav` boolean (admin/it_admin only). BACKLOG-3541 widened
 * who may open the Users pages to include `broker`
 * (`lib/users-access.ts`'s `USERS_PAGE_ROLES`); BACKLOG-3504 is the split
 * editor that page now serves. A broker with page access but no sidebar
 * entry has no click path to either — reachable only by typing the URL,
 * which is the exact gap this test file exists to close and hold shut.
 *
 * Org Settings must NOT widen alongside it — that is
 * sidebar-account-nav.test.tsx's job, not repeated here, but the two files
 * are a pair: one proves the grant, the other proves it stopped where it
 * should.
 */

import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';

jest.mock('next/navigation', () => ({
  usePathname: () => '/dashboard',
}));

import { Sidebar } from '@/components/layout/Sidebar';

const USERS = 'Users';
const USERS_HREF = '/dashboard/users';

function renderSidebar(props: Partial<React.ComponentProps<typeof Sidebar>> = {}) {
  return render(
    <Sidebar
      collapsed={false}
      onToggle={() => {}}
      isImpersonating={false}
      displayEmail="member@example.test"
      {...props}
    />
  );
}

describe('Sidebar — Users nav link', () => {
  it.each(['admin', 'it_admin', 'broker'] as const)('is present for %s', (role) => {
    renderSidebar({ role, displayRole: role });
    expect(screen.getByRole('link', { name: USERS })).toHaveAttribute('href', USERS_HREF);
  });

  it('is absent for agent — splits/user-management do not apply to that role', () => {
    renderSidebar({ role: 'agent', displayRole: 'agent' });
    expect(screen.queryByRole('link', { name: USERS })).not.toBeInTheDocument();
  });

  it('is absent for a signed-in user with no role at all', () => {
    renderSidebar({ role: undefined });
    expect(screen.queryByRole('link', { name: USERS })).not.toBeInTheDocument();
  });

  it('is absent during a support session even for an admin — unchanged by this split', () => {
    renderSidebar({ role: 'admin', isImpersonating: true });
    expect(screen.queryByRole('link', { name: USERS })).not.toBeInTheDocument();
  });

  it('is absent during a support session for a broker too', () => {
    renderSidebar({ role: 'broker', isImpersonating: true });
    expect(screen.queryByRole('link', { name: USERS })).not.toBeInTheDocument();
  });
});
