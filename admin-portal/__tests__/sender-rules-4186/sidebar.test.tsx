// @vitest-environment jsdom

/**
 * BACKLOG-4186 PR C: the sidebar's AI section shows only when report_my_access('sender-rules') is
 * non-null (founder ruling 2026-11-10). The real hook runs against a stubbed browser client; every
 * permission is granted, so the access answer alone decides. Answers are the captured ones
 * (fixtures-pr-c.ts ACCESS).
 */

import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ACCESS } from './fixtures-pr-c';

const state = vi.hoisted(() => ({
  access: null as unknown,
  error: null as unknown,
  pathname: '/dashboard',
  calls: [] as { fn: string; args: unknown }[],
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }),
  usePathname: () => state.pathname,
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('next/link', () => ({
  __esModule: true,
  default: ({ children, href, ...rest }: { children: React.ReactNode; href: string }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));
vi.mock('@/components/providers/AuthProvider', () => ({
  useAuth: () => ({ user: { id: 'user-test', email: 'someone@example.test', user_metadata: {} }, signOut: vi.fn() }),
}));
vi.mock('@/components/providers/PermissionsProvider', () => ({
  usePermissions: () => ({ hasPermission: () => true, roleName: 'Analyst', loading: false }),
}));
vi.mock('@/lib/supabase/client', () => ({
  createClient: () => ({
    rpc: async (fn: string, args?: unknown) => {
      state.calls.push({ fn, args });
      if (fn === 'report_my_access') return { data: state.access, error: state.error };
      return { data: [], error: null };
    },
  }),
}));

import { Sidebar } from '@/components/layout/Sidebar';

const HREF = '/dashboard/ai/sender-rules';

beforeEach(() => {
  state.access = null;
  state.error = null;
  state.pathname = '/dashboard';
  state.calls = [];
});
afterEach(cleanup);

const aside = () => document.querySelector('[data-testid="desktop-sidebar"]') as HTMLElement;
const drawer = () => document.getElementById('mobile-nav') as HTMLElement;
const accessCalls = () => state.calls.filter((c) => c.fn === 'report_my_access');
const aiButton = (scope: HTMLElement) => within(scope).queryAllByRole('button', { name: 'AI' });
const links = (scope: HTMLElement) => within(scope).queryAllByRole('link').filter((a) => a.getAttribute('href') === HREF);

describe('the AI section follows report_my_access(sender-rules)', () => {
  it('asks for the sender-rules key', async () => {
    render(<Sidebar collapsed={false} onToggle={vi.fn()} />);
    await waitFor(() => expect(accessCalls()).toEqual([{ fn: 'report_my_access', args: { p_key: 'sender-rules' } }]));
  });

  it('no grant (null): no AI section in the aside or the drawer', async () => {
    state.access = ACCESS.none;
    render(<Sidebar collapsed={false} onToggle={vi.fn()} mobileOpen onMobileClose={vi.fn()} />);
    await waitFor(() => expect(accessCalls()).toHaveLength(1));
    expect(aiButton(aside())).toHaveLength(0);
    expect(aiButton(drawer())).toHaveLength(0);
    expect(screen.queryAllByRole('link', { name: 'Sender rules' })).toHaveLength(0);
  });

  it('unreadable answer: hidden', async () => {
    state.access = 'owner';
    state.error = { code: 'PGRST202', message: 'Could not find the function' };
    render(<Sidebar collapsed={false} onToggle={vi.fn()} />);
    await waitFor(() => expect(accessCalls()).toHaveLength(1));
    expect(aiButton(aside())).toHaveLength(0);
  });

  it.each([
    ['viewer', ACCESS.viewer],
    ['editor', ACCESS.editor],
    ['owner', ACCESS.owner],
  ])('%s: the section shows; opening it lists Sender rules', async (_n, access) => {
    state.access = access;
    render(<Sidebar collapsed={false} onToggle={vi.fn()} />);
    await waitFor(() => expect(aiButton(aside())).toHaveLength(1));
    expect(links(aside())).toHaveLength(0);
    fireEvent.click(aiButton(aside())[0]);
    expect(links(aside())).toHaveLength(1);
    expect(links(aside())[0].textContent).toBe('Sender rules');
  });

  it('on the page: open and lit, in the aside and the drawer', async () => {
    state.access = ACCESS.viewer;
    state.pathname = HREF;
    render(<Sidebar collapsed={false} onToggle={vi.fn()} mobileOpen onMobileClose={vi.fn()} />);
    await waitFor(() => expect(links(aside())).toHaveLength(1));
    expect(links(drawer())).toHaveLength(1);
    expect((links(aside())[0].getAttribute('class') ?? '').split(/\s+/)).toContain('bg-gray-800');
  });
});
