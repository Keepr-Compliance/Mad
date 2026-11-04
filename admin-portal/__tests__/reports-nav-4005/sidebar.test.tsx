// @vitest-environment jsdom

/**
 * BACKLOG-4005 C4 — the sidebar has ONE Reports entry (no Analytics, no
 * Funnel), it is lit on every /dashboard/reports/* page in the desktop aside,
 * the collapsed aside and the phone drawer, and it is hidden without
 * analytics.view. C6 — the Reports page shows the Analytics card beside the
 * report cards; Paywall Funnel is a registry report (BACKLOG-3722), listed last.
 */

import React from 'react';
import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const nav = vi.hoisted(() => ({ pathname: '/dashboard' }));
const perms = vi.hoisted(() => ({ allow: null as null | Set<string> }));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }),
  usePathname: () => nav.pathname,
  useSearchParams: () => new URLSearchParams(),
  redirect: (to: string) => {
    throw new Error(`redirect:${to}`);
  },
}));
vi.mock('next/link', () => ({
  __esModule: true,
  default: ({ children, href, onClick, ...rest }: { children: React.ReactNode; href: string; onClick?: () => void }) => (
    <a
      href={href}
      {...rest}
      onClick={(e) => {
        e.preventDefault();
        onClick?.();
      }}
    >
      {children}
    </a>
  ),
}));
vi.mock('@/components/providers/AuthProvider', () => ({
  useAuth: () => ({ user: { id: 'u-1', email: 'someone@example.test', user_metadata: { full_name: 'Avery Example' } }, signOut: vi.fn() }),
}));
vi.mock('@/components/providers/PermissionsProvider', () => ({
  usePermissions: () => ({
    hasPermission: (p: string) => (perms.allow ? perms.allow.has(p) : true),
    roleName: 'Admin',
    loading: false,
  }),
}));
// BACKLOG-4091: the Reports page reads the layout cookie; no cookie = Cards.
vi.mock('next/headers', () => ({
  cookies: async () => ({ get: () => undefined }),
}));
vi.mock('@/lib/supabase/server', () => ({
  getAuthenticatedUser: async () => {
    const single = (data: unknown) => ({ select: () => ({ eq: () => ({ single: async () => ({ data, error: null }) }) }) });
    return {
      user: { id: 'u-1' },
      supabase: { rpc: async () => ({ data: true, error: null }), from: () => single({ role_id: 'r1' }) },
    };
  },
}));

import { Sidebar } from '@/components/layout/Sidebar';
import ReportsIndexPage from '@/app/dashboard/reports/page';
import { PERMISSIONS } from '@/lib/permissions';

afterEach(() => {
  cleanup();
  nav.pathname = '/dashboard';
  perms.allow = null;
  document.body.style.overflow = '';
});

const isLit = (el: Element) => (el.getAttribute('class') ?? '').split(/\s+/).includes('bg-gray-800');
const aside = () => document.querySelector('[data-testid="desktop-sidebar"]') as HTMLElement;
const drawer = () => screen.getByRole('dialog', { name: 'Main menu' });
const allHrefs = () => Array.from(document.querySelectorAll('a')).map((a) => a.getAttribute('href') ?? '');

function reportsLink(scope: HTMLElement) {
  return within(scope).getAllByRole('link').filter((a) => a.getAttribute('href') === '/dashboard/reports');
}

describe('C4a one Reports entry, no Analytics or Funnel entry', () => {
  it('aside and drawer each have exactly one Reports link and no old or sub entries', () => {
    nav.pathname = '/dashboard/reports';
    render(<Sidebar collapsed={false} onToggle={vi.fn()} mobileOpen onMobileClose={vi.fn()} />);
    for (const scope of [aside(), drawer()]) {
      expect(reportsLink(scope)).toHaveLength(1);
      expect(within(scope).getByRole('link', { name: 'Reports' }).getAttribute('href')).toBe('/dashboard/reports');
      expect(within(scope).queryByRole('link', { name: 'Funnel' })).toBeNull();
      const hrefs = within(scope).getAllByRole('link').map((a) => a.getAttribute('href') ?? '');
      expect(hrefs.filter((h) => h.startsWith('/dashboard/reports/'))).toEqual([]);
      // BACKLOG-3721: no Analytics link is left at all. Support -> Analytics
      // moved under Reports as the Support SLA report.
      expect(hrefs.filter((h) => /analytics/.test(h))).toEqual([]);
      expect(hrefs).not.toContain('/dashboard/support/analytics');
    }
    for (const h of allHrefs()) {
      expect(h.startsWith('/dashboard/analytics')).toBe(false);
      expect(h.startsWith('/dashboard/funnel')).toBe(false);
    }
  });
});

