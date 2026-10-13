/**
 * The Sidebar for a suspended account — BACKLOG-3878. Presentation only:
 * middleware and each page refuse the rest (see middleware.test.ts and
 * pages.test.tsx in this folder).
 */

import { render } from '@testing-library/react';

jest.mock('next/navigation', () => ({ usePathname: () => '/dashboard/billing' }));

import { Sidebar, type SidebarProps } from '@/components/layout/Sidebar';

function hrefs(props: Partial<SidebarProps>): string[] {
  const { container, unmount } = render(
    <Sidebar collapsed={false} onToggle={() => {}} isImpersonating={false} displayEmail="member@example.test" {...props} />
  );
  const out = Array.from(container.querySelectorAll('nav a')).map((a) => a.getAttribute('href') as string);
  unmount();
  return out;
}

describe('Sidebar, suspended', () => {
  it('personal owner (billing shown): Billing, Support, My Account only', () => {
    expect(hrefs({ floorOnly: true, role: 'agent', showBilling: true, showChecklists: true, suspended: true })).toEqual([
      '/dashboard/billing',
      '/dashboard/support',
      '/dashboard/account',
    ]);
  });

  it('brokerage admin (no billing): Support, My Account only', () => {
    expect(hrefs({ role: 'admin', showChecklists: true, suspended: true })).toEqual(['/dashboard/support', '/dashboard/account']);
  });

  it('control: the same owner not suspended keeps Dashboard and Checklists', () => {
    expect(hrefs({ floorOnly: true, role: 'agent', showBilling: true, showChecklists: true })).toEqual([
      '/dashboard',
      '/dashboard/support',
      '/dashboard/checklists',
      '/dashboard/billing',
      '/dashboard/account',
    ]);
  });

  it('impersonation ignores the flag (the layout never sets it then)', () => {
    expect(hrefs({ isImpersonating: true, suspended: true })).toEqual([
      '/dashboard',
      '/dashboard/submissions',
      '/dashboard/support',
      '/dashboard/account',
    ]);
  });
});
