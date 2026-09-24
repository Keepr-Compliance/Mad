/**
 * Checklists sidebar entry — BACKLOG-3474.
 *
 * The layout decides `showChecklists` from lib/checklist-access.ts (proven in
 * dashboard-layout-checklists.test.tsx). This file proves what the Sidebar does
 * with that answer, enumerated over every role rather than sampled:
 *
 *   - present for broker/admin/it_admin when showChecklists is true;
 *   - absent for every role when showChecklists is false;
 *   - absent for every role during impersonation, even when showChecklists is
 *     true — the Sidebar's own guard, which the layout would otherwise mask;
 *   - placed right after Submissions for member-nav roles, and before Users
 *     for it_admin (which never sees the member nav).
 *
 * `agent` with showChecklists=true is not asserted: the gate refuses agent, so
 * the layout cannot produce that input.
 */

import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';

jest.mock('next/navigation', () => ({
  usePathname: () => '/dashboard',
}));

import { Sidebar, insertAfter } from '@/components/layout/Sidebar';

const ALL_ROLES = ['agent', 'broker', 'admin', 'it_admin', undefined] as const;
const EDITOR_ROLES = ['broker', 'admin', 'it_admin'] as const;
const CHECKLISTS = 'Checklists';
const HREF = '/dashboard/checklists';

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

function navLabels(): string[] {
  return screen.getAllByRole('link').map((a) => a.textContent ?? '');
}

describe('Sidebar — Checklists entry present', () => {
  it.each(EDITOR_ROLES)('for %s when showChecklists is true', (role) => {
    renderSidebar({ role, displayRole: role, showChecklists: true });
    const links = screen.getAllByRole('link', { name: CHECKLISTS });
    expect(links).toHaveLength(1);
    expect(links[0]).toHaveAttribute('href', HREF);
  });
});

describe('Sidebar — Checklists entry absent', () => {
  it.each(ALL_ROLES)('for %s when showChecklists is false', (role) => {
    renderSidebar({ role, displayRole: role, showChecklists: false });
    expect(screen.queryByRole('link', { name: CHECKLISTS })).not.toBeInTheDocument();
  });

  it.each(ALL_ROLES)('for %s when showChecklists is omitted', (role) => {
    renderSidebar({ role, displayRole: role });
    expect(screen.queryByRole('link', { name: CHECKLISTS })).not.toBeInTheDocument();
  });

  it.each(ALL_ROLES)(
    'for %s during impersonation, even with showChecklists true',
    (role) => {
      renderSidebar({ role, isImpersonating: true, showChecklists: true });
      // The member nav IS rendered during impersonation — so absence here is
      // the Sidebar's own guard, not a missing bucket.
      expect(screen.getByRole('link', { name: 'Submissions' })).toBeInTheDocument();
      expect(screen.queryByRole('link', { name: CHECKLISTS })).not.toBeInTheDocument();
    }
  );
});

describe('Sidebar — Checklists placement', () => {
  it.each(['broker', 'admin'] as const)('sits right after Submissions for %s', (role) => {
    renderSidebar({ role, displayRole: role, showChecklists: true });
    const labels = navLabels();
    expect(labels.indexOf(CHECKLISTS)).toBe(labels.indexOf('Submissions') + 1);
  });

  it('matches the mock order for admin', () => {
    renderSidebar({ role: 'admin', displayRole: 'admin', showChecklists: true });
    expect(navLabels()).toEqual([
      'Dashboard',
      'Submissions',
      CHECKLISTS,
      'Support',
      'Users',
      'Org Settings',
      'My Account',
      'Sign Out',
    ]);
  });

  it('comes before Users for it_admin, which has no member nav', () => {
    renderSidebar({ role: 'it_admin', displayRole: 'it_admin', showChecklists: true });
    expect(navLabels()).toEqual([CHECKLISTS, 'Users', 'Org Settings', 'My Account', 'Sign Out']);
  });

  it('leaves the member nav untouched when off', () => {
    renderSidebar({ role: 'broker', displayRole: 'broker', showChecklists: false });
    expect(navLabels()).toEqual(['Dashboard', 'Submissions', 'Support', 'My Account', 'Sign Out']);
  });
});

describe('insertAfter', () => {
  const a = { label: 'A', href: '/a', icon: () => null };
  const b = { label: 'B', href: '/b', icon: () => null };
  const x = { label: 'X', href: '/x', icon: () => null };

  it('inserts right after the matching href without mutating the input', () => {
    const items = [a, b];
    expect(insertAfter(items, '/a', x)).toEqual([a, x, b]);
    expect(insertAfter(items, '/b', x)).toEqual([a, b, x]);
    expect(items).toEqual([a, b]);
  });

  it('appends when the href is absent', () => {
    expect(insertAfter([a], '/missing', x)).toEqual([a, x]);
  });
});
