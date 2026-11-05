// @vitest-environment jsdom

/**
 * BACKLOG-4144 G4: the sidebar Reports link shows only when report_list_my_reports is non-empty.
 * The real hook (use-my-reports) runs against a stubbed browser client; analytics.view is granted,
 * so the list alone decides.
 */

import React from 'react';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  list: [] as unknown,
  error: null as unknown,
  calls: [] as string[],
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }),
  usePathname: () => '/dashboard',
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
    rpc: async (fn: string) => {
      state.calls.push(fn);
      return { data: state.list, error: state.error };
    },
  }),
}));

import { Sidebar } from '@/components/layout/Sidebar';

beforeEach(() => {
  state.list = [];
  state.error = null;
  state.calls = [];
});
afterEach(cleanup);

const aside = () => document.querySelector('[data-testid="desktop-sidebar"]') as HTMLElement;
const reportsLinks = () => within(aside()).queryAllByRole('link').filter((a) => a.getAttribute('href') === '/dashboard/reports');

describe('G4 the Reports link follows my report list', () => {
  it('hidden when the list is empty', async () => {
    render(<Sidebar collapsed={false} onToggle={vi.fn()} />);
    await waitFor(() => expect(state.calls).toEqual(['report_list_my_reports']));
    expect(reportsLinks()).toHaveLength(0);
    // Other analytics.view-free links still render: the aside is not empty.
    expect(within(aside()).getByRole('link', { name: 'Dashboard' })).toBeTruthy();
  });

  it('shown when the list has one report', async () => {
    state.list = [{ report_key: 'funnel', access: 'viewer' }];
    render(<Sidebar collapsed={false} onToggle={vi.fn()} />);
    await waitFor(() => expect(reportsLinks()).toHaveLength(1));
    expect(screen.getAllByRole('link', { name: 'Reports' })[0].getAttribute('href')).toBe('/dashboard/reports');
  });

  it('hidden when the list cannot be read', async () => {
    state.list = [{ report_key: 'funnel', access: 'viewer' }];
    state.error = { code: 'PGRST202', message: 'Could not find the function' };
    render(<Sidebar collapsed={false} onToggle={vi.fn()} />);
    await waitFor(() => expect(state.calls).toHaveLength(1));
    expect(reportsLinks()).toHaveLength(0);
  });
});