describe('C4d Support has no Analytics sub-link (BACKLOG-3721)', () => {
  it('with the Support group open, My Tickets is listed and Support -> Analytics is not', () => {
    nav.pathname = '/dashboard/support/my-tickets';
    render(<Sidebar collapsed={false} onToggle={vi.fn()} mobileOpen onMobileClose={vi.fn()} />);
    for (const scope of [aside(), drawer()]) {
      const hrefs = within(scope).getAllByRole('link').map((a) => a.getAttribute('href') ?? '');
      // Positive control: the group is expanded, so its sub-links render.
      expect(hrefs).toContain('/dashboard/support/my-tickets');
      expect(hrefs).not.toContain('/dashboard/support/analytics');
      expect(within(scope).queryByRole('link', { name: 'Analytics' })).toBeNull();
    }
  });
});

describe('C4b Reports is lit on every /dashboard/reports page', () => {
  it.each([
    '/dashboard/reports',
    '/dashboard/reports/analytics',
    '/dashboard/reports/funnel',
    '/dashboard/reports/iphone-sync',
    '/dashboard/reports/submissions',
    '/dashboard/reports/support-sla',
  ])('%s: lit in the aside and the drawer; Dashboard is not', (p) => {
    nav.pathname = p;
    render(<Sidebar collapsed={false} onToggle={vi.fn()} mobileOpen onMobileClose={vi.fn()} />);
    for (const scope of [aside(), drawer()]) {
      expect(isLit(reportsLink(scope)[0])).toBe(true);
      expect(isLit(within(scope).getByRole('link', { name: 'Dashboard' }))).toBe(false);
    }
  });

  it('collapsed aside: Reports is an icon link, lit on a nested page', () => {
    nav.pathname = '/dashboard/reports/funnel';
    render(<Sidebar collapsed onToggle={vi.fn()} />);
    const link = reportsLink(aside());
    expect(link).toHaveLength(1);
    expect(link[0].getAttribute('title')).toBe('Reports');
    expect(isLit(link[0])).toBe(true);
  });

  it('not lit on an unrelated page', () => {
    nav.pathname = '/dashboard/users';
    render(<Sidebar collapsed={false} onToggle={vi.fn()} />);
    expect(isLit(reportsLink(aside())[0])).toBe(false);
  });
});

describe('C4c hidden without analytics.view', () => {
  it('support-only agent sees no Reports link in the aside or the drawer', () => {
    perms.allow = new Set([PERMISSIONS.SUPPORT_VIEW, PERMISSIONS.DASHBOARD_VIEW]);
    nav.pathname = '/dashboard/support';
    render(<Sidebar collapsed={false} onToggle={vi.fn()} mobileOpen onMobileClose={vi.fn()} />);
    expect(reportsLink(aside())).toHaveLength(0);
    expect(reportsLink(drawer())).toHaveLength(0);
    expect(screen.queryAllByRole('link', { name: 'Reports' })).toHaveLength(0);
  });
});

describe('C6 Reports page lists every registry report, Analytics first (BACKLOG-3723), Paywall Funnel among them', () => {
  it('renders every registry report once, in registry order', async () => {
    render(await ReportsIndexPage({ searchParams: Promise.resolve({}) }));
    const hrefs = allHrefs();
    expect(hrefs).toEqual([
      '/dashboard/reports/analytics',
      '/dashboard/reports/iphone-sync',
      '/dashboard/reports/google-messages-sync',
      '/dashboard/reports/submissions',
      '/dashboard/reports/exports',
      '/dashboard/reports/support-sla',
      '/dashboard/reports/user-activity',
      '/dashboard/reports/funnel',
    ]);
    expect(screen.getByRole('heading', { name: 'Analytics' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Paywall Funnel' })).toBeTruthy();
  });
});
