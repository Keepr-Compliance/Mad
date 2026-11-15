// @vitest-environment jsdom

/**
 * BACKLOG-4219 PR3 (A2, A2b): the AI section's two links each follow their OWN key's
 * report_my_access answer; the section shows when at least one is non-null. The real hooks run
 * against a stubbed browser client that answers per p_key. Every permission is granted, so the
 * access answers alone decide.
 *
 * Every absence check first opens the AI group (a click, or a /dashboard/ai path) and asserts the
 * sibling link IS shown in the same render: with the group collapsed no sub-item renders at all,
 * so an absence check there proves nothing (SR step-0 probe P1).
 */

import React from 'react';
import { cleanup, fireEvent, render, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  access: {} as Record<string, unknown>,
  unreadable: [] as string[],
  list: [] as unknown,
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
    rpc: async (fn: string, args?: { p_key?: string }) => {
      state.calls.push({ fn, args });
      if (fn === 'report_my_access') {
        const key = String(args?.p_key);
        if (state.unreadable.includes(key)) return { data: 'owner', error: { code: 'PGRST202', message: 'Could not find the function' } };
        return { data: state.access[key] ?? null, error: null };
      }
      if (fn === 'report_list_my_reports') return { data: state.list, error: null };
      return { data: [], error: null };
    },
  }),
}));

import { Sidebar } from '@/components/layout/Sidebar';

const SR = '/dashboard/ai/sender-rules';
const LP = '/dashboard/ai/learn-pilot';

beforeEach(() => {
  state.access = {};
  state.unreadable = [];
  state.list = [];
  state.pathname = '/dashboard';
  state.calls = [];
});
afterEach(cleanup);

const aside = () => document.querySelector('[data-testid="desktop-sidebar"]') as HTMLElement;
const drawer = () => document.getElementById('mobile-nav') as HTMLElement;
const aiButton = (scope: HTMLElement) => within(scope).queryAllByRole('button', { name: 'AI' });
const linksTo = (scope: HTMLElement, href: string) => within(scope).queryAllByRole('link').filter((a) => a.getAttribute('href') === href);
const accessKeys = () =>
  state.calls.filter((c) => c.fn === 'report_my_access').map((c) => (c.args as { p_key: string }).p_key).sort();

/** Both answers are in (and applied), so a hidden link is hidden by its answer, not by timing. */
async function bothAnswered() {
  await waitFor(() => expect(accessKeys()).toEqual(['learn-pilot', 'sender-rules']));
  await new Promise((r) => setTimeout(r, 20));
}

type Open = 'click' | 'path';
async function renderOpen(open: Open) {
  if (open === 'path') state.pathname = '/dashboard/ai';
  render(<Sidebar collapsed={false} onToggle={vi.fn()} mobileOpen onMobileClose={vi.fn()} />);
  await bothAnswered();
  if (open === 'click') {
    await waitFor(() => expect(aiButton(aside())).toHaveLength(1));
    fireEvent.click(aiButton(aside())[0]);
  }
}

describe('A2 each AI link follows its own key', () => {
  it('asks report_my_access once for each AI key', async () => {
    render(<Sidebar collapsed={false} onToggle={vi.fn()} />);
    await bothAnswered();
    expect(accessKeys()).toEqual(['learn-pilot', 'sender-rules']);
  });

  it.each<Open>(['click', 'path'])('sender-rules only (%s): Sender rules shown, Learn pilot not, aside and drawer', async (open) => {
    state.access = { 'sender-rules': 'viewer' };
    await renderOpen(open);
    for (const scope of [aside(), drawer()]) {
      expect(linksTo(scope, SR)).toHaveLength(1);
      expect(linksTo(scope, LP)).toHaveLength(0);
    }
  });

  it.each<Open>(['click', 'path'])('learn-pilot only (%s): the section shows with Learn pilot only, aside and drawer', async (open) => {
    state.access = { 'learn-pilot': 'viewer' };
    await renderOpen(open);
    for (const scope of [aside(), drawer()]) {
      expect(linksTo(scope, LP)).toHaveLength(1);
      expect(linksTo(scope, LP)[0].textContent).toBe('Learn pilot');
      expect(linksTo(scope, SR)).toHaveLength(0);
    }
  });

  it.each([
    ['viewer', 'owner'],
    ['editor', 'viewer'],
  ])('both (%s / %s): both links', async (sr, lp) => {
    state.access = { 'sender-rules': sr, 'learn-pilot': lp };
    await renderOpen('click');
    for (const scope of [aside(), drawer()]) {
      expect(linksTo(scope, SR)).toHaveLength(1);
      expect(linksTo(scope, LP)).toHaveLength(1);
    }
  });

  it('learn-pilot unreadable, sender-rules granted: Sender rules only', async () => {
    state.access = { 'sender-rules': 'owner' };
    state.unreadable = ['learn-pilot'];
    await renderOpen('path');
    expect(linksTo(aside(), SR)).toHaveLength(1);
    expect(linksTo(aside(), LP)).toHaveLength(0);
  });

  it.each([
    ['neither granted', {}, []],
    ['both unreadable', {}, ['sender-rules', 'learn-pilot']],
  ])('%s: no AI section in the aside or the drawer, even on an AI path', async (_n, access, unreadable) => {
    state.access = access;
    state.unreadable = unreadable as string[];
    state.pathname = LP;
    render(<Sidebar collapsed={false} onToggle={vi.fn()} mobileOpen onMobileClose={vi.fn()} />);
    await bothAnswered();
    expect(aiButton(aside())).toHaveLength(0);
    expect(aiButton(drawer())).toHaveLength(0);
    expect(linksTo(aside(), LP)).toHaveLength(0);
    expect(linksTo(drawer(), SR)).toHaveLength(0);
  });

  it('on the page: open and lit', async () => {
    state.access = { 'learn-pilot': 'viewer' };
    state.pathname = LP;
    render(<Sidebar collapsed={false} onToggle={vi.fn()} />);
    await waitFor(() => expect(linksTo(aside(), LP)).toHaveLength(1));
    expect((linksTo(aside(), LP)[0].getAttribute('class') ?? '').split(/\s+/)).toContain('bg-gray-800');
  });
});

// A2b: learn-pilot is not a Reports-registry key, so a grant on it alone shows no Reports link
// (report_list_my_reports does list the key).
describe('A2b the Reports link ignores a learn-pilot grant', () => {
  const reportsLinks = () => linksTo(aside(), '/dashboard/reports');

  it('learn-pilot only: AI section yes, Reports link no', async () => {
    state.access = { 'learn-pilot': 'viewer' };
    state.list = [{ report_key: 'learn-pilot', access: 'viewer' }];
    render(<Sidebar collapsed={false} onToggle={vi.fn()} />);
    await waitFor(() => expect(aiButton(aside())).toHaveLength(1));
    await waitFor(() => expect(state.calls.some((c) => c.fn === 'report_list_my_reports')).toBe(true));
    await new Promise((r) => setTimeout(r, 20));
    expect(reportsLinks()).toHaveLength(0);
  });

  it('learn-pilot plus funnel: Reports link shown', async () => {
    state.access = { 'learn-pilot': 'viewer' };
    state.list = [
      { report_key: 'funnel', access: 'viewer' },
      { report_key: 'learn-pilot', access: 'viewer' },
    ];
    render(<Sidebar collapsed={false} onToggle={vi.fn()} />);
    await waitFor(() => expect(reportsLinks()).toHaveLength(1));
  });
});
