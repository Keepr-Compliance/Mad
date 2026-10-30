/**
 * BACKLOG-3853 PR-2B: the Sidebar and the billing capabilities for a suspended
 * BROKERAGE. Presentation and page content only; middleware.test.ts in this
 * folder covers the routes.
 */

import { render } from '@testing-library/react';

jest.mock('next/navigation', () => ({ usePathname: () => '/dashboard/billing' }));

import { Sidebar, type SidebarProps } from '@/components/layout/Sidebar';
import { billingCapabilities } from '@/lib/billing/capabilities';
import type { PortalAccess } from '@/lib/auth/membership';

function nav(props: Partial<SidebarProps>): { hrefs: string[]; note: string | null } {
  const { container, unmount } = render(
    <Sidebar collapsed={false} onToggle={() => {}} isImpersonating={false} displayEmail="member@example.test" {...props} />
  );
  const aside = container.querySelector('[data-testid="desktop-sidebar"]') as HTMLElement;
  const hrefs = Array.from(aside.querySelectorAll('nav a')).map((a) => a.getAttribute('href') as string);
  const note = aside.querySelector('[data-testid="org-suspended-nav-note"]')?.textContent ?? null;
  unmount();
  return { hrefs, note };
}

describe('Sidebar, brokerage suspended', () => {
  it.each(['broker', 'admin', 'it_admin'])('%s with billing on: Billing, Support, My Account + the note', (role) => {
    expect(nav({ role, showBilling: true, showChecklists: true, orgSuspended: true })).toEqual({
      hrefs: ['/dashboard/billing', '/dashboard/support', '/dashboard/account'],
      note: 'Only Billing, Support and My Account are available while your brokerage is suspended.',
    });
  });

  it('billing off: Support, My Account, and the note does not name Billing', () => {
    expect(nav({ role: 'admin', showBilling: false, orgSuspended: true })).toEqual({
      hrefs: ['/dashboard/support', '/dashboard/account'],
      note: 'Only Support and My Account are available while your brokerage is suspended.',
    });
  });

  it('control: the same admin with the brokerage active keeps the admin navigation', () => {
    const { hrefs, note } = nav({ role: 'admin', showBilling: true, showChecklists: true });
    expect(hrefs).toEqual(expect.arrayContaining(['/dashboard/submissions', '/dashboard/users', '/dashboard/checklists']));
    expect(note).toBeNull();
  });

  it('impersonation ignores it', () => {
    expect(nav({ isImpersonating: true, orgSuspended: true }).hrefs).toContain('/dashboard/submissions');
  });
});

describe('billingCapabilities, brokerage suspended', () => {
  const full = (role: string): PortalAccess => ({ kind: 'full', role, organizationId: 'org-1' });
  const base = { isImpersonating: false, enabled: true, agentPlan: 'none' as const, accountSuspended: false };

  it.each(['broker', 'admin', 'it_admin'])('%s: nothing to buy or manage, no primary action, no Users link', (role) => {
    for (const orgBillingSetUp of [true, false]) {
      const caps = billingCapabilities({ ...base, access: full(role), orgBillingSetUp, orgSuspended: true });
      expect(caps).toMatchObject({
        kind: 'organization',
        canPurchase: false,
        canAddSeats: false,
        canManageLicenses: false,
        showManageUsersLink: false,
        primaryAction: null,
      });
    }
  });

  it('control: an active brokerage with billing set up can add seats', () => {
    const caps = billingCapabilities({ ...base, access: full('admin'), orgBillingSetUp: true, orgSuspended: false });
    expect(caps).toMatchObject({ canAddSeats: true, canManageLicenses: true, showManageUsersLink: true, primaryAction: 'add_seats' });
  });
});
