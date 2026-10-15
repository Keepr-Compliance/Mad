// @vitest-environment jsdom

/**
 * BACKLOG-3841 — admin dashboard shell below md: top bar + drawer.
 *
 * jsdom loads no Tailwind and ignores media queries, so desktop restores are
 * asserted as class tokens and the drawer by DOM structure and behaviour. Real
 * geometry is measured by scripts/phone-layout-3841 (Chromium).
 */

import React from 'react';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';

const nav = vi.hoisted(() => ({ pathname: '/dashboard' }));
const perms = vi.hoisted(() => ({
  loading: false,
  allow: null as null | Set<string>,
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }),
  usePathname: () => nav.pathname,
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('next/link', () => ({
  __esModule: true,
  // A bare anchor; the click is prevented so jsdom does not try to navigate.
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
vi.mock('next/font/google', () => ({ Inter: () => ({ className: 'font-inter' }) }));
vi.mock('@/components/providers/AuthProvider', () => ({
  useAuth: () => ({
    user: { id: 'agent-1', email: 'agent.one@example.test', user_metadata: { full_name: 'Avery Example' } },
    signOut: vi.fn(),
  }),
  AuthProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock('@/components/providers/PermissionsProvider', () => ({
  usePermissions: () => ({
    hasPermission: (p: string) => (perms.allow ? perms.allow.has(p) : true),
    roleName: 'Support Agent',
    loading: perms.loading,
  }),
  PermissionsProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock('@/lib/supabase/client', () => ({ createClient: () => ({ auth: {} }) }));

import DashboardLayout from '@/app/dashboard/layout';
import RootLayout from '@/app/layout';
import LoginPage from '@/app/login/page';
import { Sidebar } from '@/components/layout/Sidebar';
import { PERMISSIONS } from '@/lib/permissions';

afterEach(() => {
  cleanup();
  nav.pathname = '/dashboard';
  perms.loading = false;
  perms.allow = null;
  document.body.style.overflow = '';
});

const tokens = (el: Element | null) => (el?.getAttribute('class') ?? '').split(/\s+/).filter(Boolean);
const desktopAside = () => document.querySelector('[data-testid="desktop-sidebar"]');

function renderLayout() {
  return render(
    <DashboardLayout>
      <p>page body</p>
    </DashboardLayout>
  );
}
function openDrawer() {
  const open = screen.getByRole('button', { name: 'Open menu' });
  open.focus();
  fireEvent.click(open);
  return screen.getByRole('dialog', { name: 'Main menu' });
}

describe('C1 desktop restores (md and up unchanged)', () => {
  it('aside is hidden below md and flex from md; main pads p-4 then md:p-6; top bar md:hidden', () => {
    renderLayout();
    const aside = tokens(desktopAside());
    expect(aside).toEqual(expect.arrayContaining(['hidden', 'md:flex', 'flex-col', 'sticky', 'h-screen', 'w-64']));
    expect(aside).not.toContain('flex');

    const main = tokens(document.querySelector('main'));
    expect(main).toEqual(expect.arrayContaining(['p-4', 'md:p-6', 'flex-1', 'bg-gray-50', 'overflow-auto']));
    expect(main).not.toContain('p-6');

    expect(tokens(screen.getByTestId('mobile-top-bar'))).toContain('md:hidden');
  });
});

describe('C2/C3 drawer exists only while open, outside the aside', () => {
  it('C3: closed drawer is not in the DOM (one link per nav item)', () => {
    renderLayout();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getAllByRole('link', { name: 'Users' })).toHaveLength(1);
    expect(screen.getByRole('button', { name: 'Open menu' }).getAttribute('aria-expanded')).toBe('false');
  });

  it('C2: the open drawer is a dialog that is not inside the desktop aside', () => {
    renderLayout();
    const dialog = openDrawer();
    expect(dialog).toBeTruthy();
    expect(dialog.getAttribute('id')).toBe('mobile-nav');
    expect(desktopAside()).toBeTruthy();
    expect(desktopAside()!.contains(dialog)).toBe(false);
    expect(within(dialog).getByRole('link', { name: 'Users' })).toBeTruthy();
    expect(screen.getAllByRole('link', { name: 'Users' })).toHaveLength(2);
    expect(screen.getByRole('button', { name: 'Open menu' }).getAttribute('aria-expanded')).toBe('true');
  });
});

describe('C4 a collapsed desktop sidebar does not leak into the drawer', () => {
  it('drawer shows labels and its group buttons expand in place without calling onToggle', () => {
    const onToggle = vi.fn();
    render(<Sidebar collapsed onToggle={onToggle} mobileOpen onMobileClose={vi.fn()} />);
    const dialog = screen.getByRole('dialog', { name: 'Main menu' });

    expect(within(dialog).getByRole('link', { name: 'Users' }).textContent).toBe('Users');
    expect(within(dialog).queryByRole('link', { name: 'Queue' })).toBeNull();

    fireEvent.click(within(dialog).getByRole('button', { name: 'Support' }));

    expect(within(dialog).getByRole('link', { name: 'Queue' })).toBeTruthy();
    expect(within(dialog).getByRole('link', { name: 'My Tickets' })).toBeTruthy();
    expect(onToggle).toHaveBeenCalledTimes(0);
    // The collapsed aside still shows icons only.
    expect(desktopAside()!.textContent).not.toContain('Users');
  });
});

describe('C5 the drawer applies the same permission gate as the aside', () => {
  it('support-only agent sees Dashboard, Queue, My Tickets and nothing else', () => {
    nav.pathname = '/dashboard/support';
    perms.allow = new Set([PERMISSIONS.DASHBOARD_VIEW, PERMISSIONS.SUPPORT_VIEW]);
    render(<Sidebar collapsed={false} onToggle={vi.fn()} mobileOpen onMobileClose={vi.fn()} />);
    const d = within(screen.getByRole('dialog', { name: 'Main menu' }));

    // Present first, so the absences below are not vacuous.
    expect(d.getByRole('link', { name: 'Dashboard' })).toBeTruthy();
    expect(d.getByRole('link', { name: 'Queue' })).toBeTruthy();
    expect(d.getByRole('link', { name: 'My Tickets' })).toBeTruthy();

    expect(d.queryByRole('link', { name: 'Users' })).toBeNull();
    expect(d.queryByRole('link', { name: 'Analytics' })).toBeNull();
    expect(d.queryByRole('link', { name: 'Settings' })).toBeNull();
    expect(d.queryByRole('button', { name: 'Projects' })).toBeNull();
    expect(d.queryByRole('button', { name: 'Settings' })).toBeNull();
    expect(d.getAllByRole('link')).toHaveLength(3);
  });
});

describe('C6 every drawer link closes the drawer, including same-pathname Settings tabs', () => {
  it('Audit Log (?tab=audit, pathname unchanged) closes it', () => {
    nav.pathname = '/dashboard/settings';
    renderLayout();
    const dialog = openDrawer();
    // Settings is already expanded on /dashboard/settings: no toggle.
    fireEvent.click(within(dialog).getByRole('link', { name: 'Audit Log' }));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('a main link closes it', () => {
    renderLayout();
    fireEvent.click(within(openDrawer()).getByRole('link', { name: 'Organizations' }));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('the backdrop closes it', () => {
    renderLayout();
    openDrawer();
    fireEvent.click(screen.getByTestId('mobile-nav-overlay').firstElementChild!);
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});

describe('C7 keyboard: focus, Tab wrap, Escape, scroll lock', () => {
  it('focus starts on Close menu, Tab wraps, Escape closes and returns focus to Open menu', () => {
    renderLayout();
    const dialog = openDrawer();
    const close = within(dialog).getByRole('button', { name: 'Close menu' });
    expect(document.activeElement).toBe(close);
    expect(document.body.style.overflow).toBe('hidden');

    const focusables = dialog.querySelectorAll<HTMLElement>('button, a[href]');
    focusables[focusables.length - 1].focus();
    fireEvent.keyDown(document, { key: 'Tab' });
    expect(document.activeElement).toBe(close);

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Open menu' }));
    expect(document.body.style.overflow).toBe('');
  });
});

describe('C7b focus returns to Open menu even when the tap did not focus it (iOS Safari)', () => {
  it('Escape after an unfocused open', () => {
    renderLayout();
    fireEvent.click(screen.getByRole('button', { name: 'Open menu' }));
    expect(screen.getByRole('dialog', { name: 'Main menu' })).toBeTruthy();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Open menu' }));
  });
});

describe('C8 menu buttons: keyboard-only focus ring, hover only on hover-capable devices', () => {
  it('Open menu and Close menu', () => {
    renderLayout();
    const open = screen.getByRole('button', { name: 'Open menu' });
    const close = within(openDrawer()).getByRole('button', { name: 'Close menu' });
    for (const b of [open, close]) {
      const t = tokens(b);
      expect(t).toEqual(
        expect.arrayContaining(['focus:outline-none', 'focus-visible:ring-2', 'focus-visible:ring-gray-600', '[@media(hover:hover)]:hover:bg-gray-800', 'h-11', 'w-11'])
      );
      expect(t).not.toContain('focus:ring-2');
      expect(t).not.toContain('hover:bg-gray-800');
    }
  });
});

describe('C12 one <main> landmark per page', () => {
  it('root layout has none; dashboard layout and login page have exactly one', () => {
    const root = renderToStaticMarkup(
      <RootLayout>
        <p>x</p>
      </RootLayout>
    );
    expect(root).toContain('<body');
    expect(root.match(/<main/g) ?? []).toHaveLength(0);

    renderLayout();
    expect(document.querySelectorAll('main')).toHaveLength(1);
    cleanup();

    const login = renderToStaticMarkup(<LoginPage />);
    expect(login).toContain('Sign in to Keepr');
    expect(login.match(/<main/g) ?? []).toHaveLength(1);
  });
});
