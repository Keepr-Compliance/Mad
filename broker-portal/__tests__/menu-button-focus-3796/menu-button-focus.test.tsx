/**
 * BACKLOG-3796 — the phone menu buttons show no box after a tap.
 *
 * jsdom loads no CSS, so this asserts the class contract: the ring is
 * keyboard-only (focus-visible) and the hover background applies only on
 * hover-capable devices. A bare focus:ring-2 / hover:bg-gray-800 would paint a
 * box on iOS after a tap or after the drawer moves focus to the close button.
 */
import { render, screen, within } from '@testing-library/react';
import '@testing-library/jest-dom';
import React from 'react';

jest.mock('next/navigation', () => ({
  usePathname: () => '/dashboard',
  useRouter: () => ({ refresh: jest.fn(), push: jest.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));
jest.mock('next/link', () => ({
  __esModule: true,
  default: ({ children, href, ...rest }: { children: React.ReactNode; href: string }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));
jest.mock('@/lib/supabase/client', () => ({
  createClient: () => ({ auth: { signOut: jest.fn() } }),
}));

import { MobileTopBar } from '@/components/layout/MobileTopBar';
import { Sidebar } from '@/components/layout/Sidebar';

const tokens = (el: Element | null) => (el?.getAttribute('class') || '').split(/\s+/).filter(Boolean);

function expectIconOnly(btn: HTMLElement) {
  const t = tokens(btn);
  expect(t).toContain('focus:outline-none');
  expect(t).toContain('focus-visible:ring-2');
  expect(t).toContain('focus-visible:ring-gray-600');
  expect(t).not.toContain('focus:ring-2');
  expect(t).not.toContain('focus:ring-gray-600');
  expect(t).toContain('[@media(hover:hover)]:hover:bg-gray-800');
  expect(t).not.toContain('hover:bg-gray-800');
}

describe('BACKLOG-3796 menu buttons are icon-only on touch', () => {
  it('the open-menu button has a keyboard-only ring and a hover-capable-only hover', () => {
    render(<MobileTopBar menuOpen={false} onOpenMenu={() => {}} />);
    expectIconOnly(screen.getByRole('button', { name: 'Open menu' }));
  });

  it('the drawer close button has a keyboard-only ring and a hover-capable-only hover', () => {
    render(
      <Sidebar
        collapsed={false}
        onToggle={() => {}}
        isImpersonating={false}
        displayEmail="a@example.test"
        mobileOpen
        onMobileClose={() => {}}
      />
    );
    const dialog = screen.getByRole('dialog', { name: 'Main menu' });
    const close = within(dialog).getByRole('button', { name: 'Close menu' });
    expect(close).toHaveFocus(); // programmatic focus move is kept
    expectIconOnly(close);
  });
});
