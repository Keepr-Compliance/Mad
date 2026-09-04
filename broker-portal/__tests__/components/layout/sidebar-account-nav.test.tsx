/**
 * My Account appears in the sidebar for every role — BACKLOG-3078.
 *
 * The nav has two role-gated buckets and neither could host this link:
 * `it_admin` never sees memberNavItems, and a broker never sees adminNavItems,
 * so either home would hide a person's own account page from somebody who owns
 * the data. Enumerated over every role the portal knows rather than sampled —
 * a nav item that appears for three roles out of four is the failure mode.
 */

import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';

jest.mock('next/navigation', () => ({
  usePathname: () => '/dashboard',
}));

import { Sidebar } from '@/components/layout/Sidebar';

const ROLES = ['agent', 'broker', 'admin', 'it_admin'] as const;
const ACCOUNT = 'My Account';
const ACCOUNT_HREF = '/dashboard/account';

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

describe('Sidebar — My Account', () => {
  it.each(ROLES)('is present for %s', (role) => {
    renderSidebar({ role, displayRole: role });
    const link = screen.getByRole('link', { name: ACCOUNT });
    expect(link).toHaveAttribute('href', ACCOUNT_HREF);
  });

  it('is present during a support session', () => {
    // Support reads a customer's account page through impersonation; hiding the
    // link there would remove the only route to it.
    renderSidebar({ isImpersonating: true });
    expect(screen.getByRole('link', { name: ACCOUNT })).toBeInTheDocument();
  });

  it('is present for a signed-in user with no role at all', () => {
    renderSidebar({ role: undefined });
    expect(screen.getByRole('link', { name: ACCOUNT })).toBeInTheDocument();
  });
});

describe('Sidebar — Settings stays admin-only', () => {
  it.each(['admin', 'it_admin'] as const)('is present for %s', (role) => {
    renderSidebar({ role, displayRole: role });
    expect(screen.getByRole('link', { name: 'Settings' })).toBeInTheDocument();
  });

  it.each(['agent', 'broker'] as const)('is absent for %s', (role) => {
    renderSidebar({ role, displayRole: role });
    expect(screen.queryByRole('link', { name: 'Settings' })).not.toBeInTheDocument();
  });

  it('is absent during a support session even for an admin', () => {
    renderSidebar({ role: 'admin', isImpersonating: true });
    expect(screen.queryByRole('link', { name: 'Settings' })).not.toBeInTheDocument();
  });
});
